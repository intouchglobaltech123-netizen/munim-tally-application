-- Support tickets.
--
-- Kept inside the product rather than pointed at an email address, for one
-- reason that matters more than any other: a ticket raised here already knows
-- which account, which company, which connector and which Tally version it came
-- from. An email does not, and the first three replies are always spent asking.

CREATE TABLE IF NOT EXISTS tickets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- The number a customer reads out on the phone. Short, and unique across the
  -- platform rather than per tenant, so support never has to ask "whose #14?".
  number       int NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Kept as text as well, so a ticket survives the person leaving. Same reason
  -- the audit log does it.
  raised_by    text NOT NULL DEFAULT '',
  raised_email text NOT NULL DEFAULT '',
  company_id   uuid REFERENCES companies(id) ON DELETE SET NULL,
  subject      text NOT NULL,
  category     text NOT NULL DEFAULT 'other',
  priority     text NOT NULL DEFAULT 'normal'
               CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'waiting_on_us', 'waiting_on_you',
                                 'resolved', 'closed')),
  -- A snapshot of the environment at the moment it was raised. Frozen on
  -- purpose: by the time somebody looks, the connector may have been restarted
  -- and the very thing that broke is gone.
  diagnostics  jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_to  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  first_reply_at timestamptz,
  resolved_at  timestamptz,
  -- Asked once, when it is closed, while the experience is fresh.
  rating       int CHECK (rating BETWEEN 1 AND 5),
  rating_note  text NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS tickets_number_uniq ON tickets (number);
CREATE INDEX IF NOT EXISTS tickets_org_idx ON tickets (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tickets_open_idx ON tickets (status, priority, created_at)
  WHERE status IN ('open', 'waiting_on_us');

-- A sequence rather than max(number)+1, which two people pressing Send at the
-- same moment would both read as the same value.
CREATE SEQUENCE IF NOT EXISTS ticket_number_seq START 1000;

CREATE TABLE IF NOT EXISTS ticket_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  author     text NOT NULL DEFAULT '',
  -- Whether this came from the customer or from Munim. Stored rather than
  -- inferred from the role, because a staff member can also be a customer.
  from_staff boolean NOT NULL DEFAULT false,
  -- A note staff can leave that the customer never sees. Marked at write time,
  -- never filtered at read time: a read-time filter is one forgotten WHERE
  -- clause away from showing a customer what was said about them.
  internal   boolean NOT NULL DEFAULT false,
  body       text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_messages_idx ON ticket_messages (ticket_id, at);

-- Attachments, stored inline like backups.
--
-- A screenshot of a Tally error is the single most useful thing a customer can
-- send, and making them find a file host to do it means they send a description
-- instead.
CREATE TABLE IF NOT EXISTS ticket_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  message_id  uuid REFERENCES ticket_messages(id) ON DELETE CASCADE,
  filename    text NOT NULL,
  content_type text NOT NULL DEFAULT '',
  size_bytes  int NOT NULL DEFAULT 0,
  data        bytea,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ticket_files_idx ON ticket_files (ticket_id);
