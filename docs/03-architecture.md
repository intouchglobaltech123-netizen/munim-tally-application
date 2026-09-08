# 03 — Architecture

## System diagram

```
   CUSTOMER PREMISES                          YOUR CLOUD  (AWS ap-south-1)
 ┌──────────────────────────┐
 │  Tally Prime / ERP 9     │
 │  HTTP-XML gateway :9000  │
 └────────────▲─────────────┘
              │ XML over localhost (read-only)
 ┌────────────┴─────────────┐            ┌──────────────────────────────┐
 │  MUNIM CONNECTOR  (Go)   │   HTTPS    │  ALB / API Gateway           │
 │  • pair via 6-digit code │  gzip      └───────────┬──────────────────┘
 │  • poll every 30 s       │  NDJSON                │
 │  • ALTERID delta pull    │───────────►┌───────────▼──────────────────┐
 │  • sanitize XML → JSON   │            │  NestJS API   (stateless ×N) │
 │  • offline spool (Bolt)  │            │ ┌────────┬─────────┬───────┐ │
 │  • nightly backup → R2   │            │ │ ingest │ reports │ auth  │ │
 │  • self-update           │            │ │ remind │ billing │ files │ │
 └──────────────────────────┘            │ └────────┴─────────┴───────┘ │
                                         └──┬──────────────┬────────────┘
 ┌──────────────────────────┐  REST/JSON    │              │
 │  Mobile app (Expo RN)    │◄──────────────┘              │
 │  Web dashboard (Next.js) │                              ▼
 └──────────────────────────┘                   ┌────────────────────────┐
                                                │  PostgreSQL 17         │
                            ┌───────────────────┤  • raw voucher JSONB   │
                            │                   │  • partitioned facts   │
                            ▼                   │  • rollup tables       │
                   ┌──────────────────┐         └────────────────────────┘
                   │ Redis + BullMQ   │                     │
                   │ • reminder queue │         ┌───────────▼────────────┐
                   │ • rollup jobs    │         │  Cloudflare R2         │
                   │ • dashboard cache│         │  backups, invoice PDFs │
                   └────────┬─────────┘         └────────────────────────┘
                            ▼
              WhatsApp Cloud API / MSG91 / SES
```

---

## The four hard boundaries

**1. The mobile app never talks to Tally.**
It reads only your cloud. This is what makes the app work when the shop PC is
off, and it means you never expose a customer's LAN to the internet.

**2. The connector is read-only into Tally.**
It never writes a voucher back. Enforce it in code (no write templates exist)
and put it on the pricing page — it is a trust argument that closes sales.

**3. Ingest is a separate NestJS module with its own DB pool.**
Ingest is ~90% of your request volume. Isolating it means a sync storm from one
big customer cannot starve the connection pool serving mobile users. Keeping it
a *module* (not a service) means you can extract it later without a rewrite.

**4. Reports read rollup tables, never raw vouchers.**
See doc 10. A 5-year company has 400k+ vouchers; a dashboard that `SUM()`s them
live will take seconds, and every user opens the dashboard first.

---

## Request flows

### A. Pairing a new connector
```
Owner installs .exe  →  app shows 6-digit code (TTL 10 min, Redis)
  connector POST /v1/connectors/pair {code, machine, tallyVersion}
  API validates → issues device token (shown once, stored Argon2id-hashed)
  connector GET /v1/companies/discover → lists Tally companies
  owner picks companies in the app → full initial sync begins
```

### B. Incremental sync (every 30 s)
```
connector: read cursor {lastMasterAlterId, lastVoucherAlterId} from local Bolt
  POST localhost:9000  (Collection + TDL filter: $AlterID > cursor)
  sanitize bytes → parse XML → map to JSON → batch 500
  gzip → POST /v1/ingest  (Idempotency-Key header)
API: validate → COPY into staging → upsert ON CONFLICT (company_id, guid)
     → enqueue rollup job for touched dates → return {acceptedUpto: alterId}
connector: advance cursor ONLY after 200 OK
```

### C. Mobile dashboard open
```
GET /v1/companies/:id/dashboard
  Redis key = company:{id}:dash:{lastVoucherAlterId}   ← self-invalidating
  miss → read daily_sales + bills rollups (single-digit ms) → cache → return
mobile: renders from local SQLite instantly, then swaps in fresh response
```

### D. Payment reminder
```
BullMQ repeatable job (per org, per business-day 10:00 IST)
  select bills WHERE pending_amt > 0 AND due_date < today - grace
  group by party → build message from approved template
  rate-limited worker → WhatsApp Cloud API → log to reminders table
  webhook receives delivery/read status → update row
```

---

## Environments

| Env | Purpose | Data |
|---|---|---|
| `local` | Docker Compose: Postgres + Redis + mock Tally server | Synthetic |
| `staging` | Full AWS mirror, one small instance | Anonymised |
| `prod` | ap-south-1, multi-AZ RDS | Real |

**Build a mock Tally server that speaks the real XML protocol on port 9000.**
Without it, no one on the team can develop without a Windows PC running Tally,
and CI can never test the sync engine. This is a small file with enormous
leverage — it is P0 work, not a nice-to-have.
