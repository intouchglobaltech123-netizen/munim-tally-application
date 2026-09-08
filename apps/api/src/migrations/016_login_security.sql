-- Who signed in, from where, and what went wrong.
--
-- Sign-in is Google-only, so there is no password here to steal. What remains
-- worth defending is the account itself: somebody replaying stolen ID tokens,
-- or grinding the app sign-in code. Neither is visible without a record of
-- attempts, and neither can be stopped without counting them.

CREATE TABLE IF NOT EXISTS login_events (
  id          bigserial PRIMARY KEY,
  -- Nullable: a failed attempt may name an account that does not exist, and
  -- that attempt is exactly the one worth keeping.
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  org_id      uuid REFERENCES orgs(id) ON DELETE CASCADE,

  email       text NOT NULL DEFAULT '',
  at          timestamptz NOT NULL DEFAULT now(),
  ok          boolean NOT NULL,
  -- 'google' | 'app-code'
  via         text NOT NULL DEFAULT '',
  reason      text NOT NULL DEFAULT '',

  device_kind  text NOT NULL DEFAULT '',
  device_label text NOT NULL DEFAULT '',
  -- Truncated to a /24 before it is stored. Enough to tell "same broadband
  -- line" from "another country", which is the only question anyone asks of
  -- it, without keeping a precise record of where a shop owner was sitting.
  ip_prefix    text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS login_events_user_idx ON login_events (user_id, at DESC);
-- The lockout check reads by email, including for accounts that do not exist.
CREATE INDEX IF NOT EXISTS login_events_email_idx ON login_events (lower(email), at DESC)
  WHERE NOT ok;

ALTER TABLE users
  -- Set when too many attempts fail in a row. A timed lock rather than a
  -- permanent one: a real owner locked out for good is a lost customer, and
  -- the point is to make grinding slow, not to punish a fat-fingered login.
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

ALTER TABLE sessions
  -- A name the owner gave this device ("Shop counter iPad"), so the device
  -- list is readable by the person who has to police it. The automatic label
  -- is a user-agent string, which nobody can match to a physical object.
  ADD COLUMN IF NOT EXISTS nickname text NOT NULL DEFAULT '',
  -- Trusted devices skip the extra confirmation an unfamiliar one gets.
  ADD COLUMN IF NOT EXISTS trusted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_ip_prefix text NOT NULL DEFAULT '';

/*
 * A lock the owner puts on the app itself.
 *
 * The account is protected by Google, including whatever two-factor the owner
 * has on it there - which is stronger than anything we could add, and free.
 * What Google cannot protect is the phone already signed in and lying on the
 * shop counter. This is that: a PIN or fingerprint in front of the figures.
 *
 * Only a hash is stored. A PIN is short enough to brute force offline, so it
 * is salted per user and the app enforces its own attempt limit as well.
 */
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS app_lock_hash text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS app_lock_salt text NOT NULL DEFAULT '',
  -- Minutes of inactivity before the lock re-engages. 0 means "every time the
  -- app opens". Never applied to the SESSION, which by deliberate design does
  -- not expire - this locks the screen, it does not sign anybody out.
  ADD COLUMN IF NOT EXISTS app_lock_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS app_lock_biometric boolean NOT NULL DEFAULT true;
