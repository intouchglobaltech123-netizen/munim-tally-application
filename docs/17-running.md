# 17 — How to Run It

Real Tally, real accounts, no demo data.

---

## Two one-time setups

### 1. Turn on Tally's gateway

Munim reads Tally directly. Tally has to be told to share:

```
Tally  ->  F1  ->  Settings  ->  Connectivity  ->  Client/Server configuration
           TallyPrime acts as  :  None      <-- leave it alone
           Enable ODBC         :  Yes       <-- this is the one that matters
           Port                :  9000
```

`Enable ODBC = Yes` is what opens the gateway. **"Acts as = Server" is not it** —
that is Tally's multi-user data sharing and needs a Gold licence. Full walk-
through in [19-tally-setup.md](19-tally-setup.md).

**Keep Tally open.** A closed Tally has nothing to read.

Check it worked:
```powershell
Get-NetTCPConnection -LocalPort 9000 -State Listen
```
Nothing listed means Tally is not sharing yet.

### 2. Use the PowerShell connector, not the .exe

Windows **Smart App Control** refuses unsigned programs. On this machine it
blocks the connector, the installer, and even Go's own compiler.

**A self-signed certificate does not fix this.** That was tried: the file signed
cleanly (`signature status: Valid`) and Windows still refused it —
*"did not meet the Enterprise signing level requirements."* Smart App Control
wants a real CA, and a real CA wants ₹50,000/year. So take the other door:

```powershell
powershell -ExecutionPolicy Bypass -File .\connector-ps\Munim-Connector.ps1 check
```

**PowerShell scripts are exempt from Smart App Control.** Same sync engine, no
certificate, ₹0 — and it is what customers install too, so you test what they
run. See [15-installer.md](15-installer.md).

> **Never turn Smart App Control off.** It cannot be turned back on without
> reinstalling Windows.

---

## Running it

From **PowerShell**, in the project folder. Three commands, one per window:

```powershell
npm run api      # the server      - port 8080
npm run web      # the web app     - port 3000
npm run app      # Expo, for the phone
```

Or in **VS Code**: `Ctrl+Shift+B`, or *Terminal → Run Task* → **Munim: Everything**.

Each one stays open - that *is* the process. Stop with `Ctrl+C`.

### Why `npm run api` and not `node apps/api/src/index.js`

Postgres lives inside **WSL**, and the API reaches it over a Unix socket at
`/var/run/postgresql` - a path that does not exist on Windows. Run the API
directly from PowerShell and it fails with:

```
failed to start: connect ENOENT /var/run/postgresql/.s.PGSQL.5432
```

So `npm run api` runs it **in WSL**, while `web` and `app` run on **Windows**,
which is where their native binaries (`lightningcss`, `sharp`, `@next/swc`) are
built for. The scripts handle that split; you do not have to think about it.

> `wsl -e bash -lc` is not enough, by the way: without `-i` the shell does not
> load nvm, and Windows' own `corepack` gets picked up from the shared PATH -
> which fails with `/bin/sh^M: bad interpreter`, because that file has Windows
> line endings. The scripts use `-lic`.

**There are two PostgreSQL 18 servers on this machine** - one in WSL holding
Munim's data, and a Windows service also listening on 5432. Windows'
`localhost:5432` reaches the *Windows* one, which is empty. That is why the API
runs in WSL rather than connecting over TCP.

### Other commands

```powershell
npm run api:migrate   # apply new migrations
npm run api:test      # the API test suite
npm run api:stop      # kill a server left running in WSL
npm run db            # psql, straight into the munim database
npm run app:clear     # Expo with a cleared cache - after changing .env
```

---

## The journey — in order

### 1. Sign in
Open <http://localhost:3000>, enter your mobile number. Firebase sends the SMS;
your registered test number `+91 84380 98627` uses code `548723` and sends
nothing. An unknown number creates a new account — signing in *is* signing up.

### 2. Name your business
```
"What is your business called?"   ->   Sri Balaji Hardware
```
This creates your company. Nothing else is reachable until you answer it, and
you cannot link Tally before it — the API returns `409 NOT_ONBOARDED`, because
there is nothing to link Tally *to*.

### 3. Link your Tally computer
```powershell
.\connector-ps\Munim-Connector.ps1 pair
```
It checks the machine, then shows a **QR code** at `http://127.0.0.1:9111`.

### 4. Approve it from your phone
Scan that QR in the Munim app, signed in with the same number.

The PC never sees your phone number or any password. It receives a **device
token that can only send data** — it cannot read your reports.

### 5. It syncs
The connector registers every company Tally has open and starts sending:

```
R & K Traders   masters=91  vouchers=2200  batches=8  alterId 0->7200  291ms
```

Then every 30 seconds it sends **only what changed**.

```powershell
.\connector-ps\Munim-Connector.ps1 sync    # one pass - the support-call command
.\connector-ps\Munim-Connector.ps1 watch   # the real 30s loop
```

### 6. Your data appears
Refresh <http://localhost:3000>: sales, receivables, payables, cash, ageing,
party statements, Day Book, Trial Balance, P&L, Balance Sheet. The same on your phone with the same number.

### 7. Control it from your phone
Turn a book off in the app. The shop PC finds out on its next heartbeat and
obeys. Nobody walks back to that computer.

---

## Proving it is a real SaaS

Sign in with a **second** mobile number, name a different business, link it.
Then check neither can see the other:

```bash
# customer B asking for customer A's company
curl -H "Authorization: Bearer <B's token>" \
     http://localhost:8080/v1/companies/<A's tallyGuid>/dashboard
# -> 404  "No such company in your account."

# a customer asking for the operator console
curl -H "Authorization: Bearer <customer token>" \
     http://localhost:8080/v1/admin/orgs
# -> 403 FORBIDDEN
```

Verified:

| Test | Result |
|---|---|
| Customer reads another business's dashboard | **404** |
| Customer reads another business's outstanding | **404** |
| Customer opens the admin console | **403** |
| No token | **401** |
| Link Tally before naming the business | **409 NOT_ONBOARDED** |

---

## Your operator console

Sign in as the operator number (default `9000000001`; set
`MUNIM_OPERATOR_PHONE` to change it) and open `/admin`:

- every business, plan, usage, last sync
- **connectors needing attention** — the churn signal. A customer whose sync
  quietly stopped experiences a dead product and cancels without ever filing a
  ticket
- connector version adoption across the fleet

---

## The mobile app

### "Network request failed" — the WSL problem

The API runs inside **WSL**. Windows reaches it on `localhost` because WSL2
forwards loopback — but **that forwarding is loopback only**. Your phone hits
your Windows LAN address, where nothing is listening:

```
phone 192.168.1.x  ->  192.168.1.10:8080  (Windows)   nothing here
                                    API is at 172.21.x.x:8080 (WSL)
```

Bridge it once, from an **administrator** PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\expose-api.ps1
```

That adds a port proxy and a private-network firewall rule, and checks the
result **from outside the firewall** - testing from Windows itself proves
nothing, because traffic to your own LAN address never crosses it.

**You do not have to edit `apps/mobile/.env`.** The app works out the address
itself: Metro serves the bundle from your computer, so the bundle URL already
carries your computer's current IP and the app just swaps the port. Change
Wi-Fi, join a hotspot - nothing to edit.

**Re-run this script when you join a new network**, for two reasons:

| What changed | Why it breaks |
|---|---|
| Joined any new Wi-Fi | Windows classifies new networks **Public**, and the firewall rule is Private-scoped, so it silently stops applying |
| Rebooted | WSL takes a new IP, so the proxy points at the old one |

Your own LAN IP changing does **not** need a re-run - the proxy listens on
`0.0.0.0`. Tear it all down with `-Remove`.

> No admin to hand? Setting the network to Private is enough, and that needs
> none: **Settings -> Network & internet -> Wi-Fi -> (your network) -> Private**.

### Then

```powershell
corepack pnpm install
cd apps\mobile
npx expo start --clear
```

`--clear` matters: Metro caches the old `EXPO_PUBLIC_API_URL` into the bundle.

---

## Automated tests

```bash
cd connector && go test ./...        # 26 tests
```

These use `mock-tally/`, a fixture that emulates Tally's XML gateway with the
real dirt in it — control bytes, bare `&`, CP-1252 encoding, Indian number
formats — plus fault injection. It exists so the sync engine is testable in CI
and on a machine with no Tally. It is **not** part of the product flow.

To develop with no Tally at all:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev-windows.ps1 -FakeTally
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Application Control policy has blocked this file` | Smart App Control blocked the .exe. Use `connector-ps\Munim-Connector.ps1` — signing will not fix it |
| Go build fails with the same message | Smart App Control blocks Go's tools. Build in WSL: `GOOS=windows go build -o dist/Munim.exe ./cmd/lkp-agent` |
| `[FAIL] Tally connection enabled` | Tally is closed, or `Enable ODBC` is not Yes. See [19-tally-setup.md](19-tally-setup.md) |
| `[FAIL] Tally installed` but Tally is running | The gateway check is authoritative — fix the gateway and both clear |
| `409 NOT_ONBOARDED` | Name your business before linking Tally |
| `pnpm: not recognized` | Use `corepack pnpm` |
| Dashboard empty after sign-in | No Tally linked yet — the page shows the setup steps |
| API edits seem to do nothing | The old process still holds port 8080. Kill it and restart |
| Mobile: "Network request failed" | The API is in WSL and not exposed to the LAN. Run `scripts\expose-api.ps1` as administrator |
| Mobile: "EXPO_PUBLIC_API_URL is not set" | Create `apps/mobile/.env`, then `npx expo start --clear` |
| Mobile worked yesterday, not today | WSL took a new IP on reboot. Re-run `scripts\expose-api.ps1` |
| `ERR_PNPM_IGNORED_BUILDS` | pnpm 11 blocks postinstall scripts. Fixed by `pnpm.onlyBuiltDependencies` in the root `package.json` — pull and reinstall |
