-- How a company wants its own figures and documents to look.
--
-- These are the only company fields Munim owns rather than reads. Everything
-- in 013 comes from Tally and is overwritten on every sync; these survive it,
-- because Tally has no opinion about them and the customer does.

ALTER TABLE companies
  -- Stored inline as a data URI rather than in object storage. A shop logo is
  -- a few tens of KB, there is exactly one per company, and it is needed on
  -- every generated document - so a bucket, its credentials and its egress
  -- bill would all be cost with no benefit. Capped in the API, not here: a
  -- CHECK constraint would reject the upload with a database error rather
  -- than a sentence the customer can act on.
  ADD COLUMN IF NOT EXISTS logo_data_uri text NOT NULL DEFAULT '',

  -- 'indian' groups as 12,34,567 (lakh/crore); 'international' as 1,234,567.
  -- Indian by default because that is who this is for, but an exporter
  -- sending invoices abroad needs the other one.
  ADD COLUMN IF NOT EXISTS number_format text NOT NULL DEFAULT 'indian',

  -- Whole rupees or paise. Retail counts in rupees and finds ".00" on every
  -- line noisy; anyone reconciling against Tally needs the paise. Both are
  -- correct, for different people.
  ADD COLUMN IF NOT EXISTS decimals integer NOT NULL DEFAULT 0,

  ADD COLUMN IF NOT EXISTS date_format text NOT NULL DEFAULT 'dd-mm-yyyy';

-- Reject nonsense at the edge of the database as well as in the API, so a bad
-- value cannot arrive by any other route and break every screen at once.
ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_number_format_ck,
  ADD  CONSTRAINT companies_number_format_ck
       CHECK (number_format IN ('indian', 'international')),
  DROP CONSTRAINT IF EXISTS companies_decimals_ck,
  ADD  CONSTRAINT companies_decimals_ck CHECK (decimals BETWEEN 0 AND 4),
  DROP CONSTRAINT IF EXISTS companies_date_format_ck,
  ADD  CONSTRAINT companies_date_format_ck
       CHECK (date_format IN ('dd-mm-yyyy', 'mm-dd-yyyy', 'yyyy-mm-dd'));
