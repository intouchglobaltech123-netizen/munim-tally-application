package main

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"strings"
	"time"

	"munim/connector/internal/config"
	"munim/connector/internal/preflight"
)

// runFirstRun is what happens when a customer double-clicks munim-connector.exe.
//
// There is no separate installer. That is deliberate: Windows Smart App Control
// blocks unsigned Inno Setup stubs outright (installer patterns have poor
// reputation because malware abuses them), while it allows this plain binary
// through. Shipping one .exe removes the blocked artifact entirely - and costs
// nothing, which matters before there is revenue to buy a certificate.
//
// The flow is the same as a normal installer, just hosted in the program:
//
//	check the machine -> install the service (UAC) -> open the pairing wizard
func runFirstRun(ctx context.Context, log *slog.Logger) error {
	banner()

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// Already set up? Then a double-click means "show me how it is doing".
	if cfg.Paired() {
		return showStatus(ctx, cfg)
	}
	if demoMode() {
		fmt.Println("  DEMO MODE - using the mock Tally and mock cloud.")
		fmt.Println("  Nothing on this computer will be changed.")
		fmt.Println()
	}

	fmt.Println("  Step 1 of 3   Checking this computer")
	fmt.Println("  " + strings.Repeat("-", 58))

	o := preflight.DefaultOptions()
	if cfg.CloudURL != "" {
		o.CloudURL = cfg.CloudURL
	}
	rep := preflight.Run(ctx, o)
	printReport(rep)

	if f := rep.FirstFailure(); f != nil {
		fmt.Println()
		fmt.Println("  Munim cannot start yet. Fix the item above, then run this again.")
		if f.HelpURL != "" {
			fmt.Println("  Help: " + f.HelpURL)
		}
		pause()
		return fmt.Errorf("%s: %s", f.Label, f.Detail)
	}
	if rep.TallyURL != "" {
		cfg.TallyURL = rep.TallyURL
		if rep.TallyVer != "" {
			cfg.TallyVersion = rep.TallyVer
		}
		_ = cfg.Save()
	}

	fmt.Println("\n  Step 2 of 3   Installing Munim to run in the background")
	fmt.Println("  " + strings.Repeat("-", 58))
	if demoMode() {
		// Demos and support calls must not leave a service behind on someone
		// else's machine, and a service started here would read the real
		// ProgramData config rather than the demo one.
		fmt.Println("  Skipped (demo mode). Munim will sync while this window is open.")
	} else if err := ensureService(log); err != nil {
		// A failed service install is not fatal: the user can still pair and
		// run `watch` manually. Say so rather than dead-ending them.
		fmt.Println("  Could not install the background service:")
		fmt.Println("    " + err.Error())
		fmt.Println("  You can still continue. Munim will sync while this window is open.")
	}

	fmt.Println("\n  Step 3 of 3   Connecting to your mobile number")
	fmt.Println("  " + strings.Repeat("-", 58))
	fmt.Println("  Opening the setup page in your browser...")
	return runSetup(ctx, log)
}

// ensureService installs and starts the Windows service, elevating if needed.
func ensureService(log *slog.Logger) error {
	if runtime.GOOS != "windows" {
		fmt.Println("  (skipped: background service is a Windows feature)")
		return nil
	}
	if !isAdmin() {
		fmt.Println("  Windows will ask for permission to install the background service.")
		fmt.Println("  Please click Yes.")
		// The elevated copy installs the service and exits; this one carries on
		// to the pairing wizard, which does not need admin.
		if err := relaunchElevated("install-service"); err != nil {
			return err
		}
		time.Sleep(3 * time.Second)
		fmt.Println("  Background service installed.")
		return nil
	}
	return installAndStartService(log)
}

func printReport(rep preflight.Report) {
	for _, r := range rep.Results {
		mark := map[preflight.Status]string{
			preflight.Pass: "  OK  ", preflight.Warn: " note ", preflight.Fail: " FAIL ",
		}[r.Status]
		fmt.Printf("  [%s] %-26s %s\n", mark, r.Label, r.Detail)
		if r.Fix != "" {
			for _, line := range wrap(r.Fix, 62) {
				fmt.Println("           " + line)
			}
		}
	}
}

func showStatus(ctx context.Context, cfg *config.Config) error {
	fmt.Println("  Munim is already connected.")
	fmt.Println()
	fmt.Printf("  Account    %s\n", cfg.OrgName)
	fmt.Printf("  Mobile     %s\n", cfg.Phone)
	fmt.Printf("  Tally      %s (%s)\n", cfg.TallyURL, cfg.TallyVersion)
	for _, c := range cfg.EnabledCompanies() {
		fmt.Printf("  Company    %s\n", c.Name)
	}
	fmt.Println()

	o := preflight.DefaultOptions()
	o.CloudURL = cfg.CloudURL
	printReport(preflight.Run(ctx, o))

	fmt.Println("\n  Your data is on your phone in the Munim app.")
	fmt.Println("  To change companies or re-connect, run:  munim-connector.exe setup")
	pause()
	return nil
}

func banner() {
	fmt.Println()
	fmt.Println("  ===========================================================")
	fmt.Println("    MUNIM  -  Tally on your mobile")
	fmt.Println("  ===========================================================")
	fmt.Println()
	fmt.Println("  Munim only READS your Tally data.")
	fmt.Println("  It never writes or changes anything in your books.")
	fmt.Println()
}

// demoMode is set by the demo scripts. It skips anything that would change
// the machine, so the flow can be shown on a customer's laptop safely.
func demoMode() bool {
	v := strings.ToLower(os.Getenv("MUNIM_DEMO"))
	return v == "1" || v == "true" || v == "yes"
}

// pause keeps the console open when the program was double-clicked, so the
// user can actually read what happened instead of watching a window flash.
func pause() {
	if runtime.GOOS != "windows" {
		return
	}
	fmt.Print("\n  Press Enter to close this window...")
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
}

func wrap(s string, width int) []string {
	var out []string
	line := ""
	for _, w := range strings.Fields(s) {
		if len(line)+len(w)+1 > width {
			out = append(out, line)
			line = w
			continue
		}
		if line == "" {
			line = w
		} else {
			line += " " + w
		}
	}
	if line != "" {
		out = append(out, line)
	}
	return out
}
