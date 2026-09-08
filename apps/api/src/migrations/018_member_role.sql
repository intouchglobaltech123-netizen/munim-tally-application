-- Let an invited colleague exist.
--
-- The old `role` column was the whole permission model: owner, accountant,
-- staff. Since 017 the authority is `role_id` and the matrix it points at, and
-- this column survives only for two coarse checks that must keep working -
-- "is this the account owner" and "is this Munim staff".
--
-- An invited person is neither, so they need a value of their own. Without it
-- accepting an invitation fails on a constraint from the previous design.

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check,
  ADD  CONSTRAINT users_role_check CHECK (
    role IN ('owner', 'member', 'platform_admin',
             -- Kept so rows written under the old model still validate. New
             -- rows should be 'member' with a role_id.
             'accountant', 'staff')
  );

COMMENT ON COLUMN users.role IS
  'Coarse kind only: owner | member | platform_admin. The real permissions '
  'live in roles.permissions via users.role_id. accountant/staff are legacy.';
