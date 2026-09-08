-- One business, several years of Tally companies.
--
-- Standard practice in India: an accountant closes the books at 31 March and
-- starts a NEW Tally company for the next year. "Acme Traders 2024-25" and
-- "Acme Traders 2025-26" are different company files with different GUIDs, and
-- they are the same shop.
--
-- Munim treated each as its own company, which broke three things:
--
--   * the plan quota counted them separately, so a shop on Basic keeping three
--     years of books was over its one-company limit the day it connected -
--     which stopped the product working at all for a very ordinary setup
--   * every year-on-year comparison came out empty, because last year's figures
--     were in a company the query never looked at
--   * a customer's history stopped at 1 April
--
-- A business is the grouping. Companies keep their own rows - they are separate
-- files and their vouchers must not be mixed by accident - but they now know
-- which shop they belong to.

CREATE TABLE IF NOT EXISTS businesses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- What the grouping was decided on, kept so somebody can see WHY two files
  -- were treated as one shop - and disagree.
  matched_on  text NOT NULL DEFAULT 'manual'
              CHECK (matched_on IN ('gstin', 'name', 'manual', 'single')),
  gstin       text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS businesses_org_idx ON businesses (org_id);

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES businesses(id) ON DELETE SET NULL,
  -- The financial year this file covers, as a label a person reads: "2025-26".
  -- Derived from fy_start where Tally reports it.
  ADD COLUMN IF NOT EXISTS fy_label text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS companies_business_idx ON companies (business_id);

/*
 * Every existing company becomes its own business.
 *
 * Deliberately not clever on migration: guessing which of a customer's existing
 * files belong together and getting it wrong would merge two real businesses
 * into one, which is far worse than leaving them apart. Grouping happens on the
 * next sync, where the GSTIN is known, and a person can always correct it.
 */
INSERT INTO businesses (org_id, name, matched_on, gstin)
SELECT c.org_id, c.name, 'single', COALESCE(c.gstin, '')
  FROM companies c
 WHERE c.business_id IS NULL;

UPDATE companies c
   SET business_id = b.id
  FROM businesses b
 WHERE c.business_id IS NULL
   AND b.org_id = c.org_id
   AND b.name = c.name
   AND b.matched_on = 'single';
