-- Where Munim's own invoices are addressed.
--
-- Separate from the company details synced from Tally: the business that PAYS
-- for Munim is not always the company in the books - a group buys one
-- subscription for four of them, and the invoice has to carry the paying
-- entity's GSTIN or it cannot be claimed.
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS billing_name    text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS billing_gstin   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS billing_state   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS billing_address text NOT NULL DEFAULT '';
