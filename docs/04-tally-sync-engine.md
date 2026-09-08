# 04 — Tally Sync Engine ⭐

**This is the most important document in the repo.** Read it fully before
writing connector code. Every competitor's bug reports live in this file's
subject matter.

---

## 1. How Tally exposes data

Tally Prime / ERP 9 has a built-in HTTP server. The user enables it:

```
Tally Prime:  F1 → Settings → Connectivity → Client/Server config
              "Act as" = Server,  Port = 9000
Tally ERP 9:  F12 → Advanced Configuration → Tally.ERP 9 is acting as = Server
```

You then `POST` an XML `<ENVELOPE>` to `http://localhost:9000` and get XML back.
There is **no authentication** on this port — which is exactly why the connector
must run locally on that PC and never be exposed to the network.

Three request styles exist. Use **Collection + TDL**, because only it supports
server-side filtering (which is what makes incremental sync possible).

---

## 2. Core requests

### 2.1 List companies

```xml
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>ListOfCompanies</ID>
  </HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVIsSimpleCompany>No</SVIsSimpleCompany>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="ListOfCompanies" ISINITIALIZE="Yes">
        <TYPE>Company</TYPE>
        <NATIVEMETHOD>Name,StartingFrom,EndingAt,GUID</NATIVEMETHOD>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>
```

### 2.2 Ledgers changed since cursor  ← the incremental pattern

```xml
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE><ID>MunimLedgers</ID>
  </HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>{{COMPANY_NAME}}</SVCURRENTCOMPANY>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="MunimLedgers" ISMODIFY="No">
        <TYPE>Ledger</TYPE>
        <NATIVEMETHOD>Name,Parent,OpeningBalance,ClosingBalance,
          LedgerPhone,LedgerMobile,Email,BillCreditPeriod,
          PartyGSTIN,AlterID,GUID,IsDeemedPositive</NATIVEMETHOD>
        <FILTER>MunimAlterFilter</FILTER>
      </COLLECTION>
      <SYSTEM TYPE="Formulae" NAME="MunimAlterFilter">
        $AlterID &gt; {{LAST_MASTER_ALTERID}}
      </SYSTEM>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>
```

### 2.3 Vouchers changed since cursor (with bill allocations)

Same shape with `<TYPE>Voucher</TYPE>` and:

```xml
<NATIVEMETHOD>Date,VoucherTypeName,VoucherNumber,PartyLedgerName,
  Narration,Amount,IsCancelled,IsOptional,AlterID,GUID,
  PersistedView,Reference,ReferenceDate</NATIVEMETHOD>
<FETCH>AllLedgerEntries,LedgerEntries,AllInventoryEntries,BillAllocations</FETCH>
<FILTER>MunimAlterFilter</FILTER>
```

`<FETCH>` is what pulls the nested child collections — without it you get a
voucher header with no line items.

### 2.4 Others you need
| Data | `<TYPE>` | Notes |
|---|---|---|
| Groups | `Group` | Needed to classify Sundry Debtors/Creditors |
| Stock items | `StockItem` | `ClosingBalance`, `ClosingValue` |
| Voucher types | `VoucherType` | Users create custom sales types — never hardcode "Sales" |
| Cost centres | `CostCentre` | Post-MVP |

---

## 3. The sync loop

```
STATE (per company, stored locally in BoltDB + mirrored server-side):
  { lastMasterAlterId, lastVoucherAlterId, lastFullReconcileAt }

every 30s per company:
  1. health check   → is Tally up? is the same company loaded?
  2. pull masters   → $AlterID > lastMasterAlterId    (groups, ledgers, items)
  3. pull vouchers  → $AlterID > lastVoucherAlterId
  4. sanitize → parse → normalize → batch(500)
  5. gzip + POST /v1/ingest with Idempotency-Key
  6. on 200: advance cursors, persist to Bolt
     on 5xx/offline: append batch to spool, exponential backoff
  nightly 02:00: reconcile pass (section 6)
```

**Never advance the cursor before the server confirms.** Cursor-then-crash is
how you silently lose a day of vouchers, and the customer will only notice at
month end.

---

## 4. ALTERID — read this twice

Every master and voucher in Tally carries `AlterID`, a monotonically increasing
integer bumped on every create/modify. It is your sync cursor.

- **Masters and vouchers have separate AlterID sequences.** Track two cursors.
- AlterID is **per company**, not global.
- On first pair, cursor = 0 → this is your full initial sync. Chunk it by date
  range (financial year at a time) or a 5-year company will time out.
- If the customer **restores a backup or rewrites the company**, AlterIDs can go
  *backwards*. Detect it: if `maxAlterId(Tally) < ourCursor`, reset to 0 and
  trigger a full resync. Log it loudly.
- Do **not** use `LastModified` dates as a cursor. They are unreliable across
  Tally versions.

---

## 5. Tally XML is not valid XML — sanitize before parsing

You will hit all of these on real customer data:

| Problem | Fix |
|---|---|
| Control characters like `&#4;` `&#5;` (Tally's internal field separators) | Strip bytes `0x00–0x08`, `0x0B`, `0x0C`, `0x0E–0x1F` **before** the parser |
| CP-1252 / ISO-8859-1 bytes claiming to be UTF-8 (₹, é, smart quotes) | Detect and transcode to UTF-8 |
| Unescaped `&` in ledger names ("R & K Traders") | Regex-repair bare `&` → `&amp;` |
| `&#160;` non-breaking spaces inside amounts | Normalize whitespace before number parse |
| Amounts as `"-1,25,000.00"` (Indian grouping, sign, currency symbol) | Custom parser — `parseFloat` returns garbage |
| Empty response body when no records match the filter | Treat as "0 changes", not an error |
| An HTML error page returned instead of XML | Content sniff before parse |

> Write the sanitizer as its own package with a table-driven test suite, and add
> every weird byte sequence you meet in production as a new test case. This file
> will save you more support hours than any other.

---

## 6. Deletions — the silent data-corruption bug

**Deleted vouchers do not appear in AlterID deltas.** If a user deletes an
invoice, your cloud keeps showing it forever, the customer sees wrong
receivables, and they cancel their subscription.

Nightly reconcile, per company:

```
for each month in the last 24 months:
    ask Tally  → list of {GUID, AlterID} for vouchers in that month
    compare    → our GUIDs for the same month
    missing in Tally  → soft-delete (is_deleted = true), recompute rollups
    extra in Tally    → repair-fetch those GUIDs
```

Fetch only GUIDs (not full vouchers) so this stays cheap.
Do the same for masters, weekly.

---

## 7. Offline resilience

The Tally PC will lose internet. Design for it:

- Local **BoltDB spool** of pending batches, capped (e.g. 500 MB / 7 days).
- Exponential backoff: 30 s → 1 m → 5 m → 15 m → 30 m (cap).
- Drain the spool in strict order before pulling anything new.
- Surface connector health in the app: *"Last synced 4 hours ago"* with a
  reason (Tally closed / no internet / company not loaded). Users blame your
  app for their unplugged router unless you tell them.

---

## 8. Tally version differences

Detect at pair time, store `tally_version` on the connector row, and keep
per-version XML templates in `connector/internal/tally/templates/`.

| Concern | ERP 9 | Prime 3.x / 4.x / 5.x |
|---|---|---|
| GUID on vouchers | Present, format varies | Stable |
| GST fields | Add-on / absent in old builds | Native |
| Some collection names | Legacy names | Renamed |
| Unicode handling | Weaker | Better |
| Default port | 9000 | 9000 |

Never assume a field exists. Missing field → `null`, never a crash.

---

## 9. Testing without Tally

Build `mock-tally/` — a small HTTP server on port 9000 that:

- answers the same Collection requests with realistic XML,
- **honours the `$AlterID >` filter** so incremental logic is genuinely tested,
- can be told to inject faults: malformed bytes, truncated response, timeout,
  company-not-loaded error, AlterID reset.

Then record real responses from a real Tally into `testdata/` fixtures
(anonymised) and replay them in CI. This is how you keep the sanitizer honest.

---

## 10. Definition of done for the sync engine

- [ ] Pairs, discovers companies, full-syncs a 2-year company
- [ ] Incremental sync moves only changed records (verified: edit one voucher in
      Tally → exactly one record ingested)
- [ ] Survives Tally being closed mid-sync
- [ ] Survives network loss for 1 hour, then drains spool with no gaps and no
      duplicates
- [ ] Detects and handles a deleted voucher within 24 h
- [ ] Detects AlterID reset after a backup restore
- [ ] Parses a company with `& < > ₹` and regional characters in ledger names
- [ ] Runs as a Windows service, auto-starts on boot, auto-updates itself
- [ ] Memory stays flat over a 24 h soak test
