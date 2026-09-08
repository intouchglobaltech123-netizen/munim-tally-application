-- Who else may see the books, and exactly how much of them.
--
-- Until now an account had one user and one role: owner. A shop with an
-- accountant, a manager and two salespeople either shares one login - which
-- makes the sign-in history and the device limit meaningless - or does not use
-- the product. This is what makes a second person possible.

/*
 * Roles carry the permission matrix.
 *
 * Built-in roles are rows too, not constants in code. The moment a customer
 * asks for "an accountant who cannot see profit", a code-level enum means a
 * deploy; a row means an edit. Built-ins are seeded per org and marked so the
 * UI can stop someone deleting the role they themselves hold.
 */
CREATE TABLE IF NOT EXISTS roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key        text NOT NULL,
  name       text NOT NULL,
  description text NOT NULL DEFAULT '',
  built_in   boolean NOT NULL DEFAULT false,

  /*
   * { "<module>": ["read","export",...] }
   *
   * A module absent from the object means no access at all, which is why the
   * default is an empty object: a new role can see nothing until somebody says
   * otherwise. Defaulting to full access would mean one forgotten field hands
   * a salesperson the balance sheet.
   */
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (org_id, key)
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES roles(id) ON DELETE SET NULL,
  -- 'active' | 'disabled'. Disabling keeps the person and their history while
  -- refusing them entry; deleting throws away who did what, which is exactly
  -- what an audit trail exists to prevent.
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS branch text NOT NULL DEFAULT '',
  -- Salespeople are singled out because their own figures are the ones they
  -- are usually allowed to see, and nobody else's.
  ADD COLUMN IF NOT EXISTS is_salesperson boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS salesperson_name text NOT NULL DEFAULT '',
  -- 0 means "use the plan's limit". Per user because a manager with a phone
  -- and a desk browser needs two, and a counter tablet needs one.
  ADD COLUMN IF NOT EXISTS device_limit integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invited_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_status_ck,
  ADD  CONSTRAINT users_status_ck CHECK (status IN ('active', 'disabled'));

/*
 * Which books each user may open.
 *
 * A row here is permission for one user to see one company. No rows at all
 * means every company in the account - the common case, and one a shop with a
 * single book should never have to configure.
 */
CREATE TABLE IF NOT EXISTS user_companies (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, company_id)
);

/*
 * An invitation, waiting for its owner to sign in with Google.
 *
 * Sign-in is Google-only, so a new user cannot be handed a password - there is
 * none to hand. The invitation is by email address instead: whoever proves to
 * Google that they own that address becomes this user. That is a stronger
 * guarantee than a password we emailed, and it costs nothing to send.
 */
CREATE TABLE IF NOT EXISTS invites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email      text NOT NULL,
  role_id    uuid REFERENCES roles(id) ON DELETE SET NULL,
  name       text NOT NULL DEFAULT '',
  branch     text NOT NULL DEFAULT '',
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (org_id, email)
);

CREATE INDEX IF NOT EXISTS invites_open_idx
  ON invites (lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;
