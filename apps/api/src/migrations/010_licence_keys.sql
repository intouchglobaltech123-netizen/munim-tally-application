-- Licence keys.
--
-- A key is what a customer buys, and what lets one Tally computer connect. It
-- is issued by Munim staff, and it works exactly once: the moment a connector
-- redeems it, it is bound to that connector for good.
--
-- That single-use binding is the whole point. Without it a customer who pays
-- for one connection can pass the same key - or the same setup file - to as
-- many shops as they like, and there is nothing in the product that notices.
-- With it, a shared key simply fails on the second machine.
--
-- The key is stored hashed, like every other credential here: an operator with
-- read access to the database should not be able to walk away with a customer's
-- unredeemed keys.

CREATE TABLE IF NOT EXISTS licence_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash      text NOT NULL UNIQUE,
  -- Shown in listings so staff can identify a key without being able to use
  -- it: "MUNM-7K2P-****-****".
  key_hint      text NOT NULL,

  -- Who it was sold to. Free text on purpose: a key is often generated before
  -- the customer has an account.
  issued_to     text NOT NULL DEFAULT '',
  note          text NOT NULL DEFAULT '',

  issued_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,

  -- Filled in on redemption, and never cleared. A used key stays used.
  redeemed_at   timestamptz,
  org_id        uuid REFERENCES orgs(id) ON DELETE SET NULL,
  connector_id  uuid REFERENCES connectors(id) ON DELETE SET NULL,
  machine_name  text NOT NULL DEFAULT '',

  -- Staff can kill a key: a refund, a chargeback, a key that leaked.
  revoked_at    timestamptz,
  revoked_note  text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS licence_keys_org_idx ON licence_keys (org_id);
CREATE INDEX IF NOT EXISTS licence_keys_unused_idx
  ON licence_keys (issued_at DESC) WHERE redeemed_at IS NULL AND revoked_at IS NULL;

-- Which licence a connector is running on, so revoking a key can stop it.
ALTER TABLE connectors
  ADD COLUMN IF NOT EXISTS licence_key_id uuid REFERENCES licence_keys(id) ON DELETE SET NULL;
