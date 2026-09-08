package main

import (
	"context"
	"fmt"
	"log/slog"

	"munim/connector/internal/config"
	"munim/connector/internal/preflight"
	"munim/connector/internal/setupui"
)

// SetupAddr is where the pairing wizard listens. Loopback only - this port
// must never be reachable from the shop's network.
const SetupAddr = "127.0.0.1:9111"

// runSetup opens the pairing wizard in the user's browser. The installer calls
// this as its final step; the user can also re-run it later from the Start
// menu to add a company or re-pair.
func runSetup(ctx context.Context, log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	return setupui.New(cfg, log).Run(ctx, SetupAddr)
}

// runCheck prints the preflight report. The installer runs this BEFORE copying
// any files and refuses to continue on a failure, so a shop owner never ends
// up with an installed connector that cannot work.
//
//	munim-connector.exe check           human-readable, exit 1 on failure
//	munim-connector.exe check --json    machine-readable for the installer
func runCheck(ctx context.Context, cfg config.Config, asJSON bool, tallyURL string) error {
	o := preflight.DefaultOptions()
	if cfg.CloudURL != "" {
		o.CloudURL = cfg.CloudURL
	}
	// Honour an explicit --tally. Without this, `check` scanned localhost while
	// the rest of the connector talked to the endpoint the user actually gave -
	// so the checks and the sync could disagree about whether Tally is there.
	if tallyURL != "" {
		o.TallyURL = tallyURL
	}
	rep := preflight.Run(ctx, o)

	if asJSON {
		fmt.Println(rep.JSON())
	} else {
		for _, r := range rep.Results {
			mark := map[preflight.Status]string{
				preflight.Pass: "  OK  ", preflight.Warn: " WARN ", preflight.Fail: " FAIL ",
			}[r.Status]
			fmt.Printf("[%s] %-26s %s\n", mark, r.Label, r.Detail)
			if r.Fix != "" {
				fmt.Printf("         -> %s\n", r.Fix)
			}
		}
	}
	if f := rep.FirstFailure(); f != nil {
		return fmt.Errorf("%s: %s", f.Label, f.Detail)
	}
	return nil
}
