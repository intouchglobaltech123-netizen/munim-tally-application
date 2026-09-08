// Package setupui serves the pairing wizard as a local web page.
//
// Why a browser and not a native dialog: the wizard needs a QR code, a live
// list of Tally companies, an OTP field, and checks that re-run while the user
// fixes Tally in another window. That is an afternoon in HTML and a fortnight
// in an installer's scripting language.
//
// Security: the server binds to 127.0.0.1 only and requires a one-time token
// that is generated at launch and passed in the URL. Without it, any web page
// the user has open could POST to localhost and drive the pairing.
package setupui

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"

	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	qrcode "github.com/skip2/go-qrcode"

	"munim/connector/internal/cloud"
	"munim/connector/internal/config"
	"munim/connector/internal/preflight"
	"munim/connector/internal/tally"
)

//go:embed assets/*
var assets embed.FS

// AppDownloadURL is the page the "get the app" QR points at. One URL that
// redirects per platform beats printing two store links on a shop counter.
const AppDownloadURL = "https://munim.app/get"

// PairLinkBase is what the pairing QR encodes. An https link (not a custom
// munim:// scheme) so a phone camera can open it: the app claims the domain and
// takes over when installed, and the web page sends everyone else to the store.
const PairLinkBase = "https://munim.app/p/"

type Server struct {
	cfg         *config.Config
	cloud       *cloud.Client
	log         *slog.Logger
	token       string
	tokenExpiry time.Time

	mu        sync.Mutex
	otpReqID  string
	intentID  string
	session   *cloud.Session
	companies []config.Company
	done      chan struct{}
}

func New(cfg *config.Config, log *slog.Logger) *Server {
	return &Server{
		cfg:         cfg,
		cloud:       cloud.New(cfg.CloudURL),
		log:         log,
		token:       randomToken(),
		tokenExpiry: time.Now().Add(15 * time.Minute),
		done:        make(chan struct{}),
	}
}

// Run starts the wizard, opens the browser, and blocks until setup finishes or
// the context is cancelled.
func (s *Server) Run(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("cannot start setup UI on %s: %w", addr, err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /", s.handleIndex)
	mux.Handle("GET /api/checks", s.guard(s.handleChecks))
	mux.Handle("GET /api/state", s.guard(s.handleState))
	mux.Handle("POST /api/intent", s.guard(s.handleQRIntent))
	mux.Handle("GET /api/intent", s.guard(s.handleQRPoll))
	mux.Handle("GET /api/companies", s.guard(s.handleCompanies))
	mux.Handle("POST /api/finish", s.guard(s.handleFinish))
	mux.HandleFunc("GET /api/qr", s.handleQR)

	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.Serve(ln) }()

	url := fmt.Sprintf("http://%s/?t=%s", ln.Addr().String(), s.token)
	s.log.Info("setup wizard ready", "url", url)
	fmt.Println("\n  Munim setup is open in your browser.")
	fmt.Println("  If it did not open, paste this address:\n\n    " + url + "\n")
	openBrowser(url)

	select {
	case <-ctx.Done():
	case <-s.done:
		// Give the browser a moment to render the success screen.
		time.Sleep(1500 * time.Millisecond)
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}

// guard enforces the one-time token on every API call.
func (s *Server) guard(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Setup-Token")
		if got == "" {
			got = r.URL.Query().Get("t")
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if time.Now().After(s.tokenExpiry) {
			http.Error(w, "Setup token expired. Please restart Munim to generate a new link.", http.StatusForbidden)
			return
		}
		h(w, r)
	})
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	b, err := assets.ReadFile("assets/setup.html")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// The page is served from this binary; no external resources are allowed.
	w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:")
	_, _ = w.Write(b)
}

func (s *Server) handleChecks(w http.ResponseWriter, r *http.Request) {
	o := preflight.DefaultOptions()
	o.CloudURL = s.cfg.CloudURL
	rep := preflight.Run(r.Context(), o)

	// A successful probe tells us where Tally actually is - remember it, since
	// users move the port when 9000 is taken.
	if rep.TallyURL != "" {
		s.cfg.TallyURL = rep.TallyURL
		if rep.TallyVer != "" {
			s.cfg.TallyVersion = rep.TallyVer
		}
	}
	writeJSON(w, rep)
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	writeJSON(w, map[string]any{
		"paired":         s.cfg.Paired(),
		"orgName":        s.cfg.OrgName,
		"phone":          s.cfg.Phone,
		"tallyUrl":       s.cfg.TallyURL,
		"tallyVersion":   s.cfg.TallyVersion,
		"appDownloadURL": AppDownloadURL,
		"loggedIn":       s.session != nil,
	})
}

func (s *Server) handleQRIntent(w http.ResponseWriter, r *http.Request) {
	res, err := s.cloud.CreateIntent(r.Context())
	if err != nil {
		writeAPIErr(w, err)
		return
	}
	s.mu.Lock()
	s.intentID = res.IntentID
	s.mu.Unlock()

	// The QR must encode something a phone camera can act on. A bare intent id
	// is meaningless text; an https link opens the app when installed and the
	// store page when it is not.
	pairURL := res.PairURL
	if pairURL == "" {
		pairURL = PairLinkBase + res.IntentID
	}
	writeJSON(w, map[string]any{
		"intentId": res.IntentID, "pairUrl": pairURL, "ttl": res.TTL,
	})
}

func (s *Server) handleQRPoll(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	intentID := s.intentID
	s.mu.Unlock()

	if intentID == "" {
		writeErr(w, 400, "NO_INTENT", "Request an intent first.")
		return
	}

	res, err := s.cloud.PollIntent(r.Context(), intentID)
	if err != nil {
		writeAPIErr(w, err)
		return
	}

	if res.Expired {
		// Say so explicitly rather than polling a dead intent forever.
		writeJSON(w, map[string]any{"approved": false, "expired": true})
		return
	}
	if !res.Approved {
		writeJSON(w, map[string]any{"approved": false})
		return
	}

	s.mu.Lock()
	s.cfg.DeviceToken = res.DeviceToken
	s.cfg.ConnectorID = res.ConnectorID
	s.cfg.OrgID = res.OrgID
	s.cfg.OrgName = res.OrgName
	s.cfg.PairedAt = time.Now().UTC().Format(time.RFC3339)
	s.cloud.SetDeviceToken(res.DeviceToken)
	orgName := s.cfg.OrgName
	s.mu.Unlock()

	if err := s.cfg.Save(); err != nil {
		writeErr(w, 500, "SAVE_FAILED", err.Error())
		return
	}
	writeJSON(w, map[string]any{
		"approved": true, "orgName": orgName, "approvedBy": res.ApprovedBy,
	})
}

// handleCompanies lists what Tally currently has loaded.
//
// The wizard no longer shows this - the owner does not pick books on the PC.
// It stays because it is the fastest way for support to see what a customer's
// Tally is actually exposing.
func (s *Server) handleCompanies(w http.ResponseWriter, r *http.Request) {
	client := tally.NewClient(s.cfg.TallyURL, tally.Version(s.cfg.TallyVersion))
	found, err := client.Companies(r.Context())
	if err != nil {
		writeErr(w, 502, "TALLY_UNREACHABLE",
			"Could not read companies from Tally. Make sure Tally is open.")
		return
	}

	out := make([]config.Company, 0, len(found))
	for _, c := range found {
		out = append(out, config.Company{
			TallyGUID: c.GUID, Name: c.Name, FyStart: c.FyStart, Enabled: true,
		})
	}
	s.mu.Lock()
	s.companies = out
	s.mu.Unlock()
	writeJSON(w, map[string]any{"companies": out})
}

// handleFinish registers every company Tally has open and ends setup.
//
// The owner does NOT choose companies here. Books found on their own computer
// are their own books; making them tick a box to approve their own data is a
// step that can only fail. Which books sync is settled in the app afterwards,
// and the cloud tells this connector on the next heartbeat.
func (s *Server) handleFinish(w http.ResponseWriter, r *http.Request) {
	client := tally.NewClient(s.cfg.TallyURL, tally.Version(s.cfg.TallyVersion))
	found, err := client.Companies(r.Context())
	if err != nil {
		writeErr(w, 502, "TALLY_UNREACHABLE",
			"Could not read companies from Tally. Make sure Tally is open.")
		return
	}
	if len(found) == 0 {
		writeErr(w, 400, "NO_COMPANY_OPEN",
			"No company is open in Tally. Open your company in Tally, then try again.")
		return
	}

	companies := make([]config.Company, 0, len(found))
	refs := make([]cloud.CompanyRef, 0, len(found))
	for _, c := range found {
		companies = append(companies, config.Company{
			TallyGUID: c.GUID, Name: c.Name, FyStart: c.FyStart, Enabled: true,
		})
		refs = append(refs, cloud.CompanyRef{
			TallyGUID: c.GUID, Name: c.Name, FyStart: c.FyStart, Enabled: true,
		})
	}

	s.mu.Lock()
	s.cfg.Companies = companies
	s.mu.Unlock()

	s.cloud.SetDeviceToken(s.cfg.DeviceToken)
	if err := s.cloud.RegisterCompanies(r.Context(), refs); err != nil {
		// The connector re-registers on its next heartbeat anyway, so a blip
		// here must not block finishing setup.
		s.log.Warn("company registration deferred to heartbeat", "err", err)
	}
	if err := s.cfg.Save(); err != nil {
		writeErr(w, 500, "SAVE_FAILED", err.Error())
		return
	}

	names := make([]string, 0, len(companies))
	for _, c := range companies {
		names = append(names, c.Name)
	}
	writeJSON(w, map[string]any{
		"done": true, "companies": len(companies), "names": names,
	})
	close(s.done)
}

// handleQR renders a QR as PNG. Deliberately unguarded: it leaks nothing on
// its own, and keeping it token-free means an <img> tag needs no extra wiring.
func (s *Server) handleQR(w http.ResponseWriter, r *http.Request) {
	data := r.URL.Query().Get("d")
	if data == "" || len(data) > 512 {
		http.Error(w, "bad data", 400)
		return
	}
	png, err := qrcode.Encode(data, qrcode.Medium, 320)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(png)
}

// --- helpers ---------------------------------------------------------------

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": msg},
	})
}

func writeAPIErr(w http.ResponseWriter, err error) {
	if ae, ok := err.(*cloud.APIError); ok {
		status := ae.Status
		if status == 0 {
			status = 502
		}
		writeErr(w, status, ae.Code, friendlyMessage(ae))
		return
	}
	writeErr(w, 502, "NETWORK", "Could not reach the Munim server. Check your internet and try again.")
}

// friendlyMessage turns machine codes into something a shop owner can act on.
func friendlyMessage(e *cloud.APIError) string {
	switch e.Code {
	case "INVALID_OTP":
		return "That code is not correct. Check the SMS and try again."
	case "OTP_EXPIRED":
		return "That code has expired. Request a new one."
	case "RATE_LIMITED":
		return "Too many attempts. Please wait a few minutes."
	case "SUBSCRIPTION_EXPIRED":
		return "Your Munim subscription has ended. Renew it in the app to continue."
	}
	if e.Message != "" {
		return e.Message
	}
	return "Something went wrong. Please try again."
}

// normalizePhone accepts what users actually type and returns E.164, or "".
func normalizePhone(in string) string {
	var digits strings.Builder
	for _, r := range in {
		if r >= '0' && r <= '9' {
			digits.WriteRune(r)
		}
	}
	d := digits.String()
	switch {
	case len(d) == 10:
		return "+91" + d
	case len(d) == 12 && strings.HasPrefix(d, "91"):
		return "+" + d
	case len(d) == 11 && strings.HasPrefix(d, "0"):
		return "+91" + d[1:]
	}
	return ""
}

func randomToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
