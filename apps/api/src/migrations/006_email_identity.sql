-- Phone was the only way in, and SMS is the only part of authentication that
-- costs money: Firebase bills per message, while Google Sign-In is free to
-- 50,000 monthly users. Supporting a second identity is what makes ₹0 auth
-- possible - and it is also how someone signs in when their SIM is lost.
--
-- So a user is now identified by a phone, an email, or both.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email        text,
  ADD COLUMN IF NOT EXISTS firebase_uid text;

-- Phone can no longer be required, since a Google sign-in carries no number.
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;

-- But an account with neither is unreachable and unrecoverable: nobody could
-- ever sign back in to it.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_has_identity;
ALTER TABLE users
  ADD CONSTRAINT users_has_identity
  CHECK (phone IS NOT NULL OR email IS NOT NULL);

-- Partial unique indexes, not UNIQUE constraints: several users may have a NULL
-- phone (they signed in with Google) and NULL is not equal to NULL, but a plain
-- UNIQUE would still be the wrong shape to reason about here.
DROP INDEX IF EXISTS users_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key
  ON users (lower(email)) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid_key
  ON users (firebase_uid) WHERE firebase_uid IS NOT NULL;
