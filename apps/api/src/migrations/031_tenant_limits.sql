-- Per-tenant limit overrides.
--
-- A plan is a starting point, not a contract: sales promises get made, and the
-- alternative to an override is inventing a bespoke plan for every negotiation.
-- Shaped exactly like the `features` column that already works this way, so
-- there is one pattern for "this customer is different", not two.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS limits jsonb NOT NULL DEFAULT '{}'::jsonb;

-- The plan a customer is on has to be one Munim actually sells. Without this a
-- typo in an admin screen silently drops somebody onto trial limits.
ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_plan_known;
ALTER TABLE orgs ADD CONSTRAINT orgs_plan_known
  CHECK (plan IN ('trial', 'basic', 'pro', 'enterprise', 'internal'));
