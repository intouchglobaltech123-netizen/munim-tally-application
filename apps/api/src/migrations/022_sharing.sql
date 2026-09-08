-- Sharing anything, and keeping a record of it.
--
-- Invoices and reminders could already be shared; everything else could not,
-- and nothing was written down. "Did we send Verma his statement?" had no
-- answer, which is the question that gets asked when a customer disputes one.

CREATE TABLE IF NOT EXISTS share_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- What this template is for: 'statement' | 'outstanding' | 'invoice'
  -- | 'voucher' | 'report' | 'item'. One default per kind, editable.
  kind       text NOT NULL,
  name       text NOT NULL,
  body       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, name)
);

/*
 * What was shared, with whom, and when.
 *
 * `status` carries the same honesty as reminders: 'handed-off' is the last
 * thing we know for certain, because handing a message to WhatsApp says
 * nothing about whether it arrived. There is no 'delivered' here and there
 * cannot be one without a paid Business API account.
 */
CREATE TABLE IF NOT EXISTS share_log (
  id         bigserial PRIMARY KEY,
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,

  kind       text NOT NULL,
  subject    text NOT NULL DEFAULT '',
  channel    text NOT NULL DEFAULT 'whatsapp',
  recipient  text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'handed-off',
  message    text NOT NULL DEFAULT '',
  at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE share_log
  DROP CONSTRAINT IF EXISTS share_log_status_ck,
  ADD  CONSTRAINT share_log_status_ck
       CHECK (status IN ('handed-off', 'sent', 'failed'));

CREATE INDEX IF NOT EXISTS share_log_idx ON share_log (org_id, at DESC);
CREATE INDEX IF NOT EXISTS share_log_subject_idx ON share_log (org_id, kind, subject);
