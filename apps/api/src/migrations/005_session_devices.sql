-- Losing a phone is the ordinary case, not the exotic one: the owner buys a new
-- handset, or leaves the old one in an auto. Until now a session was an opaque
-- row, so there was no way to answer "which of these is the phone I lost?" and
-- no way to shut it out.
--
-- Two columns make that answerable, and one action makes it fixable.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS device_label  text,
  ADD COLUMN IF NOT EXISTS last_seen_at  timestamptz;

-- Existing sessions have no history; treat their creation as the last thing
-- known about them rather than showing an empty column.
UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL;

-- "Show me my active sign-ins" runs on every visit to the devices screen.
CREATE INDEX IF NOT EXISTS sessions_active_idx
  ON sessions (user_id, revoked_at, expires_at);
