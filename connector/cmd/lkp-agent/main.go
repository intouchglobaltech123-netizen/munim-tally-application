// Command lkp-agent is the Munim connector: it reads a Tally installation's
// XML gateway and pushes changes to the Munim cloud.
//
// P0 scope: everything up to the cloud call. The sink is pluggable, so this
// binary already proves the whole read path end to end.
//
//	lkp-agent companies                    list companies in Tally
//	lkp-agent sync                         one incremental pass, print a summary
//	lkp-agent sync --dump out.ndjson       also write the exact ingest payload
//	lkp-agent watch                        run the 30s loop
//	lkp-agent reset                        clear cursors, force a full resync
//
// It is read-only into Tally. There is deliberately no code path that writes.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"munim/connector/internal/cloud"
	"munim/connector/internal/config"
	"munim/connector/internal/sync"
	"munim/connector/internal/tally"
)

type opts struct {
	endpoint string
	version  string
	state    string
	company  string
	dump     string
	interval time.Duration
	verbose  bool
	jsonOut  bool

	// Explicit flags win over the saved config, so a support engineer can
	// always point a paired connector at a different Tally to debug.
	explicitTally    bool
	explicitState    bool
	explicitInterval bool
}

func main() {
	var cfg opts
	fs := flag.NewFlagSet("lkp-agent", flag.ExitOnError)
	fs.StringVar(&cfg.endpoint, "tally", envOr("MUNIM_TALLY", "http://localhost:9000"), "Tally XML gateway URL")
	fs.StringVar(&cfg.version, "tally-version", envOr("MUNIM_TALLY_VERSION", "prime"), "prime | erp9")
	fs.StringVar(&cfg.state, "state", envOr("MUNIM_STATE", "munim-cursors.json"), "cursor state file")
	fs.StringVar(&cfg.company, "company", "", "sync only this company (default: all)")
	fs.StringVar(&cfg.dump, "dump", "", "also write the ingest NDJSON payload to this file")
	fs.DurationVar(&cfg.interval, "interval", 30*time.Second, "poll interval for watch")
	fs.BoolVar(&cfg.verbose, "v", false, "verbose logging")
	fs.BoolVar(&cfg.jsonOut, "json", false, "machine-readable output (used by the installer)")

	fsSeen := map[string]bool{}

	cmd := "firstrun" // double-clicked: guide the user through setup
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		cmd = os.Args[1]
		_ = fs.Parse(os.Args[2:])
	} else {
		_ = fs.Parse(os.Args[1:])
	}

	fs.Visit(func(f *flag.Flag) { fsSeen[f.Name] = true })
	cfg.explicitTally = fsSeen["tally"] || fsSeen["tally-version"]
	cfg.explicitState = fsSeen["state"]
	cfg.explicitInterval = fsSeen["interval"]

	level := slog.LevelInfo
	if cfg.verbose {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, cmd, cfg, log); err != nil {
		log.Error("failed", "cmd", cmd, "err", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, cmd string, cfg opts, log *slog.Logger) error {
	// A paired machine takes its endpoints from the saved config, not from
	// flag defaults - the user may have Tally on a non-standard port, and the
	// Windows service starts with no arguments at all.
	saved, err := config.Load()
	if err != nil {
		return fmt.Errorf("loading config: %w", err)
	}
	if saved.Paired() {
		if !cfg.explicitTally {
			cfg.endpoint = saved.TallyURL
			cfg.version = saved.TallyVersion
		}
		if !cfg.explicitState {
			cfg.state = config.StatePath()
		}
		if saved.IntervalSecs > 0 && !cfg.explicitInterval {
			cfg.interval = time.Duration(saved.IntervalSecs) * time.Second
		}
	}

	client := tally.NewClient(cfg.endpoint, tally.Version(cfg.version))
	store, err := sync.NewStore(cfg.state)
	if err != nil {
		return fmt.Errorf("opening state: %w", err)
	}

	switch cmd {
	case "companies":
		return listCompanies(ctx, client)
	case "reset":
		return resetCursors(store, log)
	case "sync":
		_, err := syncOnce(ctx, client, store, cfg, saved, log)
		return err
	case "watch":
		return watch(ctx, client, store, cfg, saved, log)
	case "firstrun":
		return runFirstRun(ctx, log)
	case "setup":
		return runSetup(ctx, log)
	case "install-service":
		// The elevated copy of ourselves, launched by the first-run flow.
		return installAndStartService(log)
	case "check":
		explicit := ""
		if cfg.explicitTally {
			explicit = cfg.endpoint
		} else if saved.Paired() && saved.TallyURL != "" {
			explicit = saved.TallyURL
		}
		return runCheck(ctx, *saved, cfg.jsonOut, explicit)
	case "service", "install", "uninstall", "start", "stop":
		return runService(cmd, cfg, log)
	default:
		return fmt.Errorf("unknown command %q\n  setup | check | companies | sync | watch | reset | install", cmd)
	}
}

func listCompanies(ctx context.Context, c *tally.Client) error {
	companies, err := c.Companies(ctx)
	if err != nil {
		return err
	}
	if len(companies) == 0 {
		fmt.Println("No companies loaded in Tally.")
		return nil
	}
	fmt.Printf("%-36s  %-30s  %s\n", "GUID", "NAME", "FY START")
	for _, co := range companies {
		fmt.Printf("%-36s  %-30s  %s\n", co.GUID, co.Name, co.FyStart)
	}
	return nil
}

func resetCursors(store *sync.Store, log *slog.Logger) error {
	for _, c := range store.All() {
		log.Info("cursor cleared", "company", c.CompanyName,
			"wasMaster", c.MasterAlter, "wasVoucher", c.VoucherAlter)
		c.MasterAlter, c.VoucherAlter = 0, 0
	}
	return store.Save()
}

func syncOnce(ctx context.Context, client *tally.Client, store *sync.Store, cfg opts, saved *config.Config, log *slog.Logger) (*sync.SummarySink, error) {
	companies, err := client.Companies(ctx)
	if err != nil {
		return nil, err
	}

	summary := sync.NewSummarySink()
	sinks := []sync.Sink{summary}

	// Once paired, the cloud is the real destination. Before pairing the same
	// engine runs against the summary sink alone, which is how P0 was verified.
	if saved.Paired() {
		api := cloud.New(saved.CloudURL)
		api.SetDeviceToken(saved.DeviceToken)
		sinks = append(sinks, api)
	}

	if cfg.dump != "" {
		f, err := os.Create(cfg.dump)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		sinks = append(sinks, sync.NewNDJSONSink(f))
	}

	engine := &sync.Engine{
		Client: client, Store: store, Sink: sync.TeeSink{Sinks: sinks}, Log: log,
	}

	// Re-register on every pass. Without this a company created after setup is
	// never named in the cloud, and its dashboard shows a raw Tally GUID.
	if saved.Paired() {
		api := cloud.New(saved.CloudURL)
		api.SetDeviceToken(saved.DeviceToken)
		refs := make([]cloud.CompanyRef, 0, len(companies))
		for _, co := range companies {
			refs = append(refs, cloud.CompanyRef{
				TallyGUID: co.GUID, Name: co.Name, FyStart: co.FyStart, Enabled: true,
			})
		}
		if err := api.RegisterCompanies(ctx, refs); err != nil {
			log.Debug("company registration deferred", "err", err)
		}
	}

	for _, co := range companies {
		if cfg.company != "" && !strings.EqualFold(co.Name, cfg.company) && co.GUID != cfg.company {
			continue
		}
		// Never sync a company the owner did not choose in setup.
		if !companyEnabled(saved, co.GUID) {
			log.Debug("skipping company not selected during setup", "company", co.Name)
			continue
		}
		st, err := engine.SyncCompany(ctx, co.GUID, co.Name)
		switch {
		case errors.Is(err, sync.ErrAlterIDRegression):
			// The book was restored or rewritten. Recover automatically.
			log.Warn("AlterID regression - forcing full resync", "company", co.Name)
			if err := engine.ResetCompany(co.GUID); err != nil {
				return summary, err
			}
			if st, err = engine.SyncCompany(ctx, co.GUID, co.Name); err != nil {
				return summary, err
			}
		case err != nil:
			var te *tally.TallyError
			if errors.As(err, &te) {
				// Tally answered but refused: user action needed, not a retry.
				log.Error("tally refused the request", "company", co.Name, "reason", te.Msg)
				continue
			}
			return summary, err
		}
		report(st)
	}

	printSummary(summary)
	return summary, nil
}

// runWatch builds its own client and store, for callers (the Windows service)
// that do not go through run().
func runWatch(ctx context.Context, cfg opts, log *slog.Logger) error {
	client := tally.NewClient(cfg.endpoint, tally.Version(cfg.version))
	store, err := sync.NewStore(cfg.state)
	if err != nil {
		return err
	}
	saved, err := config.Load()
	if err != nil {
		return err
	}
	return watch(ctx, client, store, cfg, saved, log)
}

func watch(ctx context.Context, client *tally.Client, store *sync.Store, cfg opts, saved *config.Config, log *slog.Logger) error {
	log.Info("watching Tally", "endpoint", cfg.endpoint, "interval", cfg.interval)
	backoff := cfg.interval

	for {
		err := func() error {
			_, err := syncOnce(ctx, client, store, cfg, saved, log)
			return err
		}()
		beat(ctx, saved, err, log)
		if err != nil {
			// Tally closed or the machine is offline: back off, never spin.
			backoff = min(backoff*2, 30*time.Minute)
			log.Warn("sync failed, backing off", "err", err, "retryIn", backoff)
		} else {
			backoff = cfg.interval
		}

		select {
		case <-ctx.Done():
			log.Info("shutting down")
			return nil
		case <-time.After(backoff):
		}
	}
}

// companyEnabled reports whether this company was selected during setup.
// An unpaired connector syncs everything, which is what the P0 CLI demo does.
func companyEnabled(saved *config.Config, guid string) bool {
	if !saved.Paired() || len(saved.Companies) == 0 {
		return true
	}
	for _, c := range saved.Companies {
		if c.TallyGUID == guid {
			return c.Enabled
		}
	}
	// A company added in Tally after setup: sync it rather than silently
	// ignoring it, and let the owner turn it off in the app.
	return true
}

// beat reports health to the cloud and executes any command it sends back.
// This is the only inbound control path - a shop PC has no reachable port.
func beat(ctx context.Context, saved *config.Config, syncErr error, log *slog.Logger) {
	if !saved.Paired() {
		return
	}
	api := cloud.New(saved.CloudURL)
	api.SetDeviceToken(saved.DeviceToken)

	status, lastErr := "ok", ""
	if syncErr != nil {
		status, lastErr = "error", syncErr.Error()
	}
	res, err := api.Heartbeat(ctx, status, syncErr == nil, lastErr)
	if err != nil {
		log.Debug("heartbeat failed", "err", err)
		return
	}
	for _, c := range res.Commands {
		log.Info("command from server", "type", c.Type, "company", c.CompanyID)
	}

	// The owner decides in the app which books sync; this connector obeys.
	// Applying it here - not at setup time - means they can change their mind
	// from their phone without ever touching the shop computer again.
	if applyCompanySettings(saved, res.Companies, log) {
		if err := saved.Save(); err != nil {
			log.Warn("could not persist company settings", "err", err)
		}
	}
}

// applyCompanySettings folds the cloud's answer into local config.
// Returns whether anything actually changed.
func applyCompanySettings(saved *config.Config, settings []cloud.CompanySetting, log *slog.Logger) bool {
	if len(settings) == 0 {
		return false
	}
	want := make(map[string]bool, len(settings))
	for _, s := range settings {
		want[s.TallyGUID] = s.Enabled
	}

	changed := false
	for i := range saved.Companies {
		c := &saved.Companies[i]
		enabled, known := want[c.TallyGUID]
		if !known || c.Enabled == enabled {
			continue
		}
		log.Info("company sync setting changed from the app",
			"company", c.Name, "enabled", enabled)
		c.Enabled = enabled
		changed = true
	}
	return changed
}

func report(st *sync.Stats) {
	if st.Masters == 0 && st.Vouchers == 0 {
		fmt.Printf("  %-28s  no changes\n", st.Company)
		return
	}
	fmt.Printf("  %-28s  masters=%-5d vouchers=%-6d batches=%-3d alterId %d->%d  %s\n",
		st.Company, st.Masters, st.Vouchers, st.Batches,
		st.FromVoucher, st.ToVoucher, st.Duration.Round(time.Millisecond))
}

func printSummary(s *sync.SummarySink) {
	if s.Records == 0 {
		return
	}
	fmt.Println()
	fmt.Println("  DASHBOARD PREVIEW (computed from the synced records)")
	fmt.Println("  " + strings.Repeat("-", 52))
	fmt.Printf("  %-22s %s\n", "Sales", inr(s.SalesPaise))
	fmt.Printf("  %-22s %s\n", "Purchases", inr(s.PurchPaise))
	fmt.Printf("  %-22s %s\n", "Receivables", inr(s.Receivable))
	fmt.Printf("  %-22s %s\n", "Payables", inr(s.Payable))
	fmt.Printf("  %-22s %s\n", "Cash + Bank", inr(s.CashPaise))
	fmt.Printf("  %-22s %d ledgers, %d vouchers, %d bills\n",
		"Synced", s.Ledgers, s.Vouchers, s.OpenBills)

	if items := s.TopItems(5); len(items) > 0 {
		fmt.Println("\n  Top selling items")
		for i, it := range items {
			fmt.Printf("   %d. %-24s %s\n", i+1, truncate(it.Name, 24), inr(it.Paise))
		}
	}
	if parties := s.TopDebtors(5); len(parties) > 0 {
		fmt.Println("\n  Highest outstanding")
		for i, p := range parties {
			fmt.Printf("   %d. %-24s %s\n", i+1, truncate(p.Name, 24), inr(p.Paise))
		}
	}
	fmt.Println()
}

// inr formats paise with Indian digit grouping: 2,54,80,000.00
func inr(paise int64) string {
	neg := paise < 0
	if neg {
		paise = -paise
	}
	whole := fmt.Sprintf("%d", paise/100)
	frac := fmt.Sprintf("%02d", paise%100)

	var grouped string
	if len(whole) <= 3 {
		grouped = whole
	} else {
		head, tail := whole[:len(whole)-3], whole[len(whole)-3:]
		var parts []string
		for len(head) > 2 {
			parts = append([]string{head[len(head)-2:]}, parts...)
			head = head[:len(head)-2]
		}
		if head != "" {
			parts = append([]string{head}, parts...)
		}
		grouped = strings.Join(parts, ",") + "," + tail
	}

	sign := ""
	if neg {
		sign = "-"
	}
	return sign + "Rs " + grouped + "." + frac
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "."
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
