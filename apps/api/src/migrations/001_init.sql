-- Munim schema. See docs/05-database-schema.md.
--
-- Money is BIGINT paise everywhere. Never numeric-as-float, never rupees: a
-- float rupee value accumulates error across a 400k-voucher aggregation, and an
-- accounting product that is off by a paisa is one nobody trusts.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- tenancy --

CREATE TABLE orgs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL until the owner names the business. A silent default like
  -- "My Business" is worse than nothing: it looks like a real answer.
  name            text,
  plan            text NOT NULL DEFAULT 'trial',
  trial_ends_at   timestamptz NOT NULL DEFAULT now() + interval '14 days',
  message_credits integer NOT NULL DEFAULT 100 CHECK (message_credits >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  phone        text NOT NULL UNIQUE,          -- E.164, the identity
  name         text NOT NULL DEFAULT '',
  role         text NOT NULL DEFAULT 'owner'
               CHECK (role IN ('owner','accountant','staff','platform_admin')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE INDEX ON users (org_id);

-- Sessions live in the database so signing out actually revokes access, and so
-- a restart does not log every customer out.
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,                -- sha256 of the bearer token
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX ON sessions (user_id);

CREATE TABLE otp_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- Supports the per-phone rate limit without a table scan.
CREATE INDEX ON otp_requests (phone, created_at DESC);

-- ------------------------------------------------------------- connectors --

-- A pairing intent: the PC shows a code, the signed-in phone approves it.
-- The PC never handles the owner's phone number or any credential of theirs.
CREATE TABLE pair_intents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text NOT NULL UNIQUE,
  org_id            uuid REFERENCES orgs(id) ON DELETE CASCADE,
  approved_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  connector_id      uuid,
  device_token_once text,                     -- handed over exactly once
  approved_at       timestamptz,
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connectors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  machine_name  text NOT NULL DEFAULT '',
  tally_version text NOT NULL DEFAULT 'prime',
  app_version   text NOT NULL DEFAULT '',
  token_hash    text NOT NULL UNIQUE,         -- sha256; the token itself is never stored
  status        text NOT NULL DEFAULT 'ok',
  tally_up      boolean NOT NULL DEFAULT true,
  last_error    text NOT NULL DEFAULT '',
  paired_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);
CREATE INDEX ON connectors (org_id);

-- -------------------------------------------------------------- companies --

CREATE TABLE companies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  tally_guid   text NOT NULL,
  name         text NOT NULL,
  fy_start     text NOT NULL DEFAULT '',
  -- Books found on the owner's own PC are the owner's own books, so they sync
  -- by default. They can be paused from the app afterwards.
  enabled      boolean NOT NULL DEFAULT true,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_sync_at timestamptz,
  -- A Tally GUID is only unique within one installation: two customers can
  -- restore the same backup and share one. Scope it to the org.
  UNIQUE (org_id, tally_guid)
);

-- ----------------------------------------------------------------- ledger --

CREATE TABLE ledgers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  guid          text NOT NULL,
  name          text NOT NULL,
  parent_group  text NOT NULL DEFAULT '',
  opening_paise bigint NOT NULL DEFAULT 0,
  closing_paise bigint NOT NULL DEFAULT 0,
  phone         text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  gstin         text NOT NULL DEFAULT '',
  credit_days   integer NOT NULL DEFAULT 0,
  alter_id      bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, guid)
);
CREATE INDEX ON ledgers (company_id, parent_group);
CREATE INDEX ledgers_name_trgm ON ledgers USING gin (name gin_trgm_ops);

CREATE TABLE stock_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  guid                text NOT NULL,
  name                text NOT NULL,
  unit                text NOT NULL DEFAULT '',
  closing_qty         double precision NOT NULL DEFAULT 0,
  closing_value_paise bigint NOT NULL DEFAULT 0,
  alter_id            bigint NOT NULL DEFAULT 0,
  UNIQUE (company_id, guid)
);

CREATE TABLE vouchers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  guid          text NOT NULL,
  vch_no        text NOT NULL DEFAULT '',
  vch_type      text NOT NULL DEFAULT '',
  vch_date      date,
  party         text NOT NULL DEFAULT '',
  amount_paise  bigint NOT NULL DEFAULT 0,
  narration     text NOT NULL DEFAULT '',
  is_cancelled  boolean NOT NULL DEFAULT false,
  is_optional   boolean NOT NULL DEFAULT false,
  alter_id      bigint NOT NULL DEFAULT 0,
  -- The parsed payload, verbatim. Costs disk; saves the company when you
  -- discover in month six that you never mapped a field you now need.
  raw           jsonb,
  synced_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, guid)
);
CREATE INDEX ON vouchers (company_id, vch_date DESC);
CREATE INDEX ON vouchers (company_id, party);
CREATE INDEX ON vouchers (company_id, alter_id);

CREATE TABLE voucher_entries (
  voucher_id   uuid NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  ledger_name  text NOT NULL,
  amount_paise bigint NOT NULL
);
CREATE INDEX ON voucher_entries (voucher_id);
CREATE INDEX ON voucher_entries (ledger_name);

CREATE TABLE voucher_items (
  voucher_id   uuid NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  item_name    text NOT NULL,
  qty          double precision NOT NULL DEFAULT 0,
  rate_paise   bigint NOT NULL DEFAULT 0,
  amount_paise bigint NOT NULL DEFAULT 0
);
CREATE INDEX ON voucher_items (voucher_id);

CREATE TABLE bills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  voucher_id    uuid NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  ref           text NOT NULL,
  party         text NOT NULL DEFAULT '',
  bill_date     date,
  due_date      date,
  amount_paise  bigint NOT NULL DEFAULT 0,
  UNIQUE (voucher_id, ref)
);
-- Outstanding screens only ever read rows with money still on them.
CREATE INDEX bills_open ON bills (company_id, due_date) WHERE amount_paise > 0;
CREATE INDEX ON bills (company_id, party);

-- ------------------------------------------------------------ sync cursor --

CREATE TABLE sync_cursors (
  company_id      uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  master_alter_id bigint NOT NULL DEFAULT 0,
  voucher_alter_id bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Idempotency is scoped to the CONNECTOR. The connector derives its key from
-- batch contents, so two businesses whose books produce an identical batch
-- would otherwise collide - the second would get a replayed 200, its data
-- would be dropped, and its cursor would advance past it. Silent data loss.
CREATE TABLE ingest_keys (
  connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  key          text NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, key)
);
CREATE INDEX ON ingest_keys (created_at);

-- -------------------------------------------------------------- reminders --

CREATE TABLE reminders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id   uuid REFERENCES companies(id) ON DELETE SET NULL,
  party        text NOT NULL,
  phone        text NOT NULL DEFAULT '',
  amount_paise bigint NOT NULL DEFAULT 0,
  channel      text NOT NULL DEFAULT 'whatsapp',
  status       text NOT NULL DEFAULT 'queued',
  provider_id  text NOT NULL DEFAULT '',
  error        text NOT NULL DEFAULT '',
  sent_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON reminders (org_id, sent_at DESC);

CREATE TABLE audit_log (
  id      bigserial PRIMARY KEY,
  org_id  uuid,
  user_id uuid,
  action  text NOT NULL,
  meta    jsonb,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (org_id, at DESC);
