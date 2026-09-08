-- The partner programme.
--
-- Tally is sold through a dealer network in India, and those dealers are
-- already inside their customers' books every month. They are the distribution
-- channel for this product, and a channel needs to be able to see what it has
-- sold and what it is owed without asking.

CREATE TABLE IF NOT EXISTS partners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A partner signs in as a person, like everybody else. This is the business
  -- they represent, not their login.
  name          text NOT NULL,
  -- The code that goes in a referral link. Short, human-readable, and unique.
  code          text NOT NULL,
  contact_name  text NOT NULL DEFAULT '',
  email         text NOT NULL,
  phone         text NOT NULL DEFAULT '',
  city          text NOT NULL DEFAULT '',
  state         text NOT NULL DEFAULT '',
  gstin         text NOT NULL DEFAULT '',
  pan           text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'active', 'paused', 'rejected')),
  -- Basis points, so 20% is 2000 and there is no float anywhere near money.
  commission_bps int NOT NULL DEFAULT 2000,
  -- How many months of a customer's subscription a partner earns on. NULL means
  -- for as long as the customer pays, which is what a real channel expects.
  commission_months int,
  -- Bank details for payouts. Stored, never shown back in full.
  bank_name     text NOT NULL DEFAULT '',
  bank_account  text NOT NULL DEFAULT '',
  bank_ifsc     text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  applied_at    timestamptz NOT NULL DEFAULT now(),
  approved_at   timestamptz,
  approved_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS partners_code_uniq ON partners (lower(code));
CREATE UNIQUE INDEX IF NOT EXISTS partners_email_uniq ON partners (lower(email));

-- Which people can sign in and see a partner's dashboard.
--
-- Separate from users.org_id: a partner is often also a Munim customer for
-- their own shop, and those are two different hats on one person.
CREATE TABLE IF NOT EXISTS partner_users (
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, user_id)
);

-- A business a partner introduced.
--
-- Not a foreign key from orgs, because a lead exists before the customer does -
-- that is the whole point of tracking one.
CREATE TABLE IF NOT EXISTS partner_leads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id   uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  business     text NOT NULL,
  contact_name text NOT NULL DEFAULT '',
  phone        text NOT NULL DEFAULT '',
  email        text NOT NULL DEFAULT '',
  city         text NOT NULL DEFAULT '',
  notes        text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'new'
               CHECK (status IN ('new', 'contacted', 'demo', 'trial', 'won', 'lost')),
  -- Filled in when the lead becomes a real account.
  org_id       uuid REFERENCES orgs(id) ON DELETE SET NULL,
  lost_reason  text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_leads_idx ON partner_leads (partner_id, status);

-- Which partner introduced which account.
--
-- On orgs rather than in a join table: an account has exactly one introducing
-- partner, for ever, and two partners claiming the same customer is a dispute
-- the schema should make impossible rather than a report somebody reconciles.
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS partner_id uuid REFERENCES partners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS partner_at timestamptz;

CREATE INDEX IF NOT EXISTS orgs_partner_idx ON orgs (partner_id)
  WHERE partner_id IS NOT NULL;

-- What a partner earned on one payment.
--
-- A row per payment rather than a running total, because "why is my commission
-- this figure" has to be answerable line by line or nobody trusts it.
CREATE TABLE IF NOT EXISTS commissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id   uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  org_id       uuid REFERENCES orgs(id) ON DELETE SET NULL,
  -- Kept as text too, so a commission line survives the customer leaving.
  org_name     text NOT NULL DEFAULT '',
  payment_id   uuid REFERENCES payments(id) ON DELETE SET NULL,
  -- The money the commission was computed from, and the rate at the time.
  base_paise   bigint NOT NULL DEFAULT 0,
  rate_bps     int NOT NULL DEFAULT 0,
  amount_paise bigint NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'paid', 'reversed')),
  payout_id    uuid,
  earned_at    timestamptz NOT NULL DEFAULT now(),
  note         text NOT NULL DEFAULT ''
);

-- One commission per payment per partner. A webhook replay or a re-run of the
-- earning job must never pay twice.
CREATE UNIQUE INDEX IF NOT EXISTS commissions_payment_uniq
  ON commissions (partner_id, payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commissions_partner_idx
  ON commissions (partner_id, status, earned_at DESC);

CREATE TABLE IF NOT EXISTS payouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id    uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  amount_paise  bigint NOT NULL DEFAULT 0,
  lines         int NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'sent', 'failed')),
  reference     text NOT NULL DEFAULT '',
  period_from   timestamptz,
  period_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  note          text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS payouts_partner_idx ON payouts (partner_id, created_at DESC);
