-- Backups of Munim's copy of the books.
--
-- Worth being exact about what this is and is not. Munim reads Tally and never
-- writes to it, so a backup here is a copy of what Munim holds, and a restore
-- puts it back into Munim. Neither touches the customer's Tally company file -
-- that remains their own responsibility, and the screen says so rather than
-- letting somebody believe their accounting software is covered.
--
-- What it IS good for: a shop whose PC dies still has every voucher, party and
-- bill in a file they own; a company removed from Munim can be put back
-- without waiting for a full re-sync; and an accountant can be handed the data
-- without being given a login.

CREATE TABLE IF NOT EXISTS backups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id  uuid REFERENCES companies(id) ON DELETE SET NULL,
  -- Kept as text as well, so a backup still names its company after that
  -- company has been removed - which is exactly when it is needed.
  company_name text NOT NULL DEFAULT '',

  -- 'full' | 'incremental'. An incremental carries only what changed since the
  -- parent, and is useless without it - hence the reference.
  kind        text NOT NULL DEFAULT 'full',
  parent_id   uuid REFERENCES backups(id) ON DELETE SET NULL,

  -- 'manual' | 'scheduled'
  trigger     text NOT NULL DEFAULT 'manual',
  status      text NOT NULL DEFAULT 'ready',

  /*
   * The archive itself, gzipped.
   *
   * In Postgres rather than object storage: a shop's entire book is a few
   * megabytes, and a bucket would mean credentials, egress and a second thing
   * to lose. Retention keeps it from growing without bound.
   */
  payload     bytea,
  size_bytes  bigint NOT NULL DEFAULT 0,
  raw_bytes   bigint NOT NULL DEFAULT 0,

  /*
   * SHA-256 of the uncompressed archive.
   *
   * A backup nobody has verified is a guess. This is checked on download and
   * again on restore, so a truncated or altered file is refused rather than
   * quietly restoring half a book.
   */
  checksum    text NOT NULL DEFAULT '',

  -- What is inside, for the history screen.
  counts      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The cut-off. An incremental taken later carries everything after this.
  taken_upto  timestamptz,

  error       text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE backups
  DROP CONSTRAINT IF EXISTS backups_kind_ck,
  ADD  CONSTRAINT backups_kind_ck CHECK (kind IN ('full', 'incremental')),
  DROP CONSTRAINT IF EXISTS backups_status_ck,
  ADD  CONSTRAINT backups_status_ck CHECK (status IN ('ready', 'failed'));

CREATE INDEX IF NOT EXISTS backups_org_idx ON backups (org_id, created_at DESC);

ALTER TABLE orgs
  -- How many to keep. Older ones are dropped as new ones are taken, so a
  -- shop's storage cannot grow forever without anybody noticing.
  ADD COLUMN IF NOT EXISTS backup_keep integer NOT NULL DEFAULT 10,
  -- 'off' | 'daily' | 'weekly'. The connector asks on its heartbeat whether
  -- one is due, because nothing else in this system runs on a timer.
  ADD COLUMN IF NOT EXISTS backup_schedule text NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS backup_last_at timestamptz;

ALTER TABLE orgs
  DROP CONSTRAINT IF EXISTS orgs_backup_schedule_ck,
  ADD  CONSTRAINT orgs_backup_schedule_ck
       CHECK (backup_schedule IN ('off', 'daily', 'weekly')),
  DROP CONSTRAINT IF EXISTS orgs_backup_keep_ck,
  ADD  CONSTRAINT orgs_backup_keep_ck CHECK (backup_keep BETWEEN 1 AND 60);
