-- Bill-wise outstanding is a NET figure per bill reference.
--
-- A sale creates the bill ("New Ref"); a receipt settles it ("Agst Ref").
-- Storing every allocation as a positive amount counts the settlement as more
-- debt, so outstanding grows forever and ends up larger than the ledger balance
-- it is supposed to explain.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS bill_type text NOT NULL DEFAULT '';

-- The amount is now signed: positive raises the bill, negative settles it.
COMMENT ON COLUMN bills.amount_paise IS
  'Signed. New Ref is positive (debt raised); Agst Ref is negative (settled).';

CREATE INDEX IF NOT EXISTS bills_party_ref ON bills (company_id, party, ref);
