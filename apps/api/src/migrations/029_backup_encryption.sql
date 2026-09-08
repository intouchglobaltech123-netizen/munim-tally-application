-- Encryption at rest for backups.
--
-- A backup payload is the customer's whole book. The columns below carry the
-- envelope, not the key: iv and tag are not secret and are useless without the
-- master key, which lives in the environment and never in this database. That
-- separation is the point - a stolen dump without the key is noise.
--
-- enc_alg 'none' marks a row written before encryption was switched on. Those
-- stay readable rather than being stranded, and are re-sealed the next time a
-- backup is taken.

ALTER TABLE backups
  ADD COLUMN IF NOT EXISTS enc_alg text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS enc_iv  bytea,
  ADD COLUMN IF NOT EXISTS enc_tag bytea;

-- A sealed row without its IV or tag can never be opened again, so the shape is
-- enforced here rather than trusted to the application.
ALTER TABLE backups DROP CONSTRAINT IF EXISTS backups_envelope_complete;
ALTER TABLE backups ADD CONSTRAINT backups_envelope_complete CHECK (
  (enc_alg = 'none' AND enc_iv IS NULL AND enc_tag IS NULL)
  OR (enc_alg <> 'none' AND enc_iv IS NOT NULL AND enc_tag IS NOT NULL)
);
