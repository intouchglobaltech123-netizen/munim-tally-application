# 16 — The Four Surfaces

Munim is one product with four pieces of software. Each has a different user,
a different credential, and a different job.

```
                        ┌──────────────────────────────────┐
   SHOP OWNER'S PC      │        MUNIM DEV API :8080       │      YOU
 ┌──────────────────┐   │  (mock-cloud → apps/api later)   │  ┌──────────────┐
 │ CONNECTOR        │──►│                                  │◄─│ ADMIN PANEL  │
 │ Munim.exe (Go)   │   │  device token  → ingest only     │  │ /admin       │
 │ reads Tally :9000│   │  access token  → own org only    │  │ role-gated   │
 └──────────────────┘   │  platform_admin→ all orgs        │  └──────────────┘
                        └───────▲──────────────────▲───────┘
   SHOP OWNER                   │                  │
 ┌──────────────────┐           │                  │   ┌──────────────────┐
 │ MOBILE APP       │───────────┘                  └───│ WEB APP          │
 │ Expo React Native│                                  │ Next.js          │
 │ the product      │                                  │ same data, desk  │
 └──────────────────┘                                  └──────────────────┘
```

---

## 1. Connector — `connector/`

Go binary on the Tally PC. Reads Tally's XML gateway, pushes deltas to the
cloud. **Read-only into Tally, always** (enforced by a test).

Pairing is QR-based: the PC shows a code, the already-signed-in phone approves
it. **The PC never handles the owner's phone number or any credential of
theirs** — it receives only a device token scoped to ingest and heartbeat.

Details: [04-tally-sync-engine.md](04-tally-sync-engine.md),
[15-installer.md](15-installer.md).

## 2. Mobile app — `apps/mobile/`

Expo React Native. **This is the product the customer pays for.**

| Screen | Purpose |
|---|---|
| Login | Phone + OTP. An unknown number creates its own account — there is no separate signup |
| Home | Sales MTD, receivables, payables, cash. Ageing, top items, recent invoices |
| Outstanding | Bill-wise by party, ageing filter, WhatsApp reminder in two taps |
| Statement | Full ledger with running balance, reconciled to the closing figure |
| Link Tally | Camera scans the PC's QR and approves the pairing |
| More | Account, plan, credits, privacy toggle, sign out |

Two behaviours that are not optional:
- **Privacy toggle** — one tap masks every figure. Owners open this in front of
  staff and customers.
- **Freshness label on every screen** — an accounting number without a
  timestamp is a support ticket.

## 3. Web app — `apps/web/` (routes outside `/admin`)

Next.js. Same data, same account, for people who work at a desk — usually the
accountant. Dashboard, outstanding with drill-down, party search, statements,
reminder history, settings with connector health and setup instructions.

## 4. Admin panel — `apps/web/src/app/admin/`

**For you, not for customers.** The only place that reads across tenants.

- Platform totals: businesses, users, companies, vouchers, credits
- **Connectors needing attention** — the churn predictor. A silently broken
  sync looks like a dead product and cancels without ever filing a ticket
- Businesses: plans, trials, usage, last sync
- Fleet: every machine, Tally version, connector version adoption

Two gates, and only one of them is real:
- Server: every `/v1/admin/*` route checks `role === 'platform_admin'` → **403**
- Client: `admin/layout.tsx` hides the UI — **for UX only**. Never treat a
  hidden link as a security control.

> It lives inside `apps/web` to avoid a second deployment before there is
> revenue. When there is, split it into its own app on its own domain — an
> operator console and a customer app should not share an origin.

---

## Credentials — never interchangeable

| Token | Held by | Can do |
|---|---|---|
| Device token | Connector, on the Tally PC | `POST /v1/ingest`, heartbeat. **Cannot read reports** |
| Access token | Mobile + web, signed-in owner | That org's data only |
| Access token + `platform_admin` | You | Cross-tenant admin routes |

Verified:

| Test | Result |
|---|---|
| Customer reads another business's dashboard | **404** |
| Customer reads another business's outstanding | **404** |
| Customer opens the admin console | **403** |
| No token at all | **401** |
| Connector device token on a report route | rejected |

---

## Running it all

```powershell
node mock-cloud\src\index.js          # API on :8080, prints your OTP
corepack pnpm --filter web dev        # web + /admin on :3000
.\connector\dist\Munim.exe setup      # link this Tally PC (sign it first)
```

There is **no demo account**. Sign in with any mobile number, name your
business, and scan the connector's QR. The only seeded account is the operator
login for `/admin` (default `9000000001`, override with `MUNIM_OPERATOR_PHONE`).

Step by step: [17-running.md](17-running.md).

**Mobile note:** a phone cannot reach your laptop's `localhost`. Set
`EXPO_PUBLIC_API_URL` to your machine's LAN IP in `apps/mobile/.env`.

---

## What is still a stand-in

`mock-cloud` is a working in-memory implementation of
[06-api-contract.md](06-api-contract.md) — real multi-tenancy, real auth, real
aggregates, no database. Everything above runs against it.

The production target is `apps/api` (NestJS + Postgres). Because all four
surfaces already speak the finished contract, that migration swaps the storage
layer and keeps the routes. See [14-status.md](14-status.md).
