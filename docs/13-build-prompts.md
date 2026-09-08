# 13 — Build Prompts for Antigravity

Copy-paste, one at a time, in order. **Always name the docs to read first** —
that is what keeps the agent on spec instead of inventing its own architecture.

Rule: finish and verify a prompt before starting the next one.

---

## Prompt 0 — Monorepo scaffold

```
Read docs/02-tech-stack.md and README.md.

Scaffold the monorepo only — no business logic:
- pnpm workspaces + Turborepo
- apps/api (NestJS + Fastify adapter, TypeScript strict)
- apps/web (Next.js 15 App Router)
- apps/mobile (Expo SDK 54, TypeScript)
- packages/shared (Zod schemas + shared types)
- packages/db (Drizzle + postgres driver)
- connector/ (Go module, outside the pnpm workspace)
- infra/docker-compose.yml: postgres:17, redis:7, minio
- Root scripts: dev, build, lint, typecheck, test
- .editorconfig, eslint, prettier, tsconfig base with path aliases

Every app must start and print a health message. Nothing more.
```

---

## Prompt 1 — Mock Tally server (build this BEFORE the connector)

```
Read docs/04-tally-sync-engine.md carefully.

Create mock-tally/ — a Node HTTP server on port 9000 that emulates Tally's
XML gateway:
- Parses the incoming <ENVELOPE> and routes on COLLECTION NAME / TYPE
- Responds with realistic Tally XML for: Company, Group, Ledger, StockItem,
  VoucherType, Voucher (with FETCH'd LedgerEntries, InventoryEntries,
  BillAllocations)
- MUST honour the "$AlterID > N" filter so incremental sync is genuinely testable
- Seeded dataset: 3 companies, 200 ledgers, 2 years of vouchers, deterministic
- Fault injection via query flags: ?fault=malformed | truncated | timeout |
  no_company | alterid_reset
- Include the ugly realities: unescaped &, control chars like &#4;, CP-1252
  bytes, Indian-formatted amounts like "-1,25,000.00"

Add a README explaining how to run it and how to point the connector at it.
```

---

## Prompt 2 — Connector: Tally client + sanitizer

```
Read docs/04-tally-sync-engine.md.

In connector/ (Go 1.23), implement:
- internal/tally: XML request template builder, per-version templates
  (erp9, prime) in templates/
- internal/sanitize: byte-level cleaner (control chars, encoding transcode,
  bare & repair) with table-driven tests
- internal/parse: tolerant XML -> typed structs; missing field => zero value,
  never a panic. Indian number parser for amounts.
- cmd/lkp-agent: CLI that connects to a Tally endpoint (flag, default
  localhost:9000), lists companies, pulls masters and vouchers above a given
  AlterID, prints normalized JSON

Test against mock-tally, including every fault mode.
No cloud calls yet.
```

---

## Prompt 3 — Database + shared schemas

```
Read docs/05-database-schema.md and docs/09-security.md.

In packages/db: Drizzle schema + migrations for every table in doc 05, with
- vouchers PARTITIONed BY RANGE (vch_date), plus a helper to create FY partitions
- all indexes from the doc, including the partial and trigram ones
- RLS policies on every tenant table
- a seeder that generates a company with 400k vouchers and 5k parties for load
  testing (see docs/10-performance.md)

In packages/shared: Zod schemas for every API request/response in
docs/06-api-contract.md, exported as both types and validators.
Money is integer paise everywhere.
```

---

## Prompt 4 — API: auth + connector lifecycle + ingest

```
Read docs/06-api-contract.md, docs/05-database-schema.md, docs/10-performance.md.

In apps/api implement modules:
- auth: phone OTP request/verify (pluggable SMS provider, console provider for
  dev), JWT access + rotating refresh, rate limits per the doc
- connectors: pair (6-digit code in Redis, TTL 10 min), heartbeat returning
  server commands, discover companies
- ingest: gzip NDJSON, Idempotency-Key, COPY into UNLOGGED staging then
  INSERT ... SELECT ... ON CONFLICT DO UPDATE, per-record errors, returns cursors
- A transaction interceptor that runs SET LOCAL app.org_id for RLS

Include a CI test proving org A cannot read org B's rows.
```

---

## Prompt 5 — Connector: pairing, cursors, spool, sync loop

```
Read docs/04-tally-sync-engine.md sections 3, 7, 8.

Extend connector/:
- pair with the API using a 6-digit code, store device token in the OS
  credential store
- BoltDB state: per-company cursors, spool of pending batches (cap 500 MB/7 days)
- 30s sync loop: pull deltas -> batch 500 -> gzip -> POST /v1/ingest, advance
  cursor ONLY on 200
- exponential backoff 30s->1m->5m->15m->30m; drain spool in order before new pulls
- 60s heartbeat, execute server commands (full_resync, update)
- detect AlterID regression -> full resync
- structured logs with redaction (never log full voucher payloads)
```

---

## Prompt 6 — Rollups + report endpoints

```
Read docs/05-database-schema.md and docs/10-performance.md.

- BullMQ worker: on ingest, enqueue rollup jobs for touched dates; compute
  daily_sales, daily_ledger_bal, item_sales_monthly, bills, company_snapshot
- API report endpoints from docs/06-api-contract.md: dashboard, outstanding
  (with aging buckets), ledgers search, statement, sales-analysis, top-items,
  inactive-parties
- Redis cache keyed company:{id}:dash:{lastVoucherAlterId}
- Cursor pagination only

Verify: dashboard p95 < 80ms against the 400k-voucher seed.
```

---

## Prompt 7 — Mobile app

```
Read docs/07-mobile-app-spec.md.

In apps/mobile build: OTP login, pair-connector flow, company switcher,
Dashboard, Outstanding with aging + party detail + bill list, Ledger statement,
More/sync-status.

- TanStack Query + Expo SQLite persistence, stale-while-revalidate
- FlashList for all long lists
- Indian number formatting (en-IN, lakh/crore), tabular figures
- Amount privacy toggle
- Sync freshness label on every screen
- Zod-validate every response; a bad payload degrades one card, not the app
- Sentry
```

---

## Prompt 8 — Reminders

```
Read docs/08-reminders.md.

- reminder_rules CRUD + UI
- BullMQ scheduler: select due bills, group by party (one message per party),
  suppression rules, quiet hours, frequency caps, credit checks
- Meta WhatsApp Cloud API provider + MSG91 SMS fallback + SES email
- Signature-verified webhooks updating delivery/read status
- Dry-run preview, global kill switch via env flag, staging whitelist
```

---

## Prompt 9 — Web dashboard

```
Read docs/07-mobile-app-spec.md (same features) and docs/06-api-contract.md.

apps/web: Next.js dashboard reusing packages/shared types — login, dashboard,
outstanding, party statement, reports, reminders, settings. Plus a public
marketing site: home, pricing, privacy, terms, download-connector page.
```

---

## Prompt 10 — Ship it

```
Read docs/11-infrastructure.md and docs/09-security.md.

- Dockerfiles for api and worker; GitHub Actions per doc 11
- Terraform: ECS Fargate, RDS Multi-AZ, ElastiCache, ALB, Secrets Manager
- Connector: Windows service wrapper, Inno Setup installer, signed
  auto-update with Ed25519 verification
- Razorpay subscriptions + credit packs
- CloudWatch alarms + Sentry + OTel per the observability table
- Write the 5 runbooks listed in doc 11
```

---

## Prompts that will waste your time

Do not ask for these — they produce plausible code that fails on real data:

- ❌ "Build the whole Tally app" — you get four broken shells
- ❌ "Write the Tally XML parser" without doc 04 — you get a naive parser that
  crashes on the first real customer's data
- ❌ "Add caching" without doc 10 — you get TTL guesses and stale-data bugs
- ❌ "Make it scale" — meaningless. Point at the specific rule in doc 10
