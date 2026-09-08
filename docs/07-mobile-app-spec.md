# 07 — Mobile App Spec

Expo React Native. This is the product the customer sees; everything else is
plumbing.

---

## Navigation

```
Auth stack
  Phone entry → OTP → (first run) Pair connector → Select companies
Main tabs
  ┌ Dashboard ┬ Outstanding ┬ Reports ┬ More ┐
  │ Home      │ Receivable  │ Sales   │ Sync │
  │           │ Payable     │ Items   │ Users│
  │           │             │ Parties │ Plan │
  └───────────┴─────────────┴─────────┴──────┘
Company switcher: header dropdown, persists last choice
```

---

## Screens

### 1. Dashboard (the screen that sells the app)
- **4 tiles**: Sales (MTD + % vs last month), Receivables, Payables, Cash in Hand.
- **Sales trend**: 30-day bar/line.
- **Top selling items**: top 5 this month.
- **Recent invoices**: last 8, tap → voucher detail.
- **Sync banner**: green "Synced 2 min ago" / amber "Tally PC offline 4 h" with a
  Fix-it link explaining the actual reason.
- Pull-to-refresh.

### 2. Outstanding
- Toggle Receivable / Payable.
- Aging summary strip: `0-30 | 31-60 | 61-90 | 90+`, tap to filter.
- Party list sorted by overdue amount: name, total, oldest-days badge.
- Party detail → bill-wise list → **Remind** button (WhatsApp / SMS / Call).
- Search by party name.

### 3. Party / ledger detail
- Closing balance, credit limit/days, phone, GSTIN.
- Statement: date, particulars, debit, credit, running balance.
- Actions: Call · WhatsApp · Send reminder · Share statement PDF.

### 4. Reports
Sales analysis (by month/party/item), Top items, Inactive parties (no
transaction in N days), Voucher search by number/party/amount.

### 5. More
Sync status & connector health · Companies · Users & roles · Subscription &
credits · Backup history · Support (WhatsApp us) · Logout.

---

## Non-negotiable behaviours

| Behaviour | Why |
|---|---|
| **SQLite cache + stale-while-revalidate** | App opens showing last data instantly, then refreshes. Never a blank spinner on a shop's 3G |
| **Every screen shows data freshness** | "As of 10:42 AM". Accounting users must trust the number, and trust needs a timestamp |
| **Indian number formatting** | ₹25,48,000 — lakh/crore grouping, not 2,548,000. Use `Intl` with `en-IN` |
| **Amount privacy toggle** | One tap hides all figures. Owners open this app in front of staff and customers |
| **Deep links** | `munim://company/:id/party/:ledgerId` for notification taps |
| **OTA updates via EAS Update** | Ship fixes without store review |
| **Sentry + breadcrumbs** | Crashes are data-shape-specific and you cannot reproduce them locally |

---

## State & data layer

```
TanStack Query        server cache, retries, background refetch
Expo SQLite           offline persistence of last dashboard/outstanding payload
Zustand               UI state only (selected company, privacy toggle)
Zod (packages/shared) validate every API response — Tally data is messy and a
                      bad payload should degrade one card, not white-screen the app
```

Query keys: `['dashboard', companyId]`, `['outstanding', companyId, kind]`.
Invalidate on pull-to-refresh and on a sync-complete push.

---

## Performance budget

- Cold start to first meaningful paint: **< 1.5 s** (from cache).
- Outstanding list with 2,000 parties: **60 fps** → `FlashList`, never `.map()`.
- Dashboard payload: **< 40 KB** gzipped.
- No image assets over 100 KB.

---

## Design direction

Match the category's visual language (see the competitor comparison that started
this project): green accent for positive/primary, red for overdue, generous white
space, large numbers, icon + label rows.

- Type scale: 28/20/16/14/12. Numbers in tabular figures so columns align.
- One accent colour, one danger colour. No gradients on data.
- Tap targets ≥ 44 px — the users are 45-year-old shop owners, not designers.
- Dark mode: phase 2, but pick colours through tokens from day one.

---

## Push notifications

Expo Notifications. Three types only — more and users disable them all:
1. **Daily digest** (8 AM): "Yesterday's sales ₹1,24,000 · ₹4.2L overdue"
2. **Sync broken > 6 h**: "Munim can't reach your Tally PC"
3. **Payment received** against an overdue bill

---

## Release checklist

- [ ] Works on a 2 GB RAM Android 10 device
- [ ] Handles company with 0 vouchers (empty states, not crashes)
- [ ] Handles company with 400k vouchers (no OOM on statement screens)
- [ ] Airplane-mode open shows cached data + clear offline banner
- [ ] Play Store data-safety form filled honestly (you store financial data)
- [ ] Privacy policy + terms URLs live before submission
