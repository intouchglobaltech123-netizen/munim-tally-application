-- Make max_companies / max_connectors mean "raised by hand", not "unset".
--
-- Both columns default to 1. Once plans decide limits, a column that is always
-- populated always wins - so every plan's ceiling would silently be 1, and an
-- Enterprise customer paying for unlimited companies would be refused their
-- second one. The plan table would have been decoration.
--
-- Rows still holding the default are set to NULL, which is what "nobody chose
-- this" should have looked like from the start. A value above 1 was typed by a
-- human raising somebody's ceiling and is kept: that is a promise already made.

ALTER TABLE orgs ALTER COLUMN max_companies  DROP DEFAULT;
ALTER TABLE orgs ALTER COLUMN max_connectors DROP DEFAULT;

-- NOT NULL has to go with the default: "unset" needs a value to be, and NULL
-- is the only one that does not also read as a real ceiling.
ALTER TABLE orgs ALTER COLUMN max_companies  DROP NOT NULL;
ALTER TABLE orgs ALTER COLUMN max_connectors DROP NOT NULL;

UPDATE orgs SET max_companies  = NULL WHERE max_companies  = 1;
UPDATE orgs SET max_connectors = NULL WHERE max_connectors = 1;

COMMENT ON COLUMN orgs.max_companies IS
  'Per-customer override. NULL means the plan decides.';
COMMENT ON COLUMN orgs.max_connectors IS
  'Per-customer override. NULL means the plan decides.';
