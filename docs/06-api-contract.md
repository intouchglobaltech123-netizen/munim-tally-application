# 06 — API Contract

Base: `https://api.munim.app/v1` · JSON · Zod schemas in `packages/shared/`.

Two audiences with different auth:
- **Connector** → `Authorization: Bearer <device_token>`
- **App/Web** → `Authorization: Bearer <jwt_access>`

---

## Conventions

| Rule | Detail |
|---|---|
| Errors | `{ "error": { "code": "TALLY_COMPANY_MISMATCH", "message": "...", "details": {} } }` — stable machine codes, never rely on message text |
| Pagination | Cursor only: `?limit=50&cursor=<opaque>` → `{ items, nextCursor }`. Never `OFFSET` |
| Money | Integer **paise** in JSON (`amount: 2548000` = ₹25,480.00). Never floats over the wire |
| Dates | `YYYY-MM-DD` for business dates; ISO-8601 UTC for timestamps |
| Idempotency | `Idempotency-Key` header required on all connector writes |
| Versioning | Path-versioned `/v1`. Connectors in the field lag months behind — never break v1 |

---

## Auth (app)

```
POST /auth/otp/request     { phone }                  → { requestId, ttl }
POST /auth/otp/verify      { requestId, otp }         → { access, refresh, user, org }
POST /auth/refresh         { refresh }                → { access, refresh }
POST /auth/logout          { refresh }                → 204
GET  /me                                              → { user, org, companies[] }
```
Rate-limit OTP: 3/phone/10 min, 20/IP/hour. Otherwise SMS cost becomes an attack.

---

## Connector lifecycle

```
POST /connectors/pair
  { pairCode, machineName, os, tallyVersion, appVersion }
  → { connectorId, deviceToken, orgId }          # token returned ONCE

POST /connectors/heartbeat                        # every 60s
  { status, tallyUp, companiesLoaded[], appVersion, lastError? }
  → { commands: [ {type:"full_resync", companyId}, {type:"update", url} ] }
  # server-issued commands = remote control without inbound firewall rules

GET  /connectors/me                               → connector config + enabled companies
POST /connectors/companies/discover
  { companies: [{ tallyGuid, name, fyStart }] }   → { registered[] }
```

**Heartbeat carries commands.** That is how you trigger a resync or an update on
a customer PC you can never reach directly.

---

## Ingest (the hot path)

```
POST /ingest
Headers: Authorization, Idempotency-Key, Content-Encoding: gzip
Body (NDJSON, ≤500 records per request):
  {"kind":"ledger",  "companyGuid":"...", "alterId":10432, "data":{...}}
  {"kind":"voucher", "companyGuid":"...", "alterId":88213, "data":{...}}

→ 200 { accepted: 500, rejected: 0,
        cursors: { master: 10432, voucher: 88213 },
        errors: [] }
→ 409 { error: { code: "ALTERID_REGRESSION" } }   # connector must full-resync
→ 413 batch too large
→ 429 { retryAfter }                              # back off, do not drop
```

Rules:
1. Partial success is allowed — return per-record errors, never fail the batch.
2. Same `Idempotency-Key` within 24 h returns the original response, no re-write.
3. The connector advances its cursor **only** from the `cursors` in the response.

```
POST /ingest/reconcile                            # nightly deletion check
  { companyGuid, month:"2026-07", guids:[{guid, alterId}] }
  → { missingInCloud:[guid], deletedInTally:[guid] }
```

---

## Reports (app + web)

```
GET /companies/:id/dashboard
→ {
    asOf, syncStatus: { lastSyncAt, healthy, reason? },
    tiles: { sales:{mtd, prevMtd, changePct},
             receivables:{total, overdue},
             payables:{total, overdue},
             cashInHand:{amount}, bank:{amount} },
    salesTrend: [{ day, amount }],            # last 30 days
    topItems:   [{ name, amount, qty }],      # top 5 MTD
    recentVouchers: [{ vchNo, date, party, amount, type }]
  }
```
Every screen shows `syncStatus`. A stale number without a "last synced" label
generates support tickets.

```
GET /companies/:id/outstanding?kind=receivable&sort=overdue&limit=50&cursor=
→ { totals: { total, buckets: {"0-30":n,"31-60":n,"61-90":n,"90+":n} },
    items: [ { ledgerId, party, phone, total, overdue, oldestDays,
               bills:[{ ref, date, dueDate, pending, days }] } ],
    nextCursor }

GET /companies/:id/ledgers?q=raj&limit=30&cursor=
GET /companies/:id/ledgers/:ledgerId/statement?from=&to=
GET /companies/:id/vouchers/:guid
GET /companies/:id/reports/sales-analysis?groupBy=month|party|item&from=&to=
GET /companies/:id/reports/top-items?from=&to=
GET /companies/:id/reports/inactive-parties?days=90
```

---

## Reminders

```
GET  /companies/:id/reminder-rules
PUT  /companies/:id/reminder-rules
  { enabled, daysAfterDue:[7,15,30], channels:["whatsapp","sms"],
    sendAt:"10:00", templateKey:"payment_due_v1" }

POST /companies/:id/reminders/send
  { ledgerId, billIds[], channel, templateKey }
  → { reminderIds[], creditsUsed, creditsRemaining }

GET  /companies/:id/reminders?status=&limit=&cursor=
POST /webhooks/whatsapp        # Meta delivery/read callbacks (signature-verified)
POST /webhooks/msg91
POST /webhooks/razorpay
```

Sending is **always queued**, never synchronous. The API returns `queued` ids;
the UI shows status transitions from the reminders list.

---

## Billing & files

```
GET  /billing/plans
POST /billing/subscribe          { plan, companyCount } → { razorpaySubId, checkout }
GET  /billing/subscription
POST /billing/credits/purchase   { packSize }

POST /files/backup/presign       { companyGuid, sizeBytes } → { uploadUrl, key }
POST /files/backup/complete      { key, checksum }
GET  /files/backups?companyId=
```
Backups upload **direct to R2 via presigned URL** — never stream a 2 GB company
file through your API.

---

## Rate limits

| Endpoint | Limit |
|---|---|
| `/ingest` | 120 req/min per connector (burst 300) |
| `/auth/otp/request` | 3 per phone / 10 min |
| Report endpoints | 60 req/min per user |
| `/reminders/send` | 30 req/min per org, then the queue paces it |
