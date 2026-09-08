-- What the connector actually did, kept where the customer can see it.
--
-- Until now the only evidence a sync happened was last_sync_at moving and a
-- log file on the shop's own PC. When a customer says "my figures are wrong",
-- that gives support nothing to look at: no idea whether syncs are failing,
-- how long they take, or when they last succeeded. This is the audit trail.

CREATE TABLE IF NOT EXISTS sync_runs (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connector_id  uuid REFERENCES connectors(id) ON DELETE SET NULL,
  company_id    uuid REFERENCES companies(id) ON DELETE CASCADE,

  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL DEFAULT now(),
  duration_ms   integer NOT NULL DEFAULT 0,

  -- 'auto' (the watcher), 'manual' (someone pressed sync), 'startup', or
  -- 'command' (asked for from the app). Which one it was decides whether a
  -- failure is worth telling anyone about.
  trigger       text NOT NULL DEFAULT 'auto',
  ok            boolean NOT NULL DEFAULT true,

  records       integer NOT NULL DEFAULT 0,
  batches       integer NOT NULL DEFAULT 0,
  vouchers      integer NOT NULL DEFAULT 0,
  masters       integer NOT NULL DEFAULT 0,

  -- Kept verbatim. Rewording a Tally or network error into something friendly
  -- destroys the one string that identifies the fault.
  error         text NOT NULL DEFAULT '',
  error_kind    text NOT NULL DEFAULT ''
);

-- The two questions asked of this table: "how is this shop doing lately" and
-- "when did it last work".
CREATE INDEX IF NOT EXISTS sync_runs_org_idx ON sync_runs (org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_fail_idx
  ON sync_runs (org_id, started_at DESC) WHERE NOT ok;

/*
 * Log lines shipped up from the shop's PC.
 *
 * Pulled rather than pushed continuously: sending every line would be constant
 * traffic on a slow connection to say nothing is wrong. The app asks for them
 * when somebody is actually looking at a problem.
 */
CREATE TABLE IF NOT EXISTS connector_logs (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connector_id uuid REFERENCES connectors(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  -- 'info' | 'warn' | 'error'. Classified on the connector, which is the only
  -- place that knows what the line meant.
  level        text NOT NULL DEFAULT 'info',
  line         text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS connector_logs_idx ON connector_logs (org_id, at DESC);

/*
 * Instructions waiting for a connector to collect.
 *
 * A shop PC sits behind a home router with no reachable port, so nothing can
 * be sent to it. Everything we want it to do has to wait here until its next
 * heartbeat asks. That is why "sync now" from the app is a request, not a
 * command, and why the UI must say so.
 */
CREATE TABLE IF NOT EXISTS connector_commands (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  connector_id uuid REFERENCES connectors(id) ON DELETE CASCADE,
  -- 'sync' | 'reconcile' | 'logs'
  kind         text NOT NULL,
  args         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  taken_at     timestamptz,
  done_at      timestamptz,
  ok           boolean,
  result       text NOT NULL DEFAULT ''
);

-- Only ever queried for "what is outstanding for this connector".
CREATE INDEX IF NOT EXISTS connector_commands_pending_idx
  ON connector_commands (connector_id, created_at) WHERE taken_at IS NULL;

ALTER TABLE connectors
  -- How often to sync, set from the app rather than compiled into the shortcut
  -- on the customer's desktop - changing it should not need a reinstall.
  ADD COLUMN IF NOT EXISTS sync_interval_seconds integer NOT NULL DEFAULT 3,
  -- What Tally actually is over there. "Not supported" is a very different
  -- support call from "not running", and only the connector can tell us.
  ADD COLUMN IF NOT EXISTS tally_edition text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tally_release text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS tally_url text NOT NULL DEFAULT '';

ALTER TABLE connectors
  DROP CONSTRAINT IF EXISTS connectors_interval_ck,
  ADD  CONSTRAINT connectors_interval_ck
       CHECK (sync_interval_seconds BETWEEN 3 AND 3600);
