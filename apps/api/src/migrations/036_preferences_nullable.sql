-- A preference that belongs to no particular company.
--
-- company_id was part of the PRIMARY KEY, and a primary key column is NOT NULL
-- - so "this preference applies everywhere" could not be stored at all. The
-- landing screen and the default company are exactly that kind of preference.
--
-- Replaced with a surrogate key plus two partial unique indexes: one for the
-- per-company rows and one for the global ones. Two indexes rather than one
-- because NULL is not equal to itself, so a single unique constraint would let
-- a person accumulate a new global row on every save and the newest would win
-- only by luck.

ALTER TABLE preferences DROP CONSTRAINT IF EXISTS preferences_pkey;
ALTER TABLE preferences ALTER COLUMN company_id DROP NOT NULL;

ALTER TABLE preferences ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();
UPDATE preferences SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE preferences ALTER COLUMN id SET NOT NULL;
ALTER TABLE preferences ADD PRIMARY KEY (id);

CREATE UNIQUE INDEX IF NOT EXISTS preferences_company_uniq
  ON preferences (user_id, key, company_id) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS preferences_global_uniq2
  ON preferences (user_id, key) WHERE company_id IS NULL;
DROP INDEX IF EXISTS preferences_global_uniq;
