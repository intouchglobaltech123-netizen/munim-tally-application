-- The record of who did what.
--
-- The table existed and six modules wrote to it, but it held only an action
-- name and a loose bag of metadata. An audit log that cannot say WHERE the
-- person was, WHICH record they touched, or WHAT it looked like before is not
-- much of an audit log - it answers "something happened" and nothing else.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL,

  -- Who, in a form that survives the user being deleted. An audit trail whose
  -- entries become anonymous when somebody leaves is exactly the wrong way
  -- round.
  ADD COLUMN IF NOT EXISTS actor_name  text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS actor_email text NOT NULL DEFAULT '',

  -- Where from. The /24 only, as everywhere else: enough to tell "the shop's
  -- usual line" from "another country" without keeping a precise record of
  -- where somebody was sitting.
  ADD COLUMN IF NOT EXISTS ip_prefix text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS device    text NOT NULL DEFAULT '',

  -- What was touched: 'user', 'role', 'company', 'backup', 'template'…
  ADD COLUMN IF NOT EXISTS entity      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS entity_id   text NOT NULL DEFAULT '',
  -- A name a person recognises, so the log reads without joining anything.
  ADD COLUMN IF NOT EXISTS entity_name text NOT NULL DEFAULT '',

  /*
   * What changed.
   *
   * Only the fields that actually differed, not the whole row: a settings save
   * that touched one checkbox should read as one line, and storing the entire
   * record twice makes the log expensive and unreadable at once.
   */
  ADD COLUMN IF NOT EXISTS before_val jsonb,
  ADD COLUMN IF NOT EXISTS after_val  jsonb;

CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log (org_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (org_id, user_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (org_id, entity, entity_id);
