-- The company's own identity, as Tally holds it.
--
-- Until now a company was a name and a GUID. Every document a customer wants
-- to send out - an invoice, a statement, a reminder - has to be headed with
-- who they are: address, GSTIN, PAN. Without these the PDF says nothing about
-- the sender, so this has to land before any document work.
--
-- All text, all defaulted to empty. Tally is not consistent about which of
-- these a company has filled in, and a null here would mean "we never asked"
-- rather than "they left it blank" - a distinction nothing downstream cares
-- about, and one that would force null handling into every template.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS formal_name  text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS address      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS state        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS country      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pincode      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS gstin        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS pan          text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS cin          text NOT NULL DEFAULT '',
  -- Books can begin later than the financial year: a business incorporated in
  -- August has an FY starting 1 April and books starting in August, and an
  -- opening balance that only makes sense against the latter.
  ADD COLUMN IF NOT EXISTS books_from   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS fy_end       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS currency     text NOT NULL DEFAULT '₹',
  -- When the profile above was last refreshed from Tally. Distinct from
  -- last_sync_at, which tracks vouchers: the profile is fetched on its own
  -- schedule and may legitimately be far older than the last voucher.
  ADD COLUMN IF NOT EXISTS profile_at   timestamptz;
