# 12 — Roadmap

Solo-dev-with-AI pace. **Build in this order.** Do not parallelise the apps —
one working vertical slice beats four half-built ones.

---

## Week 1 — do these before writing code

These have external lead times and will block you later:

- [ ] Apply: **MSG91 DLT registration** (blocks OTP login → blocks the whole app)
- [ ] Apply: **Meta WhatsApp Business** + submit reminder templates
- [ ] Apply: **Razorpay KYC**
- [ ] Buy: **code-signing certificate** for the connector `.exe`
- [ ] Install **Tally Prime** and **Tally ERP 9** with 2+ years of sample data
- [ ] Reserve: domain, app name on Play Store & App Store

---

## P0 · Weeks 1–2 — Sync engine spike ⭐

The only phase that can kill the product. Nothing else starts until it passes.

- Go connector skeleton + config + logging
- Tally HTTP client, XML request templates (Prime + ERP 9)
- **Byte-level sanitizer** + tolerant XML parser, table-driven tests
- Collection pulls: companies, groups, ledgers, vouchers with `<FETCH>`
- **ALTERID incremental filter working, verified against real Tally**
- `mock-tally` server that honours the AlterID filter + injects faults
- Output normalized JSON to stdout — no cloud, no UI yet

**Exit criteria:** edit one voucher in Tally → exactly one record appears.
Full-sync a 2-year company without crashing.

---

## P1 · Weeks 3–5 — Backend + real ingest

- Monorepo (pnpm + Turborepo), `packages/shared` Zod schemas
- Postgres schema + Drizzle migrations + RLS + partitions
- NestJS: auth (OTP), connectors (pair/heartbeat), **ingest with COPY + idempotency**
- Rollup jobs (BullMQ): `daily_sales`, `company_snapshot`, `bills`
- Connector: pairing, cursor persistence (BoltDB), **offline spool**, backoff
- Dashboard + outstanding endpoints

**Exit criteria:** connector pairs and streams a real company into Postgres;
`GET /dashboard` returns correct numbers matching Tally's own reports.

---

## P2 · Weeks 6–8 — Mobile app

- Expo app, OTP login, pair flow, company selection
- Dashboard, Outstanding + aging, Party detail + statement
- SQLite cache, sync-status banner, Indian number formatting, privacy toggle
- **Manual "send reminder"** (WhatsApp deep link + one-tap call) — no automation yet
- Sentry, EAS build, internal testing track

**Exit criteria:** you can hand the phone to a real shop owner and they
understand the screen without being told.

---

## P3 · Weeks 9–10 — Automated reminders

- Reminder rules UI + API, template engine
- Meta Cloud API integration, webhooks for delivery/read
- SMS fallback, opt-out handling, frequency caps, quiet hours, credits
- Dry-run preview, kill switch

---

## P4 · Weeks 11–12 — Retention features

- Reports: sales analysis, top items, inactive parties
- Nightly **cloud backup** → R2 with client-side encryption
- Multi-user + roles + per-company access
- **Nightly deletion reconcile** (do not skip this)
- Web dashboard (Next.js) reusing the same API

---

## P5 · Weeks 13–14 — Commercial readiness

- Razorpay subscriptions, plans, trial expiry, credit packs
- Connector: Windows service, signed installer, signed auto-update
- Marketing site, privacy policy, terms, pricing page
- Monitoring, alarms, runbooks, load test at 400k vouchers

---

## P6 · Weeks 15–16 — Beta

- 10 real businesses, mixed Tally Prime and ERP 9
- Expect **90% of bugs to be Tally version/data quirks** — budget the whole
  fortnight for exactly that
- Weekly connector releases; watch version adoption
- Instrument: activation rate (paired within 24 h), D7 retention, reminders sent

**Then:** iterate to product-market fit before adding stock, GST, or e-invoicing.

---

## Milestone gates

| Gate | Must be true |
|---|---|
| End of P0 | Incremental sync proven on real Tally, both versions |
| End of P1 | Numbers in Postgres match Tally's own reports, to the rupee |
| End of P2 | A non-technical shop owner completes install → dashboard alone |
| End of P4 | Deleted vouchers disappear from the app within 24 h |
| End of P6 | 5 of 10 beta users say they would pay |

---

## Realistic expectations

- **~4 months to first paying customer** at focused solo pace.
- The long tail is never the UI — it is Tally version differences, weird
  customer data, and Windows install issues.
- Budget 30% of all engineering time to the connector, forever.
