-- One plan.
--
-- basic, pro and enterprise are no longer sold; everything they gated is now
-- included at a single price. Accounts sitting on those keys have to move, or
-- plans.plan() falls through to its default and quietly applies trial limits
-- to a paying customer.
--
-- Order matters here. The check constraint has to admit 'standard' before any
-- row can be moved onto it, and it cannot be narrowed to the final list until
-- every row has moved - so it is widened, then the rows move, then it is
-- narrowed.

ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_plan_known;
ALTER TABLE orgs ADD CONSTRAINT orgs_plan_known
  CHECK (plan IN ('trial', 'basic', 'pro', 'enterprise', 'internal', 'standard'));

UPDATE orgs SET plan = 'standard'
 WHERE plan IN ('basic', 'pro', 'enterprise');

-- Trials are deliberately left alone: they are still a real state, and moving
-- them would hand a fortnight of free access to whoever asked for it last.
ALTER TABLE orgs DROP CONSTRAINT orgs_plan_known;
ALTER TABLE orgs ADD CONSTRAINT orgs_plan_known
  CHECK (plan IN ('trial', 'standard', 'internal'));

-- Same reasoning for anything already scheduled or invoiced against a plan
-- that no longer exists.
UPDATE subscriptions SET plan = 'standard'
 WHERE plan IN ('basic', 'pro', 'enterprise');

-- Tables belonging to features that no longer exist.
--
-- The partner programme, the developer console (API keys and webhooks) and
-- backups are gone from the product, so their tables are dead weight: nothing
-- reads them, nothing writes them, and a table nobody owns is exactly the kind
-- of thing that gets quietly excluded from a tenant-isolation check and then
-- accumulates data nobody can trace.
--
-- Dropped in dependency order, and CASCADE for the foreign keys between them.
DROP TABLE IF EXISTS webhook_deliveries CASCADE;
DROP TABLE IF EXISTS webhooks           CASCADE;
DROP TABLE IF EXISTS api_keys           CASCADE;
DROP TABLE IF EXISTS backups            CASCADE;
DROP TABLE IF EXISTS commissions        CASCADE;
DROP TABLE IF EXISTS payouts            CASCADE;
DROP TABLE IF EXISTS partner_leads      CASCADE;
DROP TABLE IF EXISTS partner_users      CASCADE;
DROP TABLE IF EXISTS partners           CASCADE;
