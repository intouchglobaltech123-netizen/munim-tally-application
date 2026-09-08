-- Telling somebody that something happened.
--
-- The mobile app could already raise a local notification when new vouchers
-- arrived, by comparing counts on screen. That works only while the app is
-- open, only on one device, and only for one event. This is the rest: events
-- detected where they actually happen - at ingest, at a failed sync, at a bill
-- falling due - and a feed anybody on the account can read.

CREATE TABLE IF NOT EXISTS notifications (
  id         bigserial PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,

  -- 'sale.new', 'bill.overdue', 'sync.failed', … See lib/events.js.
  event      text NOT NULL,
  -- 'info' | 'warn' | 'bad'. What colour it reads as, decided once.
  level      text NOT NULL DEFAULT 'info',

  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  -- Where tapping it should go, as an app route rather than a URL: the two
  -- apps route differently and neither should parse the other's paths.
  link       jsonb NOT NULL DEFAULT '{}'::jsonb,

  /*
   * What it is about, so the same thing is not announced twice.
   *
   * A bill falling overdue is one event however many times the check runs, and
   * without a key every pass would raise it again.
   */
  dedupe_key text NOT NULL DEFAULT '',

  at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, event, dedupe_key)
);

CREATE INDEX IF NOT EXISTS notifications_feed ON notifications (org_id, at DESC);

/*
 * Read state, per person.
 *
 * Separate from the notification because one event goes to several people and
 * each reads it at their own time. A row here means "this person has seen it".
 */
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id bigint NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

/*
 * Which events are on, for whom, and with what threshold.
 *
 * One row per event per org. Absent means the built-in default, so a new event
 * type works for every existing customer without a backfill.
 */
CREATE TABLE IF NOT EXISTS notification_rules (
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  event      text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,

  -- Below this, do not bother anybody. In paise, and meaningless for events
  -- that carry no amount.
  min_amount_paise bigint NOT NULL DEFAULT 0,

  /*
   * Who hears about it.
   *
   * Empty means everybody who can see the section it belongs to - which is the
   * sensible default and avoids an owner having to enumerate their staff
   * before notifications work at all.
   */
  roles      text[] NOT NULL DEFAULT '{}',

  PRIMARY KEY (org_id, event)
);

ALTER TABLE users
  -- Nothing between these hours. A shop owner does not want their phone lit up
  -- at 2am because a scheduled sync finished.
  ADD COLUMN IF NOT EXISTS quiet_from smallint NOT NULL DEFAULT 22,
  ADD COLUMN IF NOT EXISTS quiet_to   smallint NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS notify_muted boolean NOT NULL DEFAULT false;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_quiet_ck,
  ADD  CONSTRAINT users_quiet_ck
       CHECK (quiet_from BETWEEN 0 AND 23 AND quiet_to BETWEEN 0 AND 23);
