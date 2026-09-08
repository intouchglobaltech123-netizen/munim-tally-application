# 14 — Build Status

Updated 2026-08-31 (real Tally, real accounts, no demo data or demo scripts).

---

## What actually works right now

**P0 (the sync engine) is done and verified end to end.** All demo data and
demo scripts have been removed: every business signs up the way a real one does.

Run it: [17-running.md](17-running.md).

```bash
```

Verified behaviour:

| Behaviour | Evidence |
|---|---|
| Full sync of 2 companies, 4,372 vouchers | 430 ms, 16 batches |
| Incremental sync pulls only what changed | edit 1 voucher → **1 record**, 11 ms |
| Cursor advances only after the sink accepts | `internal/sync/engine.go` |
| Masters and vouchers use separate cursors | `Cursor{MasterAlter, VoucherAlter}` |
| AlterID regression (backup restore) detected and auto-recovered | full resync triggered automatically |
| Bare `&` in party names survives ("R & K Traders") | 1,428 records in the dump |
| `<urgent>` in narration survives | escaped/unescaped correctly |
| CP-1252 bytes transcoded, control chars stripped | 15 sanitizer tests |
| Money is exact (integer paise) | `TestAmountStaysExactWhenAccumulated` |
| Faults produce clear distinct errors, never a crash | malformed / truncated / no_company / html / timeout |
| Connector cannot write to Tally | `TestNoRequestCanWriteToTally` |

Tests: **26 passing** across `sanitize`, `parse`, `tally`.

### Installer flow, verified end to end

| Step | Evidence |
|---|---|
| Preflight blocks a bad machine | `check` exits 1, prints Tally's exact menu path as the fix |
| Gateway check is authoritative over the registry | portable Tally installs are not falsely blocked |
| Wizard token guard | request without `X-Setup-Token` → **403** |
| OTP → verify → pair in one action | device token issued and saved 0600 |
| Company picker | deselected company is skipped by every later sync |
| Paired sync pushes to cloud | 2,263 records, 8 batches, gzip NDJSON |
| Cloud aggregates to a dashboard | sales MTD, ageing buckets, top items, top debtors |
| QR renders | 320×320 PNG from the connector itself, no CDN |

---

## Repo state, honestly

| Area | State |
|---|---|
| **Connector** (`connector/`) | ✅ Sync engine, preflight, QR pairing wizard, Windows service, self-installing `Munim.exe`. 26 tests |
| **Dev API** (`mock-cloud/`) | ✅ Multi-tenant. OTP auth + self-serve signup, QR intent pairing, ingest, per-tenant aggregates, customer + admin routes, role gates |
| **Mock Tally** (`mock-tally/`) | ✅ AlterID filter, real Tally dirt, 5 fault modes, internally consistent books (bills settle; statements reconcile to closing) |
| **Web app** (`apps/web`) | ✅ Login, dashboard, outstanding + drill-down, party search, statement, reminders, settings. Typechecks clean |
| **Admin panel** (`apps/web/.../admin`) | ✅ Platform stats, businesses, connector fleet, churn signal. Server-side role gate (403) |
| **Mobile app** (`apps/mobile`) | ✅ Login, dashboard, outstanding, statement, QR scanner to link Tally, privacy toggle. **Dependencies not installed here** — run `pnpm install` then `npx expo start` |
| `apps/api` | ⚠️ **Scaffold.** NestJS shell; writes to no database. `mock-cloud` is what actually serves everything today |
| `packages/db` | ⚠️ Partial schema, no migrations, no partitioning, no RLS |
| `packages/shared` | ⚠️ Thin. Types are currently duplicated in web and mobile |
| `infra/` | ⚠️ Compose file only, no Terraform |

---

## What was wrong before, and is now fixed

1. **The sanitizer corrupted data.** It ran
   `replace("&amp;","&")` then `replace("&","&amp;")` over the whole document,
   which turns `&lt;` into `&amp;lt;` — silently mangling every name containing
   an escaped character. Replaced with an entity-aware escaper.
2. **No AlterID filter anywhere.** The connector had no incremental sync at all;
   it would have re-downloaded the entire book every 15 seconds.
3. **No cursors, no state.** Nothing was persisted between runs.
4. **The mock Tally returned two hardcoded companies** and nothing else — it
   could not test sync logic, which is the only reason to have a mock.
5. **Amounts were never parsed.** `"-1,25,000.00"` was carried as a string;
   `parseFloat` on it yields `-1`.
6. **No voucher line items.** No `FETCH`, so no ledger entries, inventory
   entries or bill allocations — meaning no outstanding, no aging, no reminders.
7. **No Tally version handling.** One template set for both Prime and ERP 9.

---

## Verified this session

| Test | Result |
|---|---|
| QR pairing: PC shows code → phone approves → PC gets device token | org name, connector id and token all saved |
| Company selection restored | a deselected company is skipped by every later sync |
| Self-serve signup | an unknown phone number gets its own org |
| Cross-tenant read of another business's dashboard | **404** |
| Cross-tenant read of another business's outstanding | **404** |
| Customer opening the admin console | **403** |
| No token | **401** |
| Every endpoint the web and mobile apps call | all **200** |
| Outstanding totals vs ageing buckets | consistent (overdue ≤ total) |
| Ledger statement | running balance lands exactly on the ledger's closing figure |

---

## The customer journey (what the code now does)

```
1  Owner signs in with their mobile number  ->  unknown number = signup
2  Names their business                     ->  THIS creates the company
3  Runs Munim.exe on the Tally PC           ->  checks machine, shows a QR
4  Scans the QR in the app                  ->  PC gets a device token
5  PC registers every book Tally has open   ->  no picking on the PC
6  Sync starts                              ->  data appears on phone + web
```

Linking a Tally PC never asks for a phone number or an OTP, so a customer with
three shop computers still costs one SMS.

Two rules the code enforces:

- **You cannot link Tally before naming your business** — there is nothing to
  link it to. `POST /v1/auth/intent/approve` returns `409 NOT_ONBOARDED`.
- **The cloud decides which books sync, not the PC.** The owner toggles a book
  in the app; the connector picks it up on its next heartbeat and obeys. Nobody
  has to go back to the shop computer.

---

## Bugs found and fixed this session

1. **Company selection had been deleted from the setup wizard.** The connector
   therefore synced every company and never told the cloud which ones the owner
   chose. Restored as step 3.
2. **The pairing QR encoded a bare intent id.** A phone camera scanning it got
   meaningless text. Now encodes the `https://munim.app/p/<id>` deep link.
3. **Org name was hardcoded to "Your Business"** after pairing, and the
   connector id was never saved.
4. **Debug `<pre>` element leaking stack traces** into the setup UI.
5. **The mock's books never settled a bill**, so outstanding (₹7.1 Cr) exceeded
   the receivables total (₹1.2 Cr). Invoices now settle with age, and debtor
   balances are derived from open bills.
6. **Statements did not reconcile** to the ledger closing balance. Opening
   balances are now derived so `opening + entries = closing`, exactly.
7. **`apps/mobile/package.json` was internally inconsistent** — Expo 51 with an
   Expo 57 runtime, React 18 with React 19 types, and `typescript: ~6.0.3`,
   which does not exist. Pinned to a coherent SDK 54 set, matching the
   version of Expo Go currently on the Play Store.
8. **Cross-tenant idempotency collision — silent data loss.** The ingest
   idempotency cache was global, and the connector derives its key from batch
   contents. Two businesses producing an identical batch collided: the second
   got a replayed `200`, its data was never written, **and its sync cursor
   advanced past it**. Caught by running two real customers against the same
   Tally. Keys are now scoped `orgId:connectorId:key` server-side — a client
   key must never be trusted to be globally unique.
9. **A new phone number silently got an org named "My Business."** A default
   that looks like a real answer is worse than no answer. Accounts now start
   unnamed and the owner names the business as step one.

---

## Next: P1 — make the ingest real

The connector produces the exact NDJSON that `POST /v1/ingest` expects. Replace
the in-memory sink with an HTTP one and make the API actually store it.

In order:

1. `packages/db` — migrations, FY partitions on `vouchers`, indexes, RLS
   (spec: [05-database-schema.md](05-database-schema.md))
2. `apps/api` `ingest` — `COPY` into staging, upsert on `(company_id, guid)`,
   idempotency keys, real cursors in the response
   (spec: [06-api-contract.md](06-api-contract.md), prompt 4)
3. `connector/internal/api` — HTTP sink, pairing, device token, heartbeat
4. `connector/internal/spool` — BoltDB offline queue (currently the connector
   has no offline resilience)
5. Rollup worker → `daily_sales`, `company_snapshot`, `bills` (prompt 6)

The `SummarySink` in `internal/sync/sink.go` already computes the same figures
the dashboard will compute in SQL. Use it as the oracle: if the API's numbers
disagree with it on the same data, the API is wrong.

---

## Still missing from P0 itself

Small, but do them before calling the connector shippable:

- [ ] Nightly deletion reconcile — the request template exists
      (`ReconcileRequest`), the loop that calls it does not
- [ ] BoltDB for cursors — the JSON file can be truncated by a power cut
- [ ] Offline spool with backoff
- [ ] `testdata/` fixtures recorded from a **real** Tally (both versions)
- [ ] Code signing for `dist/munim-connector.exe`
