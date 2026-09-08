-- How far behind a connector is.
--
-- "status = error" tells an operator something is wrong but not whether it
-- matters. A shop whose internet dropped ten minutes ago and a shop that has
-- been queueing for three days look identical, and only one of them needs a
-- phone call.
--
-- The connector reports how many batches are waiting on its own disk, so the
-- fleet view can sort by who is actually falling behind.
ALTER TABLE connectors
  ADD COLUMN IF NOT EXISTS queued_batches int NOT NULL DEFAULT 0,
  -- The last time data genuinely arrived, as opposed to the last heartbeat.
  -- A connector can be heartbeating happily while sending nothing.
  ADD COLUMN IF NOT EXISTS last_data_at timestamptz;

CREATE INDEX IF NOT EXISTS connectors_behind_idx
  ON connectors (queued_batches DESC) WHERE revoked_at IS NULL;
