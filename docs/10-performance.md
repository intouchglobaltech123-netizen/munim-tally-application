# 10 — Performance Rules

A five-year Tally company holds 300k–600k vouchers. Every rule here exists
because the naive version is 100× slower at that size.

---

## The ten rules

### 1. Roll up; never scan raw vouchers for a report
The dashboard reads `company_snapshot` and `daily_sales` — a handful of rows.
It must never run `SUM()` over the `vouchers` table. Rollups are recomputed by a
queued job when ingest touches a date.

> Target: dashboard endpoint p95 **< 80 ms** server-side, at any company size.

### 2. Bulk-insert with `COPY`, never row-by-row
Ingest writes into an `UNLOGGED` staging table via `COPY`, then a single
`INSERT … SELECT … ON CONFLICT DO UPDATE` merges it. ~50× faster than looped
`INSERT`s and it holds one short transaction instead of 500.

### 3. Partition `vouchers` by financial year
`PARTITION BY RANGE (vch_date)`. Reports are almost always current-FY, so the
planner prunes years of data. Old partitions can be detached and archived.
Create next year's partition with a scheduled job.

### 4. Cache with a self-invalidating key
```
key = company:{id}:dash:{lastVoucherAlterId}
```
When new data arrives the cursor changes, so the key changes, so the cache is
correct by construction. No TTL guessing, no manual invalidation bugs.

### 5. gzip the connector payload
Tally XML → normalized JSON still compresses ~8–10×. This is a direct bandwidth
saving on both sides and it matters on a shop's ADSL line.

### 6. PgBouncer in transaction mode
Hundreds of connectors plus API instances will exhaust Postgres connections.
Pool in transaction mode; keep app-side pools small (10–20 per instance).

### 7. Cursor pagination everywhere
`WHERE (vch_date, guid) < (?, ?) ORDER BY vch_date DESC LIMIT 50`.
`OFFSET 10000` reads 10,050 rows to return 50 — on a statement screen that a
user scrolls, it degrades linearly.

### 8. Rate-limit outbound messaging through the queue
WhatsApp bursts get your number throttled. BullMQ limiter, e.g. 20 msg/s org-wide
with per-org fairness so one big customer cannot starve the rest.

### 9. Mobile: SQLite cache + stale-while-revalidate
Render last known data immediately, fetch in background, swap in. Perceived
performance beats real performance for daily-open screens.

### 10. Index for the query you actually run
Partial indexes on `bills WHERE pending_amt > 0` (the only rows outstanding
screens read), covering index with `INCLUDE` on the voucher list, trigram index
for party search. Verify each with `EXPLAIN (ANALYZE, BUFFERS)`.

---

## Ingest throughput target

| Stage | Target |
|---|---|
| Initial full sync, 5-year / 400k-voucher company | **< 25 min** end to end |
| Steady-state incremental batch (500 records) | **< 400 ms** server-side |
| Sustained ingest per API instance | **≥ 2,000 records/s** |

Chunk initial sync by financial year and pull it in a background lane so a new
customer's backfill never delays live users' incremental syncs.

---

## Cost control (performance's twin)

- **R2 over S3** for backups — zero egress. Restores are otherwise your top bill.
- Store `raw jsonb` **compressed** (Postgres TOAST does this) and consider
  dropping raw payloads older than 24 months once your field mapping is stable.
- Do not log full request bodies in production — log volume becomes a real line
  item fast.
- Cache aggressively; every cache hit is a query you do not pay for.

---

## Load testing before launch

Generate a synthetic company with 400k vouchers and 5k parties (write a seeder —
you will use it constantly), then verify:

- [ ] Dashboard p95 < 150 ms end-to-end
- [ ] Outstanding with 2,000 parties < 300 ms
- [ ] 100 connectors ingesting concurrently, no error rate increase
- [ ] Full initial sync of the big company does not slow other tenants
- [ ] DB connection count stays flat under burst
- [ ] Memory flat over a 24 h soak (API and connector both)
