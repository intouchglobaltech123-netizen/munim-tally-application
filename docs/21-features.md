# 21 — Feature Set

Built to match what [Livekeeping](https://apps.apple.com/in/app/livekeeping/id1451277319)
ships, plus the things it does not.

---

## Dashboard — the 360 view

| Metric | Source |
|---|---|
| **Sales this month** with % vs last month | vouchers of a Sales type |
| **Purchases this month** | vouchers of a Purchase type |
| **Receivables** + overdue | Sundry Debtors closing balances |
| **Payables** | Sundry Creditors |
| **Cash in hand** · **Bank balance** · **Stock in hand** | the matching Tally groups |
| **Sales trend** — last 30 days with sales | daily rollup |
| **Receivables ageing** — 0-30 / 31-60 / 61-90 / 90+ | bill-wise, netted |
| **Top selling items** | inventory entries on sales |
| **Outstanding by party** | debtor balances, highest first |
| **Recent vouchers** | newest 8 |
| **Sync freshness** on every screen | connector heartbeat |

"This month" means the latest month **present in the books**, not the calendar
month — a shop that has not billed since March still sees March.

---

## Reports

| Report | What it answers |
|---|---|
| **Day Book** | Everything posted on one day, totalled by voucher type |
| **Trial Balance** | Group-wise debit/credit, and whether it balances |
| **Profit & Loss** | Income less expenses |
| **Balance Sheet** | Assets against liabilities, profit carried in |
| **Sales Analysis** | By month, by party or by item |
| **Party-wise** | Sales and purchases per party, with last transaction |
| **Outstanding** | Bill-wise, ageing buckets, drill-down per party |
| **Ledger statement** | Running balance, reconciled to the closing figure |
| **Inactive** | Customers and items gone quiet — the call list |
| **Stock summary** | Quantity and value on hand |
| **Expenses** | Largest first |

### Two that are easy to get wrong

**Trial Balance excludes "Profit & Loss A/c".** Tally maintains that ledger
itself and it mirrors the income groups; counting both double-counts the profit
and the statement never balances. Verified balanced against real Tally.

**Ageing needs a due date, and Tally does not export one.** The bill's credit
period is not echoed back in the voucher export, so `effective_due()` falls back
to the party's agreed credit terms and then to the bill date — which is what an
accountant does with an invoice that states no terms.

---

## Outstanding, done properly

A sale raises a bill (`New Ref`); a receipt settles it (`Agst Ref`). Bills are
**netted per reference**, so a payment reduces what is owed.

Storing every allocation as a positive amount — the obvious mistake — makes a
payment *increase* the debt, and outstanding then grows past the ledger balance
it is supposed to explain.

---

## Same features on phone and web

Both apps are built against the same endpoints, so an owner and their
accountant never learn two products.

| Screen | Mobile | Web |
|---|---|---|
| Dashboard — the 360 view | ✅ | ✅ |
| Outstanding + bill drill-down | ✅ | ✅ |
| Ledger statement | ✅ | ✅ |
| **Reports** (all nine) | ✅ | ✅ |
| **Linked devices** + revoke | ✅ | ✅ |
| Reminders | ✅ | ✅ |
| Link Tally by QR | ✅ camera | shows steps |
| Admin console | — | ✅ staff only |

Two things the phone does that the browser cannot:

- **Privacy toggle** — one tap masks every figure, on reports too. Owners open
  this in front of staff and customers.
- **Camera pairing** — scanning the PC's QR is the whole linking flow.

On a phone a bar list beats a chart: the label matters as much as the value,
and both stay readable at 360px.

---

## Linked devices

Not in Livekeeping, and it should be.

- Every **Tally computer**: machine, Tally version, connector version, when it
  was linked, when it last reported
- Every **phone or browser signed in**, with the current one marked
- **Unlink / sign out remotely** — a shop PC that was sold, stolen or replaced
  stops syncing without anyone travelling to it

Revoking breaks the stored token hash server-side, so the connector must be
re-paired. Verified: ingest returns **401** immediately after.

---

## Pairing, and why it costs nothing

The PC shows a QR; the already-signed-in phone approves it. **The computer never
handles the owner's phone number or any credential of theirs** — it receives a
device token scoped to ingest and heartbeat, which cannot read a single report.

A customer with three shop computers still costs **one SMS**, because only the
phone ever authenticates.

---

## Deliberately not built

| | Why |
|---|---|
| Creating vouchers / invoices from mobile | Needs write access to Tally. The read-only guarantee is a trust argument that closes sales — and it is enforced by a test |
| E-way bill / e-invoice | Regulated, needs GSP partnership. A later phase of the company |
| GPS sales tracking, punch in/out | A field-force product wearing an accounting product's clothes |
| Cost centres | Few SMBs configure them |

---

## Credentials

| Token | Held by | Can do |
|---|---|---|
| Device token | Connector on the Tally PC | ingest + heartbeat. **Cannot read reports** |
| Access token | Phone / web | that org's data only |
| Access token + `platform_admin` | You | cross-tenant admin routes |

Verified against the live database:

| Test | Result |
|---|---|
| Customer reads another business's dashboard | **404** |
| Customer opens the admin console | **403** |
| Device token on a report route | **401** |
| User token on ingest | **401** |
| Revoked connector ingests | **401** |
| No token | **401** |

Sources: [App Store listing](https://apps.apple.com/in/app/livekeeping/id1451277319) ·
[Google Play](https://play.google.com/store/apps/details?id=com.finlitetech.livekeeping&hl=en_IN)
