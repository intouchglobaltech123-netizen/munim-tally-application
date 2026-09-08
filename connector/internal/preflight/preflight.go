// Package preflight runs the checks that decide whether this machine can run
// the connector at all.
//
// These run in two places, deliberately:
//   - the installer, as a hard gate before copying any files
//   - the setup wizard, live, so the user can fix a problem and re-check
//     without re-running the installer
//
// Every check returns a Result carrying a human fix, not just a boolean. The
// person reading it is a shop owner, not an administrator.
package preflight

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"munim/connector/internal/tally"
	"time"
)

type Status string

const (
	Pass Status = "pass"
	Warn Status = "warn" // not fatal: install can continue
	Fail Status = "fail" // blocks install
)

// Result is one check outcome.
type Result struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Status  Status `json:"status"`
	Detail  string `json:"detail"`
	Fix     string `json:"fix,omitempty"`     // what the user should do
	HelpURL string `json:"helpUrl,omitempty"` // deep link into support docs
}

// Report is the full set, plus a verdict.
type Report struct {
	OK        bool     `json:"ok"` // no Fail results
	Results   []Result `json:"results"`
	TallyURL  string   `json:"tallyUrl,omitempty"`
	TallyVer  string   `json:"tallyVersion,omitempty"`
	CheckedAt string   `json:"checkedAt"`
}

// Options lets the installer and the wizard point at different endpoints.
type Options struct {
	CloudURL   string // API base to probe for connectivity
	TallyPorts []int  // ports to scan; Tally defaults to 9000
	TallyHost  string // usually localhost
	// TallyURL pins an exact endpoint and skips the scan. Set it when the user
	// passed --tally, or when a paired connector already knows where Tally is
	// (some shops move it off 9000, and support needs to point at another host).
	TallyURL string
	SkipIDs  []string // checks to skip (testing)
}

func DefaultOptions() Options {
	return Options{
		CloudURL:   "https://api.munim.app",
		TallyPorts: []int{9000, 9001, 9002}, // users move it when 9000 is taken
		TallyHost:  "localhost",
	}
}

// Run executes every check. It never returns an error: a check that cannot
// complete is itself a Fail with an explanation.
func Run(ctx context.Context, o Options) Report {
	skip := map[string]bool{}
	for _, id := range o.SkipIDs {
		skip[id] = true
	}

	checks := []func(context.Context, Options) Result{
		checkOS,
		checkDiskSpace,
		checkInternet,
		checkCloudReachable,
	}

	rep := Report{CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	for _, c := range checks {
		r := c(ctx, o)
		if skip[r.ID] {
			continue
		}
		rep.Results = append(rep.Results, r)
	}

	// Tally is two checks with different fixes, so never collapse them into
	// one line. Order matters: the gateway is authoritative. Plenty of Indian
	// SMBs run a portable or copied Tally that leaves no registry entry - if
	// it is answering on port 9000, it is installed, whatever the registry says.
	reach, url, ver := checkTallyGateway(ctx, o)
	inst := checkTallyInstalled(ctx, o)

	if reach.Status == Pass {
		inst.Status = Pass
		if inst.Detail == "" || strings.HasPrefix(inst.Detail, "Tally not found") {
			inst.Detail = "Detected via the Tally connection"
			inst.Fix, inst.HelpURL = "", ""
		}
	} else if inst.Status == Pass {
		// Installed but not answering: the user needs the gateway fix, not the
		// install-Tally fix. Say so plainly.
		reach.Detail = "Tally is installed but not accepting connections"
	}

	if !skip[inst.ID] {
		rep.Results = append(rep.Results, inst)
	}
	if !skip[reach.ID] {
		rep.Results = append(rep.Results, reach)
	}
	rep.TallyURL, rep.TallyVer = url, ver

	if reach.Status == Pass {
		if c := checkCompanyOpen(ctx, url, ver); !skip[c.ID] {
			rep.Results = append(rep.Results, c)
		}
	}

	rep.OK = true
	for _, r := range rep.Results {
		if r.Status == Fail {
			rep.OK = false
		}
	}
	return rep
}

func checkOS(_ context.Context, _ Options) Result {
	r := Result{ID: "os", Label: "Windows version"}
	if runtime.GOOS != "windows" {
		// Developers run this on Linux/macOS against the mock. Not a failure.
		r.Status, r.Detail = Warn, "Running on "+runtime.GOOS+" (development mode)"
		return r
	}
	r.Status, r.Detail = Pass, "Windows "+runtime.GOARCH
	return r
}

// MinFreeBytes is what the connector needs: binary, logs, and the offline
// spool that holds vouchers while the internet is down.
const MinFreeBytes = 500 << 20

func checkDiskSpace(_ context.Context, _ Options) Result {
	r := Result{ID: "disk", Label: "Free disk space"}
	free, err := freeSpace(installRoot())
	if err != nil {
		r.Status, r.Detail = Warn, "Could not read free space: "+err.Error()
		return r
	}
	if free < MinFreeBytes {
		r.Status = Fail
		r.Detail = fmt.Sprintf("Only %s free", humanBytes(free))
		r.Fix = "Free up at least 500 MB and check again."
		return r
	}
	r.Status, r.Detail = Pass, humanBytes(free)+" free"
	return r
}

func checkInternet(ctx context.Context, _ Options) Result {
	r := Result{ID: "internet", Label: "Internet connection"}
	// DNS first: it distinguishes "no network" from "network but our API is
	// down", which need completely different messages.
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	var resolver net.Resolver
	if _, err := resolver.LookupHost(ctx, "cloudflare.com"); err != nil {
		r.Status = Fail
		r.Detail = "No internet connection"
		r.Fix = "Connect this PC to the internet, then check again. The connector needs it to send data to your phone."
		return r
	}
	r.Status, r.Detail = Pass, "Connected"
	return r
}

func checkCloudReachable(ctx context.Context, o Options) Result {
	r := Result{ID: "cloud", Label: "Munim server"}
	if o.CloudURL == "" {
		r.Status, r.Detail = Warn, "No server configured"
		return r
	}
	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(o.CloudURL, "/")+"/v1/health", nil)
	if err != nil {
		r.Status, r.Detail = Fail, err.Error()
		return r
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		r.Status = Fail
		r.Detail = "Cannot reach " + o.CloudURL
		// Antivirus and office firewalls are the usual cause on shop PCs.
		r.Fix = "Allow munim-connector.exe through your firewall or antivirus, then check again."
		r.HelpURL = "https://munim.app/help/firewall"
		return r
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		r.Status, r.Detail = Warn, fmt.Sprintf("Server returned %d", resp.StatusCode)
		r.Fix = "Our server is having trouble. You can finish the install and pair later."
		return r
	}
	r.Status, r.Detail = Pass, "Reachable"
	return r
}

func checkTallyInstalled(_ context.Context, _ Options) Result {
	r := Result{ID: "tally_installed", Label: "Tally installed"}
	path, ver := findTally()
	if path == "" {
		r.Status = Fail
		r.Detail = "Tally not found on this PC"
		r.Fix = "Install TallyPrime or Tally ERP 9 on this computer first. Munim reads your data directly from Tally, so they must be on the same machine."
		r.HelpURL = "https://munim.app/help/tally-not-found"
		return r
	}
	r.Status = Pass
	r.Detail = ver + " at " + path
	return r
}

// checkTallyGateway probes the ports Tally may be listening on and confirms it
// answers XML. A listening port is not enough - something else may hold 9000.
func checkTallyGateway(ctx context.Context, o Options) (Result, string, string) {
	r := Result{ID: "tally_gateway", Label: "Tally connection enabled"}

	// An explicit endpoint wins over the port scan.
	if o.TallyURL != "" {
		ver, err := probeTallyVersion(ctx, o.TallyURL)
		if err == nil {
			r.Status = Pass
			r.Detail = "Connected at " + o.TallyURL
			return r, o.TallyURL, ver
		}
		r.Status = Fail
		r.Detail = "No answer from " + o.TallyURL
		r.Fix = tallyGatewayFix
		r.HelpURL = "https://munim.app/help/enable-tally-server"
		return r, "", ""
	}

	for _, port := range o.TallyPorts {
		addr := net.JoinHostPort(o.TallyHost, strconv.Itoa(port))
		conn, err := net.DialTimeout("tcp", addr, 700*time.Millisecond)
		if err != nil {
			continue
		}
		conn.Close()

		url := fmt.Sprintf("http://%s", addr)
		ver, err := probeTallyVersion(ctx, url)
		if err != nil {
			continue // port open but not Tally
		}
		r.Status = Pass
		r.Detail = "Connected on port " + strconv.Itoa(port)
		return r, url, ver
	}

	r.Status = Fail
	r.Detail = "Tally is not accepting connections"
	// Wording matches Tally's own menu labels so the user can follow it without
	// a screenshot. It says "Enable ODBC", NOT "acts as Server": ODBC is what
	// actually opens this gateway, and on several licences the "acts as"
	// dropdown offers only "None" - telling people to set it to Server sends
	// them looking for an option they do not have.
	r.Fix = tallyGatewayFix
	r.HelpURL = "https://munim.app/help/enable-tally-server"
	return r, "", ""
}

// checkCompanyOpen catches the state where Tally is running and sharing, but
// no company is loaded. Everything else passes and then nothing syncs - so
// this must be its own line with its own fix.
func checkCompanyOpen(ctx context.Context, url, version string) Result {
	r := Result{ID: "tally_company", Label: "Company open in Tally"}

	n, err := countCompanies(ctx, url, version)
	if err != nil {
		r.Status, r.Detail = Warn, "Could not read the company list"
		return r
	}
	if n == 0 {
		r.Status = Fail
		r.Detail = "No company is open in Tally"
		r.Fix = "In Tally, open the company you want to sync (or create one), then check again. Munim can only read a company that is currently open."
		return r
	}
	r.Status = Pass
	r.Detail = fmt.Sprintf("%d open", n)
	return r
}

// countCompanies returns how many companies Tally currently has loaded.
//
// It goes through the same client the sync engine uses, so this check exercises
// the real code path rather than a lookalike. Counting "<COMPANY>" in the raw
// XML does NOT work: when no company is open Tally answers with a <CMPINFO>
// summary that itself contains <COMPANY>0</COMPANY>, which a naive count reads
// as one company.
func countCompanies(ctx context.Context, url string, version string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	client := tally.NewClient(url, tally.Version(version))
	companies, err := client.Companies(ctx)
	if err != nil {
		return 0, err
	}

	// Tally can return placeholder rows with no name. Only a named company is
	// a company we could actually sync.
	n := 0
	for _, c := range companies {
		if strings.TrimSpace(c.Name) != "" {
			n++
		}
	}
	return n, nil
}

// tallyGatewayFix says "Enable ODBC", NOT "acts as Server". ODBC is what
// actually opens this gateway, and on several licences the "TallyPrime acts as"
// dropdown offers only "None" - sending people to look for a Server option they
// do not have is worse than saying nothing.
const tallyGatewayFix = "Open Tally, press F1 > Settings > Connectivity > " +
	"Client/Server configuration. Set \"Enable ODBC\" to Yes and Port to 9000, " +
	"then accept. Keep Tally open and check again."

// probeTallyVersion asks Tally for its companies and infers the product line
// from the response shape. A non-Tally service on the port fails here.
func probeTallyVersion(ctx context.Context, url string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	body := strings.NewReader(`<ENVELOPE><HEADER><VERSION>1</VERSION>` +
		`<TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>` +
		`<ID>ListOfCompanies</ID></HEADER><BODY><DESC><TDL><TDLMESSAGE>` +
		`<COLLECTION NAME="ListOfCompanies" ISINITIALIZE="Yes"><TYPE>Company</TYPE>` +
		`<NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "text/xml")

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	head := strings.ToUpper(string(buf[:n]))
	if !strings.Contains(head, "ENVELOPE") {
		return "", fmt.Errorf("port is open but not Tally")
	}
	return detectVersion(head), nil
}

// JSON renders a report for the installer, which reads it from stdout.
func (r Report) JSON() string {
	b, _ := json.MarshalIndent(r, "", "  ")
	return string(b)
}

// FirstFailure returns the first blocking result, for a one-line message.
func (r Report) FirstFailure() *Result {
	for i := range r.Results {
		if r.Results[i].Status == Fail {
			return &r.Results[i]
		}
	}
	return nil
}

func installRoot() string {
	if runtime.GOOS == "windows" {
		if pf := os.Getenv("ProgramFiles"); pf != "" {
			return pf
		}
		return `C:\`
	}
	return filepath.Dir(os.TempDir())
}

func humanBytes(b uint64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := uint64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}
