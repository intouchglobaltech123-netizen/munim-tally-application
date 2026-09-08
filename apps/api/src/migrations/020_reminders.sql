-- Chasing money, properly.
--
-- What was here before recorded a reminder as "sent" and charged a message
-- credit for it, while sending nothing at all - the button opened WhatsApp and
-- the row said delivered. That is a lie in the customer's own audit trail, and
-- it billed them for it.
--
-- This models what actually happens: Munim decides WHO to chase and WHEN,
-- writes the message, and hands it to WhatsApp or the mail app on the owner's
-- own device. The owner presses send. We record that we handed it over, which
-- is the last thing we honestly know.

CREATE TABLE IF NOT EXISTS reminder_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       text NOT NULL,
  channel    text NOT NULL DEFAULT 'whatsapp',
  -- Placeholders are {{party}}, {{amount}}, {{bills}}, {{days}}, {{company}},
  -- {{phone}}. Kept as plain text with braces rather than a template language:
  -- a shop owner has to be able to read and edit this without help.
  body       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

/*
 * When to chase.
 *
 * A rule is deliberately narrow: one trigger, one offset, one message. Shops
 * ask for "a polite note three days before, a firm one a week after", which is
 * two rules - and two rules a person can read beats one rule with a schedule
 * language nobody can.
 */
CREATE TABLE IF NOT EXISTS reminder_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name        text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,

  -- 'before' | 'on' | 'after' the due date.
  trigger     text NOT NULL DEFAULT 'after',
  days        integer NOT NULL DEFAULT 0,

  channel     text NOT NULL DEFAULT 'whatsapp',
  template_id uuid REFERENCES reminder_templates(id) ON DELETE SET NULL,

  -- Below this, chasing costs more than the debt is worth.
  min_amount_paise bigint NOT NULL DEFAULT 0,
  -- Do not pester: once a bill has been chased, wait this long before it can
  -- appear again, and stop entirely after this many attempts.
  repeat_days integer NOT NULL DEFAULT 7,
  max_reminders integer NOT NULL DEFAULT 3,

  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

ALTER TABLE reminder_rules
  DROP CONSTRAINT IF EXISTS reminder_rules_trigger_ck,
  ADD  CONSTRAINT reminder_rules_trigger_ck CHECK (trigger IN ('before', 'on', 'after')),
  DROP CONSTRAINT IF EXISTS reminder_rules_days_ck,
  ADD  CONSTRAINT reminder_rules_days_ck CHECK (days BETWEEN 0 AND 365);

/*
 * What happened to each reminder.
 *
 * `status` says what we actually know, and no more:
 *   queued     - Munim decided this should be chased
 *   handed-off - the owner opened WhatsApp or mail with it ready
 *   sent       - the owner confirmed they sent it
 *   skipped    - the owner passed on it
 *   failed     - the hand-off itself did not work
 *
 * There is deliberately no "delivered": handing a message to WhatsApp tells us
 * nothing about whether it arrived, and claiming otherwise would make the
 * history worthless.
 */
ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS rule_id      uuid REFERENCES reminder_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS template_id  uuid REFERENCES reminder_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bill_refs    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS due_date     date,
  ADD COLUMN IF NOT EXISTS days_overdue integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS message      text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS handed_off_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by   uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE reminders
  DROP CONSTRAINT IF EXISTS reminders_status_ck,
  ADD  CONSTRAINT reminders_status_ck
       CHECK (status IN ('queued', 'handed-off', 'sent', 'skipped', 'failed'));

CREATE INDEX IF NOT EXISTS reminders_party_idx ON reminders (org_id, party, sent_at DESC);

ALTER TABLE ledgers
  -- A customer who has asked not to be chased, or one the owner handles
  -- personally. Munim's own flag: Tally has no such concept.
  ADD COLUMN IF NOT EXISTS no_reminders boolean NOT NULL DEFAULT false;
