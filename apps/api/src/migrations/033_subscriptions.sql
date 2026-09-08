-- Subscriptions, payments and the GST invoices for them.
--
-- Money, so integers everywhere and no floating point anywhere near it.

CREATE TABLE IF NOT EXISTS subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  plan            text NOT NULL,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('trialing','active','past_due','grace','cancelled','expired')),
  -- Monthly or yearly. Stored per subscription rather than derived from the
  -- plan, because a customer keeps the term they signed up on when prices move.
  term            text NOT NULL DEFAULT 'monthly' CHECK (term IN ('monthly','yearly')),
  price_paise     bigint NOT NULL DEFAULT 0,
  started_at      timestamptz NOT NULL DEFAULT now(),
  current_from    timestamptz NOT NULL DEFAULT now(),
  current_until   timestamptz NOT NULL,
  -- Set when somebody downgrades. The change waits for the period they already
  -- paid for to run out; taking away what they bought on the day they ask is
  -- theft with extra steps.
  pending_plan    text,
  pending_term    text,
  cancel_at_end   boolean NOT NULL DEFAULT false,
  cancelled_at    timestamptz,
  -- How long service continues after a payment fails. A shop that loses its
  -- numbers the hour a card expires will not renew; it will phone, angry.
  grace_until     timestamptz,
  coupon_code     text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One live subscription per business. Two would double-bill and disagree about
-- which plan's limits apply.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_live
  ON subscriptions (org_id)
  WHERE status IN ('trialing','active','past_due','grace');

CREATE INDEX IF NOT EXISTS subscriptions_renewal_idx
  ON subscriptions (current_until) WHERE status IN ('active','past_due','grace');

-- Coupons.
--
-- Percentage or a fixed amount, never both: a coupon that is somehow 20% AND
-- ₹200 off is a support ticket about which one applied.
CREATE TABLE IF NOT EXISTS coupons (
  code            text PRIMARY KEY,
  label           text NOT NULL DEFAULT '',
  percent_off     int,
  amount_off_paise bigint,
  -- Which plans it may be used on. Empty means any.
  plans           text[] NOT NULL DEFAULT '{}',
  -- How many billing periods the discount lasts. NULL means for ever.
  periods         int,
  max_redemptions int,
  redeemed        int NOT NULL DEFAULT 0,
  expires_at      timestamptz,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coupons_one_kind CHECK (
    (percent_off IS NOT NULL AND amount_off_paise IS NULL)
    OR (percent_off IS NULL AND amount_off_paise IS NOT NULL)),
  CONSTRAINT coupons_sane_percent CHECK (percent_off IS NULL
    OR (percent_off > 0 AND percent_off <= 100))
);

-- Payments, successful and not.
--
-- A failed attempt is a row, not an absence of one: "the card was declined on
-- the 3rd and again on the 5th" is the answer to most billing questions.
CREATE TABLE IF NOT EXISTS payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  status          text NOT NULL CHECK (status IN ('pending','paid','failed','refunded')),
  -- The three parts of the money, kept separately because a GST invoice has to
  -- show them separately and recomputing tax from a total loses a rupee.
  subtotal_paise  bigint NOT NULL DEFAULT 0,
  discount_paise  bigint NOT NULL DEFAULT 0,
  tax_paise       bigint NOT NULL DEFAULT 0,
  total_paise     bigint NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'INR',
  method          text NOT NULL DEFAULT '',
  gateway         text NOT NULL DEFAULT '',
  gateway_ref     text NOT NULL DEFAULT '',
  failure_reason  text NOT NULL DEFAULT '',
  period_from     timestamptz,
  period_until    timestamptz,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_org_idx ON payments (org_id, created_at DESC);

-- A gateway must never be able to apply the same payment twice, however many
-- times it retries a webhook.
CREATE UNIQUE INDEX IF NOT EXISTS payments_gateway_ref_uniq
  ON payments (gateway, gateway_ref) WHERE gateway_ref <> '';

-- Munim's own GST invoices to its customers.
--
-- Separate from `payments` because the invoice number is a legal sequence that
-- must never have a gap, and a failed payment must not consume one.
CREATE TABLE IF NOT EXISTS billing_invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  payment_id      uuid REFERENCES payments(id) ON DELETE SET NULL,
  number          text NOT NULL,
  fy              text NOT NULL,
  seq             int NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  -- Frozen at the moment of issue. A customer who changes their GSTIN later
  -- must not silently rewrite an invoice already filed with it.
  bill_to_name    text NOT NULL DEFAULT '',
  bill_to_gstin   text NOT NULL DEFAULT '',
  bill_to_state   text NOT NULL DEFAULT '',
  bill_to_address text NOT NULL DEFAULT '',
  place_of_supply text NOT NULL DEFAULT '',
  description     text NOT NULL DEFAULT '',
  subtotal_paise  bigint NOT NULL DEFAULT 0,
  discount_paise  bigint NOT NULL DEFAULT 0,
  -- Split three ways because within one state it is CGST + SGST and across
  -- states it is IGST, and an invoice showing the wrong pair is not claimable.
  cgst_paise      bigint NOT NULL DEFAULT 0,
  sgst_paise      bigint NOT NULL DEFAULT 0,
  igst_paise      bigint NOT NULL DEFAULT 0,
  total_paise     bigint NOT NULL DEFAULT 0,
  hsn             text NOT NULL DEFAULT '998314',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The legal sequence: no gaps, no duplicates, per financial year.
CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_number_uniq
  ON billing_invoices (number);
CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_seq_uniq
  ON billing_invoices (fy, seq);

-- Add-ons: extra message credits, extra seats, bought outside the plan.
CREATE TABLE IF NOT EXISTS addons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  quantity     int  NOT NULL DEFAULT 1,
  price_paise  bigint NOT NULL DEFAULT 0,
  -- NULL means it does not expire: bought credits stay bought.
  expires_at   timestamptz,
  payment_id   uuid REFERENCES payments(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS addons_org_idx ON addons (org_id, kind);
