# Munim installer

Produces `MunimSetup-<version>.exe` — the single file a shop owner downloads.

## Build

```powershell
.\installer\build.ps1                # test + build exe + compile installer
.\installer\build.ps1 -Sign          # also code-sign (needs a certificate)
```

Requires [Inno Setup 6](https://jrsoftware.org/isdl.php) and Go 1.23+.

## What the installer does

```
MunimSetup.exe
 ├─ Welcome
 ├─ License
 ├─ System check          <- runs munim-connector.exe check, HARD GATE
 │    • Windows 10+          Next is disabled until every FAIL is cleared
 │    • Free disk space      "Check again" re-runs without restarting setup
 │    • Internet
 │    • Munim server reachable
 │    • Tally installed
 │    • Tally gateway answering on :9000
 ├─ Install location
 ├─ Installing            copies exe, installs + starts the Windows service
 └─ Finish                launches the pairing wizard in the browser
```

The gate is the point: a shop owner must never end up with an installed,
paid connector that shows an empty dashboard and no explanation. If Tally
is not reachable, they get Tally's own menu path — *F1 > Settings >
Connectivity, "Act as" = Server, Port 9000* — and a Retry button.

## Then: the pairing wizard

The installer hands off to `munim-connector.exe setup`, which serves a wizard
at `http://127.0.0.1:9111` and opens the default browser.

```
1  System check      live, re-runs every 4s while anything fails
2  Sign in           mobile number -> 6-digit SMS code -> pairs this PC
3  Get the app       QR code to install the mobile app
4  Choose companies  which Tally companies to sync
5  Finish            service starts syncing
```

**Why a browser and not Inno's own dialogs:** the wizard needs a QR code, a
live company list read from Tally, an OTP field, and checks that re-run while
the user fixes Tally in another window. That is an afternoon in HTML and a
fortnight in Pascal.

**Security:** the wizard binds to `127.0.0.1` only and requires a one-time
token generated at launch and passed in the URL. Without it, any web page the
user happens to have open could POST to localhost and drive the pairing.

## Files on disk after install

```
C:\Program Files\Munim\munim-connector.exe    binary, replaced on upgrade
C:\ProgramData\Munim\config.json              pairing + device token (0600)
C:\ProgramData\Munim\cursors.json             sync position per company
C:\ProgramData\Munim\connector.log            rolling log
```

`ProgramData` deliberately survives an upgrade, so replacing the binary never
loses the pairing. The uninstaller **asks** before deleting it — keeping it
means a reinstall resumes instead of re-reading years of Tally data.

## Command line

```
munim-connector.exe check [--json]   run the system checks, exit 1 on failure
munim-connector.exe setup            open the pairing wizard
munim-connector.exe install|start|stop|uninstall    Windows service control
munim-connector.exe watch            run the sync loop in the foreground
munim-connector.exe sync             one pass, useful for support calls
```

## Before shipping to real customers

- [ ] **Code-sign both binaries.** Unsigned means SmartScreen, means most
      shop owners stop at "Windows protected your PC"
- [ ] Replace `assets/munim.ico` with the real brand icon (current one is
      generated placeholder art)
- [ ] Point `AppDownloadURL` in `internal/setupui/server.go` at the real
      store redirect
- [ ] Test on Windows 10 22H2 and Windows 11, with Tally Prime **and** ERP 9
- [ ] Test upgrade-over-existing-install (service must stop before the
      binary is replaced — `PrepareToInstall` handles this)
- [ ] Test with common Indian antivirus (Quick Heal, K7) — they flag unsigned
      network binaries aggressively
