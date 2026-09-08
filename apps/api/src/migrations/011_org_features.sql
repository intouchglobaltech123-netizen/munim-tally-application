-- Per-customer features.
--
-- Ten customers on one small server, and they will not all want the same thing:
-- one pays for WhatsApp reminders, another only reads reports, a third has three
-- shops. Shipping a different build for each is unmaintainable at ten and
-- impossible at a hundred.
--
-- So one build, and what a customer can do is data. Features live on the org,
-- the server decides, and the apps only render what they are told is available.
-- A customer who edits their own client cannot turn a feature on, because every
-- route checks the same row.
--
-- JSONB rather than a column per feature: adding a feature is then an UPDATE,
-- not a migration and a deploy.

ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Hard ceilings, separate from features. "Can you use reminders" and "how
  -- many computers may you connect" are different questions.
  ADD COLUMN IF NOT EXISTS max_connectors int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS max_companies  int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '';

-- Existing customers keep working exactly as before.
UPDATE orgs SET features = '{
  "reports": true,
  "outstanding": true,
  "reminders": true,
  "statements": true,
  "stock": true,
  "multiCompany": false,
  "export": false
}'::jsonb
WHERE features = '{}'::jsonb;

CREATE INDEX IF NOT EXISTS orgs_plan_idx ON orgs (plan);
