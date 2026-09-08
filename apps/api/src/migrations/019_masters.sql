-- The masters, in the detail a business actually keeps them in.
--
-- Ledgers and items have been two names and a balance. Everything a customer
-- wants to do next - print an invoice with the buyer's GSTIN on it, chase a
-- party by phone, know an item's HSN, see what is below its reorder level -
-- needs the fields Tally has been holding all along and Munim never asked for.

ALTER TABLE ledgers
  -- Identity and tax
  ADD COLUMN IF NOT EXISTS gst_reg_type   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pan            text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS contact_person text NOT NULL DEFAULT '',

  -- Billing address, kept as one joined string plus its parts. Tally returns
  -- an address as a LIST of lines with no structure, so the lines are what is
  -- true; state and pincode come from their own fields where present.
  ADD COLUMN IF NOT EXISTS address        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS state          text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS country        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pincode        text NOT NULL DEFAULT '',

  -- Where goods go, which is often not where the bill goes.
  ADD COLUMN IF NOT EXISTS shipping_address text NOT NULL DEFAULT '',

  -- Bank details, for paying a supplier or telling a customer where to pay.
  ADD COLUMN IF NOT EXISTS bank_name      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_account   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_ifsc      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_holder    text NOT NULL DEFAULT '',

  -- How much credit this party is allowed. 0 means Tally has no limit set,
  -- which is different from a limit of zero - but Tally does not distinguish
  -- them either, so neither can we.
  ADD COLUMN IF NOT EXISTS credit_limit_paise bigint NOT NULL DEFAULT 0,

  -- Set by the customer in Munim, not read from Tally: a way to group parties
  -- by something the books do not record - "wholesale", "chases slowly".
  ADD COLUMN IF NOT EXISTS tags          text[] NOT NULL DEFAULT '{}';

ALTER TABLE stock_items
  ADD COLUMN IF NOT EXISTS parent_group   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS category       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS alt_unit       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS hsn            text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS sac            text NOT NULL DEFAULT '',
  -- Basis points, not a float: 18% is 1800. A GST rate that arrives as
  -- 17.999999 because it went through a float is a rejected return.
  ADD COLUMN IF NOT EXISTS gst_rate_bp    integer NOT NULL DEFAULT 0,

  ADD COLUMN IF NOT EXISTS opening_qty    double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opening_value_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS purchase_rate_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sales_rate_paise    bigint NOT NULL DEFAULT 0,

  -- Reorder levels. Tally keeps these per godown; these are the item totals,
  -- which is the number a shop owner actually reorders against.
  ADD COLUMN IF NOT EXISTS min_level      double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_level      double precision NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reorder_level  double precision NOT NULL DEFAULT 0,

  ADD COLUMN IF NOT EXISTS has_batches    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tags           text[] NOT NULL DEFAULT '{}';

/*
 * Batches, where a business tracks them.
 *
 * Separate rather than a jsonb column on the item: expiry is the one thing
 * anyone queries across every item at once ("what goes out of date this
 * month"), and that has to be a row with an index, not a field inside a blob.
 */
CREATE TABLE IF NOT EXISTS stock_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_name   text NOT NULL,
  batch_name  text NOT NULL,
  godown      text NOT NULL DEFAULT '',
  qty         double precision NOT NULL DEFAULT 0,
  value_paise bigint NOT NULL DEFAULT 0,
  mfg_date    date,
  expiry_date date,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, item_name, batch_name, godown)
);

CREATE INDEX IF NOT EXISTS stock_batches_expiry_idx
  ON stock_batches (company_id, expiry_date) WHERE expiry_date IS NOT NULL;

-- Looking a party up by name is what every screen does.
CREATE INDEX IF NOT EXISTS ledgers_name_idx ON ledgers (company_id, lower(name));
CREATE INDEX IF NOT EXISTS stock_items_name_idx ON stock_items (company_id, lower(name));
CREATE INDEX IF NOT EXISTS stock_items_group_idx ON stock_items (company_id, parent_group);

/*
 * Resolve a ledger's true nature by walking the group tree.
 *
 * account_nature() classifies by the group's NAME, which works for Tally's
 * built-in groups and fails silently for one a shop invented: a business that
 * files buyers under "Local Customers" inside Sundry Debtors has ledgers whose
 * parent means nothing to a name-based rule, and they drop out of the balance
 * sheet without a word.
 *
 * This climbs parents until it reaches a group whose name IS recognised. The
 * depth guard is not paranoia - Tally will happily let a group be its own
 * ancestor after a bad import, and an unguarded recursion would hang the
 * report rather than merely get it wrong.
 */
CREATE OR REPLACE FUNCTION resolved_nature(cid uuid, grp text)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  cur text := grp;
  nat text;
  hops int := 0;
BEGIN
  LOOP
    nat := account_nature(cur);
    IF nat <> 'other' THEN RETURN nat; END IF;

    hops := hops + 1;
    EXIT WHEN hops > 12;

    SELECT g.parent INTO cur
      FROM groups g
     WHERE g.company_id = cid AND lower(g.name) = lower(cur)
     LIMIT 1;

    EXIT WHEN cur IS NULL OR cur = '';
  END LOOP;

  -- Unresolvable is reported as 'other' rather than guessed. A ledger in the
  -- wrong half of a balance sheet is worse than one visibly unclassified.
  RETURN 'other';
END $$;
