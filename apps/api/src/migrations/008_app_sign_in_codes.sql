-- Signing in on the phone without Google on the phone.
--
-- Google refuses OAuth from a Web client on a handset, so the phone would need
-- its own Android OAuth client, which needs a signing fingerprint, which needs
-- a full native build. That is a lot of machinery for "let me see my books on
-- my phone".
--
-- Instead: the owner is already signed in on the web, on a screen only they can
-- see. Show a short code there; type it into the app. Same shape as pairing a
-- Tally PC, which already works, and it needs nothing from Google.
--
-- The code is a bearer of a session, so it is deliberately weak on purpose in
-- one direction only: short-lived, single-use, and issued only to an
-- already-authenticated browser.

CREATE TABLE IF NOT EXISTS app_sign_in_codes (
  code        text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  -- How many wrong guesses have been aimed at this code. A short code is only
  -- safe while nobody can sit and try them all.
  attempts    int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS app_sign_in_codes_user_idx ON app_sign_in_codes (user_id);
CREATE INDEX IF NOT EXISTS app_sign_in_codes_expiry_idx ON app_sign_in_codes (expires_at);
