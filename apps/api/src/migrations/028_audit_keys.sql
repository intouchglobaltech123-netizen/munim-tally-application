-- Give the audit log the foreign keys it never had.
--
-- `org_id` and `user_id` were plain uuid columns with nothing behind them. Two
-- consequences, both quiet:
--
--   * Deleting a business left its audit rows behind for ever. They were
--     unreadable - every read filters by org_id - so they simply accumulated.
--   * Deleting a person left entries pointing at a user that no longer exists.
--     The join returned nothing and the entry read as "Unknown", losing the
--     one fact an audit trail must never lose.
--
-- The second is why actor_name and actor_email are stored as text alongside
-- the key: the key can go, the name must not.

-- Rows whose business is gone were already invisible. Removing them is the
-- cleanup that should have happened when the business was deleted.
DELETE FROM audit_log a
 WHERE a.org_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = a.org_id);

-- A key pointing at a deleted person becomes NULL. The name stays.
UPDATE audit_log a SET user_id = NULL
 WHERE a.user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id);

ALTER TABLE audit_log
  DROP CONSTRAINT IF EXISTS audit_log_org_id_fkey,
  ADD  CONSTRAINT audit_log_org_id_fkey
       FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE,

  DROP CONSTRAINT IF EXISTS audit_log_user_id_fkey,
  /*
   * SET NULL, never CASCADE.
   *
   * Deleting somebody must not delete the record of what they did - that is
   * precisely the record an audit log exists to keep, and cascading would let
   * anybody erase their own history by removing their account.
   */
  ADD  CONSTRAINT audit_log_user_id_fkey
       FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
