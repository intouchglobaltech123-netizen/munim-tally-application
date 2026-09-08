# apps/api — the Munim backend

Node + PostgreSQL. **This is the real backend**; `mock-cloud/` is retired.

```bash
createdb munim
node src/migrate.js                 # applies src/migrations/*.sql
OTP_FIXED_CODE=123456 node src/index.js
```

## Why no framework

Twenty routes. A framework would be more code than the thing it organises, and
every route here is a plain async function taking a context — trivial to move
into NestJS later if the team grows.

## What is real

- **Postgres schema** with foreign keys, partial indexes, a trigram index for
  party search, and migrations applied at boot
- **Sessions in the database**, tokens stored only as SHA-256 — a dump does not
  hand anyone a working session
- **OTP rate limiting in SQL** (3 per phone per 10 min, 5 guesses per code), so
  it survives a restart and works across instances
- **Multi-tenancy**: every report resolves the company through the caller's org
  first. That lookup is the tenant fence
- **Ingest** upserts on `(company_id, guid)` in one transaction per batch, with
  idempotency scoped to the connector
- **Bill-wise outstanding** nets each reference: a sale raises it, a receipt
  settles it

## Layout

```
src/
  index.js          server + router
  db.js             pool, transactions, migration runner
  migrations/       *.sql, applied in filename order, each in its own tx
  lib/http.js       body reading, gzip, errors
  lib/auth.js       token hashing, sessions, guards
  routes/auth.js        OTP, onboarding, /me
  routes/connectors.js  QR pairing, discover, heartbeat
  routes/ingest.js      the hot path
  routes/reports.js     dashboard, outstanding, ledgers, statement
  routes/misc.js        reminders, admin
```

## Before production

- [ ] Swap the dev OTP provider for Firebase (docs/18-authentication.md)
- [ ] Enable Postgres RLS as a second net behind the app-level org filter
- [ ] Partition `vouchers` by financial year once a customer passes ~200k rows
- [ ] Move rollups into materialised tables; today the dashboard aggregates live
- [ ] PgBouncer in front of the pool
