# 05 — Database Schema

PostgreSQL 17. Defined with Drizzle in `packages/db/`.
Design principles: **every row is tenant-scoped**, **raw Tally payload is kept**,
**reports never read raw vouchers**.

---

## Tenancy & identity

```sql
orgs (
  id              uuid pk,
  name            text not null,
  plan            text not null default 'trial',   -- trial|basic|pro|business
  trial_ends_at   timestamptz,
  created_at      timestamptz default now()
)

users (
  id          uuid pk,
  org_id      uuid references orgs,
  phone       text not null unique,       -- E.164, the identity
  name        text,
  role        text not null,              -- owner|accountant|staff
  last_seen_at timestamptz
)

-- staff can be restricted to specific companies
user_company_access (user_id, company_id, can_view_amounts bool)

connectors (
  id            uuid pk,
  org_id        uuid references orgs,
  machine_name  text,
  tally_version text,                     -- 'erp9' | 'prime-4.1' ...
  token_hash    text not null,            -- Argon2id, token shown once
  last_seen_at  timestamptz,
  app_version   text,
  status        text                      -- ok|tally_down|no_company|stale
)

companies (
  id                    uuid pk,
  org_id                uuid references orgs,
  connector_id          uuid references connectors,
  tally_guid            text not null,
  name                  text not null,
  fy_start              date,
  last_master_alterid   bigint default 0,
  last_voucher_alterid  bigint default 0,
  last_reconciled_at    timestamptz,
  unique (org_id, tally_guid)
)
```

---

## Masters

```sql
groups (
  id uuid pk, company_id uuid, guid text, name text,
  parent text, primary_group text,        -- resolved root: Sundry Debtors etc.
  alter_id bigint,
  unique (company_id, guid)
)

ledgers (
  id uuid pk, company_id uuid, guid text,
  name text, parent_group text, primary_group text,
  opening_bal numeric(18,2), closing_bal numeric(18,2),
  phone text, mobile text, email text,
  gstin text, credit_days int,
  is_deleted bool default false,
  alter_id bigint,
  unique (company_id, guid)
)

stock_items (
  id uuid pk, company_id uuid, guid text, name text,
  unit text, closing_qty numeric(18,3), closing_value numeric(18,2),
  is_deleted bool default false, alter_id bigint,
  unique (company_id, guid)
)

voucher_types (id uuid pk, company_id uuid, guid text, name text, parent text)
-- users rename/create voucher types. NEVER hardcode the string 'Sales'.
```

---

## Transactions

```sql
vouchers (
  id              uuid,
  company_id      uuid not null,
  guid            text not null,
  vch_no          text,
  vch_type        text,          -- raw name
  vch_type_parent text,          -- normalized: Sales|Purchase|Receipt|Payment...
  vch_date        date not null,
  party_ledger_id uuid,
  party_name      text,
  amount          numeric(18,2),
  narration       text,
  is_cancelled    bool default false,
  is_optional     bool default false,
  is_deleted      bool default false,
  alter_id        bigint,
  raw             jsonb,         -- the parsed Tally payload, verbatim
  synced_at       timestamptz default now(),
  primary key (company_id, vch_date, guid)
) PARTITION BY RANGE (vch_date);
-- one partition per financial year: vouchers_fy2025, vouchers_fy2026 ...

voucher_ledger_entries (
  voucher_guid text, company_id uuid, ledger_id uuid,
  ledger_name text, amount numeric(18,2), is_deemed_positive bool
)

voucher_inventory_entries (
  voucher_guid text, company_id uuid, stock_item_id uuid,
  item_name text, qty numeric(18,3), rate numeric(18,2), amount numeric(18,2)
)

bills (                                   -- bill-wise outstanding
  id uuid pk, company_id uuid,
  ledger_id uuid, party_name text,
  bill_ref text, bill_date date, due_date date,
  opening_amt numeric(18,2),
  pending_amt numeric(18,2),
  kind text,                              -- receivable|payable
  unique (company_id, ledger_id, bill_ref)
)
```

**Why keep `raw jsonb`?** When you discover in month 6 that you needed a field
you never mapped, you can backfill from stored payloads instead of asking every
customer to re-sync 5 years of data. It costs disk; it saves the company.

---

## Rollups — the performance layer

Reports read **only** these. Recomputed by a BullMQ job when ingest touches a date.

```sql
daily_sales (
  company_id uuid, day date,
  sales_amt numeric(18,2), purchase_amt numeric(18,2),
  receipt_amt numeric(18,2), payment_amt numeric(18,2),
  vch_count int,
  primary key (company_id, day)
)

daily_ledger_bal (
  company_id uuid, ledger_id uuid, day date,
  closing numeric(18,2),
  primary key (company_id, ledger_id, day)
)

item_sales_monthly (
  company_id uuid, month date, stock_item_id uuid,
  qty numeric(18,3), amount numeric(18,2),
  primary key (company_id, month, stock_item_id)
)

company_snapshot (                        -- one row per company, the dashboard
  company_id uuid pk,
  cash_in_hand numeric(18,2), bank_balance numeric(18,2),
  total_receivable numeric(18,2), total_payable numeric(18,2),
  sales_mtd numeric(18,2), sales_prev_mtd numeric(18,2),
  computed_at timestamptz
)
```

---

## Reminders & billing

```sql
reminders (
  id uuid pk, company_id uuid, ledger_id uuid, bill_id uuid,
  channel text,                -- whatsapp|sms|email
  template_key text,
  status text,                 -- queued|sent|delivered|read|failed
  provider_msg_id text, error text,
  sent_at timestamptz, updated_at timestamptz
)

reminder_rules (
  id uuid pk, company_id uuid, enabled bool,
  days_after_due int[], channels text[], send_at time, template_key text
)

subscriptions (
  id uuid pk, org_id uuid, company_count int, plan text,
  razorpay_sub_id text, status text, current_period_end timestamptz
)

message_credits (org_id uuid, balance int, updated_at timestamptz)
credit_ledger (id uuid pk, org_id uuid, delta int, reason text, at timestamptz)

audit_log (id uuid pk, org_id uuid, user_id uuid, action text,
           entity text, meta jsonb, at timestamptz)
```

---

## Indexes that actually matter

```sql
CREATE UNIQUE INDEX ON vouchers (company_id, guid);
CREATE INDEX ON vouchers (company_id, vch_date DESC)
       INCLUDE (amount, vch_type_parent) WHERE is_deleted = false;
CREATE INDEX ON vouchers (company_id, party_ledger_id, vch_date DESC);
CREATE INDEX ON vouchers (company_id, alter_id);

-- partial index: only unpaid bills are ever queried
CREATE INDEX ON bills (company_id, kind, due_date) WHERE pending_amt > 0;
CREATE INDEX ON bills (company_id, ledger_id)      WHERE pending_amt > 0;

CREATE INDEX ON ledgers (company_id, alter_id);
CREATE INDEX ON ledgers USING gin (name gin_trgm_ops);   -- party search
CREATE INDEX ON reminders (company_id, status, sent_at DESC);
```

---

## Row-Level Security — the second net

App code filters by `org_id`. RLS makes a missed filter *impossible*, not just
unlikely. One forgotten `WHERE org_id = ?` in a report query is a cross-tenant
data leak of accounting records — enable RLS on every tenant table.

```sql
ALTER TABLE vouchers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vouchers
  USING (company_id IN (SELECT id FROM companies
                        WHERE org_id = current_setting('app.org_id')::uuid));
-- API sets  SET LOCAL app.org_id = '<uuid>'  at the start of every transaction.
```

---

## Migration rules

- Drizzle migrations only, checked into git, never edited after merge.
- Every migration must be **backward-compatible for one release** — old API
  instances run against the new schema during a rolling deploy.
- Create next year's voucher partition via a scheduled job, not by hand.
