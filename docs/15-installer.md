# 15 — Installer & Pairing

The `.exe` a shop owner downloads, and everything that happens until their
Tally data appears on their phone.

---

## Two ways to ship, and why the free one exists

**Tested on a Windows 11 Pro machine with Smart App Control enforced**, both
files marked as downloaded from the internet:

| File | Result |
|---|---|
| `MunimSetup-0.1.0.exe` (Inno Setup) | ❌ **BLOCKED** — "An Application Control policy has blocked this file" |
| `Munim.exe` (plain Go binary) | ✅ **LAUNCHED** |

Smart App Control blocks the *installer stub*, not the program. Installer
patterns have poor reputation with Microsoft's Intelligent Security Graph
because malware abuses them. A plain executable does not match that pattern.
Re-verified with a freshly built binary (new hash, no accumulated reputation) —
still allowed.

That gives two distribution paths:

### A. `Munim.exe` — ₹0, ship today

One file. The customer downloads it and double-clicks. The program itself runs
the same flow an installer would:

```
check this computer  ->  install the background service (UAC prompt)  ->  open the pairing wizard
```

No certificate needed. This is the path to use until there is revenue.

Caveats, stated honestly:
- On Windows 10 and upgraded Windows 11 the customer still sees SmartScreen's
  *"Windows protected your PC"* box and must click **More info → Run anyway**.
  Put a screenshot of those two clicks on the download page.
- ISG reputation is dynamic. It works today; it is not a guarantee forever.
- Publish the SHA-256 (`dist/Munim.exe.sha256`) so a cautious customer can
  verify the download.

### B. `MunimSetup-<ver>.exe` — the Inno installer, once you can sign

Keep it. A signed installer is the better experience: Add/Remove Programs entry,
Start-menu shortcuts, a proper uninstaller, upgrade handling. Switch to it the
day a certificate is affordable. The script is written and working.

> **Never tell a customer to turn off Smart App Control.** Once switched off it
> cannot be switched back on without reinstalling Windows.

---

## The split, and why

```
MunimSetup.exe  (Inno Setup)          munim-connector.exe setup  (browser)
────────────────────────────          ─────────────────────────────────────
Hard gates. Native. Blocking.         Everything interactive.
  • Windows 10+ / admin                 • live re-checking
  • disk space                          • phone + OTP sign-in
  • internet                            • QR code for the mobile app
  • Munim server reachable              • pick which companies to sync
  • Tally installed                     • success screen
  • Tally gateway on :9000
```

Inno Setup does the checks because they must **block the install** — a shop
owner must never end up with an installed, paid connector that shows an empty
dashboard and no explanation.

The wizard is a **local web page** because it needs a QR code, a live company
list read from Tally, an OTP field, and checks that re-run while the user fixes
Tally in another window. That is an afternoon in HTML and a fortnight in Inno's
Pascal scripting.

---

## Full flow

```
1  Download MunimSetup.exe
2  Welcome → License
3  SYSTEM CHECK page  ← runs `munim-connector.exe check`
     every FAIL shows the exact fix, e.g.
     "Open Tally, press F1 > Settings > Connectivity,
      set Act as = Server and Port = 9000"
     [Check again]  [How do I enable Tally?]
     Next stays DISABLED until everything passes
4  Choose install folder
5  Installing… copies the exe, installs + starts the Windows service
6  Finish → opens http://127.0.0.1:9111 in the default browser
     │
     ├─ Step 1  System check, live (re-runs every 4s while failing)
     ├─ Step 2  Mobile number → 6-digit SMS code
     │            verifying ALSO pairs the PC — one action, not two
     ├─ Step 3  QR code to install the mobile app
     ├─ Step 4  Tick which Tally companies to sync
     └─ Step 5  Done. Service syncs every 30s.
```

---

## Preflight checks

`internal/preflight`. Each returns a status **and a fix written for a shop
owner**, not an error code.

| Check | Blocks? | On failure the user is told |
|---|---|---|
| Windows version | yes | — (MinVersion in Inno) |
| Free disk space (500 MB) | yes | Free up space — the offline spool needs room |
| Internet | yes | Connect this PC to the internet |
| Munim server reachable | warn | Allow `munim-connector.exe` through your firewall/antivirus |
| Tally installed | yes | Install Tally on **this** computer — Munim reads it directly |
| Tally gateway answering | yes | Tally's exact menu path to enable Server mode |

**Ordering matters.** The gateway check is authoritative: many Indian SMBs run
a portable or copied Tally that leaves no registry entry, so if port 9000 is
answering XML, Tally *is* installed regardless of what the registry says.
Conversely, if Tally is in the registry but the gateway is down, the user gets
the "enable Server mode" fix, not "install Tally".

Detection order: registry (`HKLM\SOFTWARE\Tally Solutions\...`, including
`WOW6432Node`) → well-known install paths → port probe on 9000/9001/9002 →
confirm it actually answers Tally XML (something else may hold the port).

---

## Security of the wizard

The wizard is an HTTP server on the user's own machine. Two controls:

1. **Binds to `127.0.0.1` only.** Never reachable from the shop's network.
2. **One-time token**, generated at launch and passed in the URL; every API
   call must carry it in `X-Setup-Token`. Without this, any web page the user
   happens to have open could POST to localhost and drive the pairing.

Verified: a request with no token returns **403**.

The page is served with a strict CSP and loads no external resources — the QR
image is generated by the connector itself.

---

## Two tokens, never confused

| Token | Lives | Scope |
|---|---|---|
| **User access JWT** | in memory, only during setup | proves the person owns the account |
| **Device token** | `C:\ProgramData\Munim\config.json` (0600) | ingest + heartbeat **only** |

The device token can never read reports; the user token can never write to
ingest. That is what limits the blast radius when a shop PC is compromised.

---

## Files on disk

```
C:\Program Files\Munim\munim-connector.exe   binary, replaced on upgrade
C:\ProgramData\Munim\config.json             pairing, device token, companies
C:\ProgramData\Munim\cursors.json            sync position per company
C:\ProgramData\Munim\connector.log           rolling log
```

`ProgramData` deliberately survives an upgrade, so replacing the binary never
loses the pairing. `PrepareToInstall` stops the service first, or the file is
locked and the upgrade fails halfway. The uninstaller **asks** before deleting
the data directory — keeping it means a reinstall resumes rather than
re-reading years of Tally data.

---

## Demo / testing without Tally

You do not need Tally installed to see the whole flow. `mock-tally` answers on
port 9000, and because the gateway check is authoritative, both Tally checks
pass on their own — there is no "skip" flag to remember.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\demo-windows.ps1
```

That script starts both mocks, points the connector at them via a throwaway
`MUNIM_HOME`, sets `MUNIM_DEMO=1` so no Windows service is installed, and runs
the real `Munim.exe`. The OTP is always `123456`.

`C:\ProgramData\Munim` is never touched, so a demo on a customer's laptop
leaves nothing behind.

## Commands

```
munim-connector.exe                    double-clicked: check -> install -> pair
munim-connector.exe check [--json]     preflight; exit 1 on failure
munim-connector.exe setup              open the pairing wizard
munim-connector.exe install|start|stop|uninstall     Windows service
munim-connector.exe watch              sync loop in the foreground
munim-connector.exe sync               one pass — the support-call command
munim-connector.exe companies          list what Tally has open
munim-connector.exe reset              clear cursors, force a full resync
```

A paired machine reads its endpoints from `config.json`, so the service starts
correctly with no arguments. An explicit `--tally` flag still wins, so support
can point a paired connector at a different Tally to debug.

---

## Building it

```powershell
winget install --id JRSoftware.InnoSetup -e   # one time
.\installer\build.ps1                        # test + build exe + compile installer
.\installer\build.ps1 -Sign -Version 0.2.0   # release build, code-signed
```

Needs Inno Setup 6 and Go 1.23+. Output: `dist\MunimSetup-<version>.exe`.

**Built and verified:**

```
dist\munim-connector.exe    7.5 MB   windows/amd64, -trimpath -s -w
dist\MunimSetup-0.1.0.exe   4.2 MB   Product "Munim", Company "Munim Technologies"
```

Preflight verified running natively on Windows:

```
[  OK  ] Windows version            Windows amd64
[  OK  ] Free disk space            3.7 GB free
[  OK  ] Internet connection        Connected
[  OK  ] Munim server               Reachable
[  OK  ] Tally installed            Detected via the Tally connection
[  OK  ] Tally connection enabled   Connected on port 9000
exit 0
```

With Tally absent the same binary exits 1 and prints Tally's own menu path as
the fix. That exit code is exactly what the installer's system-check page reads
to decide whether Next is enabled.

---

## Before shipping to real customers

- [ ] **Code-sign, when there is budget.** Until then ship `Munim.exe`
      (path A above), which is not blocked. An EV certificate removes the
      SmartScreen box entirely; an OV one removes it after reputation builds
- [ ] Replace `installer/assets/munim.ico` — the current one is generated
      placeholder art
- [ ] Point `AppDownloadURL` (`internal/setupui/server.go`) at the real store
      redirect
- [ ] Test on Windows 10 22H2 **and** 11, with Tally Prime **and** ERP 9
- [ ] Test upgrade over an existing install
- [ ] Test against Quick Heal and K7 — Indian antivirus flags unsigned network
      binaries aggressively
- [ ] Add the offline spool (BoltDB) before real customers: the connector
      currently has no crash-safe queue if the internet drops mid-batch

---

## Antivirus: why it blocked the install, and what changed

A customer's antivirus refused the install outright. Nothing was wrong with the
connector — it was the *shape* of what the installer did. Three things in
particular are what commodity malware does, and every scanner scores them:

| What it did | Why it is flagged |
|---|---|
| `iwr -useb <url> \| iex` in the `.bat` | A download cradle: code that runs without ever touching the disk, so it cannot be scanned |
| Wrote `Munim.vbs` into the Startup folder | A script file that starts itself at login is the classic persistence trick |
| Added `HKCU\...\CurrentVersion\Run` | The other classic. Two of them together reads as "trying hard to survive a reboot" |
| A `.cmd` loop restarting a hidden PowerShell every 60s | Watchdog behaviour, on top of the two above |

None of that was necessary. The installer now:

- **Downloads the script to a file**, runs `Unblock-File`, then runs the file.
  It can be scanned like anything else, and the customer can read it first.
- **Installs one scheduled task and nothing else.** A task is the documented
  way to keep a program running, and it is what a scanner expects to see.
- **Registers without the `AtStartup` trigger** when there are no admin rights,
  instead of falling back to the Startup folder. Only that one trigger needs
  elevation, so a normal user account still gets a proper task.
- **Starts the watcher with `conhost.exe --headless`**, which ships with
  Windows and is signed by Microsoft, in place of `wscript.exe` plus a `.vbs`.
  No window appears. On Windows older than 10 1809 it falls back to a hidden
  window, and if no watcher appears within 12 seconds the task is re-registered
  with that plain action, so a machine is never left silently not syncing.
- **Clears the old `.vbs`, `.cmd` and Run entry on upgrade**, so a machine that
  already has them stops matching the pattern.
- **Leaves a Startup shortcut (`.lnk`) as the last resort only** — no registry
  entry, no loop.

### When the .bat is blocked anyway (K7, on a real customer)

K7 quarantined `Munim-Setup.bat` outright - "Suspicious Object in Program
(ID709056)" - even with the download cradle gone. That is not a bug in the
heuristic. A `.bat` arriving from the internet whose only job is to start
PowerShell **is** the shape of a dropper, and nothing we write inside it
changes that shape.

So the Connect page offers a second route, and it is the one to reach for when
a customer's antivirus objects:

**Download the plain script (`?format=ps1`)**, then right-click →
**Run with PowerShell**.

- It is the connector itself, not a launcher: 2,400 commented lines that read
  like the program they are.
- It downloads nothing and runs nothing on the customer's behalf.
- Windows' own "Run with PowerShell" verb sets the execution policy for that
  process, so our file carries no bypass flag for a scanner to object to.
- It is **byte-identical for every customer**, which is what makes it
  signable - see below. With no code baked in, it asks the cloud for a pairing
  code and shows it; the owner approves that code in the phone app or in the
  box on the Connect page.

### What is still not solved

The `.bat` and the `.ps1` are **unsigned**, so:

- Windows shows SmartScreen's "Windows protected your PC" box on the first run.
  The customer has to choose **More info → Run anyway**.
- An aggressive scanner may still quarantine on reputation alone, particularly
  Quick Heal and K7, which are common in Indian shops.

The only real fixes, in order of how fast they help:

1. **Report the false positive.** Free, and the fastest thing that actually
   works: vendors turn these around in a day or two.
   - K7: raise a ticket at `support.k7computing.com` with Category
     **False Positive**, or email `reportfp@labs.k7computing.com` /
     `support@k7computing.com`, subject "False Positive: file being detected by
     K7". Attach the file and say it is your own product.
   - Quick Heal and Microsoft Defender each have the same kind of form. Do all
     three: the detections are independent.
2. **Buy a code-signing certificate** and run `scripts\sign-connector.ps1`.
   This is the answer for a product that ships to strangers - an OV certificate
   is roughly ₹15–25k a year and earns reputation over weeks; EV costs more and
   clears SmartScreen at once. Since 2023 the private key has to live on a
   hardware token or a cloud HSM, so allow a few days for delivery and setup.

   **Microsoft's cheap route is not open to India.** Artifact Signing (formerly
   Trusted Signing) is $9.99/month, but public-trust certificates are issued
   only to organizations in the US, Canada, the EU, the UK, Australia, New
   Zealand, Japan, South Korea, Singapore, Switzerland, Norway and Israel - and
   to individual developers only in the US and Canada. Use a commercial CA
   instead.
3. **Ask the customer to allow the folder**, `%ProgramData%\Munim`, as an
   exclusion. This works today and needs nothing from us, but asking a shop
   owner to lower a defence is fine for a pilot customer you are on the phone
   with and wrong to put in a public install guide.

Why the certificate is the end of it: a signature covers the file's bytes, and
that is why the `?format=ps1` download is the same file for everyone. The
`.bat` route personalises its script per customer, which can never be signed.
