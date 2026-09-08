-- Sign in once, stay signed in.
--
-- A 60-day session meant every customer signed in about six times a year. Each
-- of those was a chance to be locked out on a busy day, and under the old SMS
-- route each one cost money. Nothing about an accounting app needs the owner
-- re-proving who they are every two months on a phone only they hold.
--
-- Sessions still end - but only when somebody decides they should: signing out,
-- or "sign out all other devices" after a phone is lost. That is revocation,
-- which is the control that actually matters. An expiry timer is not security,
-- it is a chore.
ALTER TABLE sessions ALTER COLUMN expires_at DROP NOT NULL;

-- Existing sessions stop counting down.
UPDATE sessions
   SET expires_at = NULL
 WHERE revoked_at IS NULL;
