-- How a customer's documents look, and what goes on them.
--
-- The invoice template was fixed in code. Every shop wants something slightly
-- different on it - their terms, their bank details, a thermal roll instead of
-- A4 - and none of that is worth a code change per customer.
--
-- All of it lives on the company, because a business with two firms prints
-- two different letterheads.

ALTER TABLE companies
  -- Page. 'a4' | 'a5' | 'letter' | 'thermal' | 'custom'.
  ADD COLUMN IF NOT EXISTS doc_page_size    text NOT NULL DEFAULT 'a4',
  ADD COLUMN IF NOT EXISTS doc_orientation  text NOT NULL DEFAULT 'portrait',
  -- Millimetres, only read when page size is 'custom'.
  ADD COLUMN IF NOT EXISTS doc_width_mm     integer NOT NULL DEFAULT 210,
  ADD COLUMN IF NOT EXISTS doc_height_mm    integer NOT NULL DEFAULT 297,
  ADD COLUMN IF NOT EXISTS doc_margin_mm    integer NOT NULL DEFAULT 14,

  -- Type.
  ADD COLUMN IF NOT EXISTS doc_font         text NOT NULL DEFAULT 'sans',
  ADD COLUMN IF NOT EXISTS doc_font_size    integer NOT NULL DEFAULT 13,
  -- A single colour used for rules and headings. One, not a palette: a shop
  -- owner picking six colours produces something worse than the default.
  ADD COLUMN IF NOT EXISTS doc_accent       text NOT NULL DEFAULT '#1F2937',
  ADD COLUMN IF NOT EXISTS doc_borders      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS doc_dense        boolean NOT NULL DEFAULT false,

  /*
   * Which blocks appear.
   *
   * Stored as one jsonb rather than a column each: this list grows every time
   * somebody wants one more thing on their invoice, and a migration per
   * checkbox is not a reasonable trade.
   */
  ADD COLUMN IF NOT EXISTS doc_show         jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Free text the shop writes once.
  ADD COLUMN IF NOT EXISTS doc_terms        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS doc_footer       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS doc_signatory    text NOT NULL DEFAULT '',

  -- The company's own bank, for "where do I pay you".
  ADD COLUMN IF NOT EXISTS bank_name        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_account     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_ifsc        text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS bank_branch      text NOT NULL DEFAULT '',

  /*
   * A UPI id, which turns the invoice into something payable.
   *
   * The single most useful thing that can go on an Indian invoice: the
   * customer points a phone at it and the amount is already filled in. Costs
   * nothing, needs no gateway, and settles straight into the shop's account.
   */
  ADD COLUMN IF NOT EXISTS upi_id           text NOT NULL DEFAULT '';

ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_page_size_ck,
  ADD  CONSTRAINT companies_page_size_ck
       CHECK (doc_page_size IN ('a4', 'a5', 'letter', 'thermal', 'custom')),
  DROP CONSTRAINT IF EXISTS companies_orientation_ck,
  ADD  CONSTRAINT companies_orientation_ck
       CHECK (doc_orientation IN ('portrait', 'landscape')),
  DROP CONSTRAINT IF EXISTS companies_font_ck,
  ADD  CONSTRAINT companies_font_ck CHECK (doc_font IN ('sans', 'serif', 'mono')),
  DROP CONSTRAINT IF EXISTS companies_font_size_ck,
  ADD  CONSTRAINT companies_font_size_ck CHECK (doc_font_size BETWEEN 8 AND 18),
  DROP CONSTRAINT IF EXISTS companies_margin_ck,
  ADD  CONSTRAINT companies_margin_ck CHECK (doc_margin_mm BETWEEN 0 AND 40);
