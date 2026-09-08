// Package cloud is the connector's client for the Munim API.
//
// Two credentials live here and must never be confused:
//   - a short-lived USER token, held only during setup, proving the person at
//     the keyboard owns the account
//   - a long-lived DEVICE token, stored on disk, scoped to ingest+heartbeat only
//
// The device token can never read reports; the user token can never write to
// ingest. Keeping them separate is what limits the blast radius if a shop PC
// is compromised.
package cloud

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"munim/connector/internal/models"
)

type Client struct {
	BaseURL     string
	HTTP        *http.Client
	userToken   string
	deviceToken string
	AppVersion  string
}

func New(baseURL string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		HTTP:       &http.Client{Timeout: 60 * time.Second},
		AppVersion: "0.1.0",
	}
}

func (c *Client) SetUserToken(t string)   { c.userToken = t }
func (c *Client) SetDeviceToken(t string) { c.deviceToken = t }
func (c *Client) HasDeviceToken() bool    { return c.deviceToken != "" }

// APIError carries the server's stable machine code. Never branch on message
// text - it is written for humans and will change.
type APIError struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *APIError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("%s: %s", e.Code, e.Message)
	}
	return e.Code
}

func (c *Client) do(ctx context.Context, method, path string, body, out any, token string) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "munim-connector/"+c.AppVersion)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach Munim server: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode >= 400 {
		var wrap struct {
			Error APIError `json:"error"`
		}
		_ = json.Unmarshal(raw, &wrap)
		wrap.Error.Status = resp.StatusCode
		if wrap.Error.Code == "" {
			wrap.Error.Code = fmt.Sprintf("HTTP_%d", resp.StatusCode)
		}
		return &wrap.Error
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// --- setup-time calls (user token) -----------------------------------------

// IntentResponse starts a QR pairing. The PC never sees the user's phone
// number or password: it shows a code, the already-signed-in mobile app
// approves it, and the device token comes back over this channel.
type IntentResponse struct {
	IntentID string `json:"intentId"`
	PairURL  string `json:"pairUrl"` // what the QR actually encodes
	TTL      int    `json:"ttl"`
}

type PollResponse struct {
	Approved    bool   `json:"approved"`
	Expired     bool   `json:"expired"`
	DeviceToken string `json:"deviceToken"`
	ConnectorID string `json:"connectorId"`
	OrgID       string `json:"orgId"`
	OrgName     string `json:"orgName"`
	ApprovedBy  string `json:"approvedBy"`
}

func (c *Client) CreateIntent(ctx context.Context) (*IntentResponse, error) {
	var out IntentResponse
	err := c.do(ctx, http.MethodPost, "/v1/auth/intent", nil, &out, "")
	return &out, err
}

func (c *Client) PollIntent(ctx context.Context, intentID string) (*PollResponse, error) {
	var out PollResponse
	err := c.do(ctx, http.MethodGet, "/v1/auth/intent?id="+intentID, nil, &out, "")
	return &out, err
}

type OTPRequest struct {
	RequestID string `json:"requestId"`
	TTL       int    `json:"ttl"`
}

// RequestOTP starts phone login. The phone number is the account identity -
// shop owners will not manage passwords.
func (c *Client) RequestOTP(ctx context.Context, phone string) (*OTPRequest, error) {
	var out OTPRequest
	err := c.do(ctx, http.MethodPost, "/v1/auth/otp/request",
		map[string]string{"phone": phone}, &out, "")
	return &out, err
}

type Session struct {
	Access  string `json:"access"`
	Refresh string `json:"refresh"`
	User    struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Role string `json:"role"`
	} `json:"user"`
	Org struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"org"`
}

func (c *Client) VerifyOTP(ctx context.Context, requestID, otp string) (*Session, error) {
	var out Session
	err := c.do(ctx, http.MethodPost, "/v1/auth/otp/verify",
		map[string]string{"requestId": requestID, "otp": otp}, &out, "")
	if err == nil {
		c.userToken = out.Access
	}
	return &out, err
}

type PairResult struct {
	ConnectorID string `json:"connectorId"`
	DeviceToken string `json:"deviceToken"` // returned exactly once
	OrgID       string `json:"orgId"`
}

// Pair exchanges the user session for a device token scoped to this machine.
func (c *Client) Pair(ctx context.Context, machine, tallyVersion string) (*PairResult, error) {
	var out PairResult
	err := c.do(ctx, http.MethodPost, "/v1/connectors/pair", map[string]string{
		"machineName":  machine,
		"os":           "windows",
		"tallyVersion": tallyVersion,
		"appVersion":   c.AppVersion,
	}, &out, c.userToken)
	if err == nil {
		c.deviceToken = out.DeviceToken
	}
	return &out, err
}

// RegisterCompanies tells the cloud which Tally companies this connector will
// sync. The owner chooses; we never sync a company they did not pick.
func (c *Client) RegisterCompanies(ctx context.Context, companies []CompanyRef) error {
	return c.do(ctx, http.MethodPost, "/v1/connectors/companies/discover",
		map[string]any{"companies": companies}, nil, c.deviceToken)
}

type CompanyRef struct {
	TallyGUID string `json:"tallyGuid"`
	Name      string `json:"name"`
	FyStart   string `json:"fyStart,omitempty"`
	Enabled   bool   `json:"enabled"`
}

// --- runtime calls (device token) ------------------------------------------

// CompanySetting is the cloud's answer to "which books should I sync?".
// The owner controls this from their phone; the PC only obeys.
type CompanySetting struct {
	TallyGUID string `json:"tallyGuid"`
	Enabled   bool   `json:"enabled"`
}

type Command struct {
	Type      string `json:"type"` // full_resync | update | pause
	CompanyID string `json:"companyId,omitempty"`
	URL       string `json:"url,omitempty"`
}

// Heartbeat reports health and collects server-issued commands. This is how we
// trigger a resync on a customer PC we can never reach directly - there is no
// inbound path through a shop's router.
func (c *Client) Heartbeat(ctx context.Context, status string, tallyUp bool, lastErr string) (*HeartbeatResult, error) {
	var out HeartbeatResult
	err := c.do(ctx, http.MethodPost, "/v1/connectors/heartbeat", map[string]any{
		"status":     status,
		"tallyUp":    tallyUp,
		"appVersion": c.AppVersion,
		"lastError":  lastErr,
	}, &out, c.deviceToken)
	return &out, err
}

type HeartbeatResult struct {
	Commands  []Command        `json:"commands"`
	Companies []CompanySetting `json:"companies"`
}

type IngestResult struct {
	Accepted int `json:"accepted"`
	Rejected int `json:"rejected"`
	Cursors  struct {
		Master  int64 `json:"master"`
		Voucher int64 `json:"voucher"`
	} `json:"cursors"`
}

// Ingest sends one batch as gzipped NDJSON. It satisfies sync.Sink, so the
// engine is unchanged between "print to stdout" and "push to cloud".
func (c *Client) Send(ctx context.Context, batch []models.Record) error {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	enc := json.NewEncoder(zw)
	for _, r := range batch {
		if err := enc.Encode(r); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/v1/ingest", &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-ndjson")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Authorization", "Bearer "+c.deviceToken)
	// Retries of the same batch must not double-write on the server.
	req.Header.Set("Idempotency-Key", batchKey(batch))

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
		return &APIError{Status: resp.StatusCode, Code: fmt.Sprintf("HTTP_%d", resp.StatusCode), Message: string(raw)}
	}
	return nil
}

// batchKey derives a stable idempotency key from the batch contents, so a
// retry after a timeout carries the same key the first attempt did.
//
// This key is NOT globally unique - two businesses can produce identical
// batches. The server scopes it by tenant before use; it must never be
// treated as unique on its own.
func batchKey(batch []models.Record) string {
	if len(batch) == 0 {
		return "empty"
	}
	first, last := batch[0], batch[len(batch)-1]
	return fmt.Sprintf("%s-%s-%d-%d-%d",
		first.CompanyGUID, first.Kind, first.AlterID, last.AlterID, len(batch))
}
