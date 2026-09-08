-- Deleting an account, and getting back into one.
--
-- Two problems that look unrelated and are the same problem: what happens when
-- the person holding the account is no longer the person who should hold it.

-- Deletion is a REQUEST with a date attached, not an immediate wipe.
--
-- A shop owner who taps delete in anger on a Friday wants their books back on
-- Monday, and a disgruntled staff member with the owner's phone should not be
-- able to destroy a business in one tap. The grace period is the whole feature;
-- everything else here is bookkeeping around it.
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS delete_requested_at  timestamptz,
  ADD COLUMN IF NOT EXISTS delete_requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delete_due_at        timestamptz,
  ADD COLUMN IF NOT EXISTS delete_reason        text NOT NULL DEFAULT '',
  -- A second address that is NOT a login. Its only power is to be told that a
  -- deletion was requested, and to be the route back in when the sole owner is
  -- unreachable. Deliberately not a credential.
  ADD COLUMN IF NOT EXISTS recovery_email       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recovery_phone       text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recovery_set_at      timestamptz;

-- Both dates or neither: a pending deletion with no due date would sit for ever
-- and a due date with no request would fire without one.
ALTER TABLE orgs DROP CONSTRAINT IF EXISTS orgs_deletion_dates;
ALTER TABLE orgs ADD CONSTRAINT orgs_deletion_dates CHECK (
  (delete_requested_at IS NULL AND delete_due_at IS NULL)
  OR (delete_requested_at IS NOT NULL AND delete_due_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS orgs_delete_due_idx ON orgs (delete_due_at)
  WHERE delete_due_at IS NOT NULL;

-- Handing the business to somebody else.
--
-- Recorded as its own table rather than an audit line because it is a two-step
-- action with a window in between, and a half-finished transfer has to be
-- visible to both people.
CREATE TABLE IF NOT EXISTS owner_transfers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id)  ON DELETE CASCADE,
  from_user_id uuid          REFERENCES users(id) ON DELETE SET NULL,
  to_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  settled_at   timestamptz
);

-- One open offer per business. Two racing transfers could otherwise both be
-- accepted and the second would silently demote the first new owner.
CREATE UNIQUE INDEX IF NOT EXISTS owner_transfers_one_open
  ON owner_transfers (org_id) WHERE status = 'pending';
