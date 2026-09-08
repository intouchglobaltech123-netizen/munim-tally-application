package tally

import (
	"bytes"
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"time"

	"munim/connector/internal/models"
	"munim/connector/internal/sanitize"
)

// Client talks to a Tally installation's HTTP-XML gateway.
//
// The gateway has no authentication, which is precisely why the connector must
// run on the Tally machine and bind to loopback. Never expose port 9000.
type Client struct {
	Endpoint string
	Version  Version
	HTTP     *http.Client
}

// MaxResponseBytes caps a single response. A full-sync collection on a large
// company can be hundreds of MB; without a cap one request can exhaust memory
// on a customer's 4 GB shop PC.
const MaxResponseBytes = 512 << 20

func NewClient(endpoint string, v Version) *Client {
	return &Client{
		Endpoint: endpoint,
		Version:  v,
		// Generous: a full-sync collection on a big company is genuinely slow.
		HTTP: &http.Client{Timeout: 10 * time.Minute},
	}
}

// TallyError means Tally answered, but refused the request. It is distinct
// from a transport error: retrying usually will not help until the user acts
// (loads the company, closes a modal dialog).
type TallyError struct{ Msg string }

func (e *TallyError) Error() string { return "tally: " + e.Msg }

// Post sends one XML envelope and decodes the response.
func (c *Client) Post(ctx context.Context, payload string) (*models.Envelope, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint,
		bytes.NewBufferString(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "text/xml;charset=utf-8")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("tally unreachable at %s: %w", c.Endpoint, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, &TallyError{Msg: fmt.Sprintf("http %d", resp.StatusCode)}
	}

	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("reading tally response: %w", err)
	}

	cleaned := sanitize.Clean(raw)

	var env models.Envelope
	if err := xml.Unmarshal(cleaned, &env); err != nil {
		return nil, fmt.Errorf("parsing tally response (%d bytes): %w", len(cleaned), err)
	}
	if env.LineError != "" {
		return nil, &TallyError{Msg: env.LineError}
	}
	return &env, nil
}

// Companies lists the companies in this Tally installation.
func (c *Client) Companies(ctx context.Context) ([]models.Company, error) {
	env, err := c.Post(ctx, CompaniesRequest(c.Version))
	if err != nil {
		return nil, err
	}
	return env.Collection.Companies, nil
}

// Collection pulls one collection for one company, restricted to records whose
// AlterID is above sinceAlterID. Pass -1 for a full pull.
func (c *Client) Collection(ctx context.Context, collType, company string, sinceAlterID int64) (*models.Envelope, error) {
	return c.Post(ctx, CollectionRequest(c.Version, collType, company, sinceAlterID))
}

// VoucherGUIDs returns GUID+AlterID for one month, for the deletion reconcile.
func (c *Client) VoucherGUIDs(ctx context.Context, company, month string) ([]models.Voucher, error) {
	env, err := c.Post(ctx, ReconcileRequest(c.Version, company, month))
	if err != nil {
		return nil, err
	}
	return env.Collection.Vouchers, nil
}

// Ping reports whether Tally is up and answering.
func (c *Client) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	_, err := c.Companies(ctx)
	return err
}
