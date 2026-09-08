-- Signing in on a new phone signs out the old one.
--
-- Sessions no longer expire, so without this a customer who changes handset
-- every couple of years accumulates live sessions on phones they no longer own
-- - each one a way into their books, and none of them visible unless they think
-- to look at Devices.
--
-- The rule is per *kind* of device, not globally: a shop owner using the web on
-- the counter PC and the app in their pocket is the normal case, and signing
-- one out because they used the other would be maddening. Two phones at once is
-- not.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS device_kind text;

-- Backfill from the label we already record.
UPDATE sessions
   SET device_kind = CASE
     WHEN device_label ILIKE '%android%' OR device_label ILIKE '%iphone%' THEN 'mobile'
     WHEN device_label IS NULL THEN 'web'
     ELSE 'web'
   END
 WHERE device_kind IS NULL;

CREATE INDEX IF NOT EXISTS sessions_user_kind_idx
  ON sessions (user_id, device_kind) WHERE revoked_at IS NULL;
