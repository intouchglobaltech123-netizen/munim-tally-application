-- Writing back to Tally.
--
-- Until now Munim only read. This is the table that changes that, and every
-- column on it exists to answer one question: how do we make absolutely certain
-- a customer's books never receive the same voucher twice, or a voucher they did
-- not agree to?
--
-- The shape is an OUTBOX, not a direct write. Nothing in the app talks to Tally;
-- it writes a row here, and the connector on the shop's own PC picks it up. That
-- matters because Tally is only reachable from that machine, because the shop's
-- internet can drop mid-post, and because a queue can be inspected before it is
-- sent - which a direct write cannot.

CREATE TABLE IF NOT EXISTS voucher_drafts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  /*
   * The identity Tally itself will carry.
   *
   * Written into the voucher's REMOTEID field on import. It is what makes this
   * safe to retry: before posting, the connector asks Tally whether a voucher
   * with this REMOTEID already exists, so a batch that was cut off after Tally
   * accepted it but before we heard back does not post a second copy. Without
   * it, a dropped connection is a duplicate invoice.
   */
  remote_id     uuid NOT NULL DEFAULT gen_random_uuid(),

  kind          text NOT NULL
                CHECK (kind IN ('sales','purchase','receipt','payment','contra',
                                'journal','credit-note','debit-note')),
  -- The Tally voucher type name, which is per-company and user-renameable, so
  -- it is stored rather than derived from `kind`.
  vch_type      text NOT NULL,
  -- Left empty to let Tally allocate from its own numbering series, which is
  -- what keeps Munim out of the business of guessing the next invoice number.
  vch_no        text NOT NULL DEFAULT '',
  vch_date      date NOT NULL,
  party         text NOT NULL DEFAULT '',
  narration     text NOT NULL DEFAULT '',

  -- The ledger legs. Positive is debit, the same convention as everywhere else
  -- in this codebase.
  entries       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Stock lines, for an invoice that carries them.
  items         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Bill references, so a receipt can settle a named invoice.
  bills         jsonb NOT NULL DEFAULT '[]'::jsonb,

  amount_paise  bigint NOT NULL DEFAULT 0,

  /*
   * draft    - being written, changeable, never sent
   * queued   - the customer pressed send; the connector may pick it up
   * sending  - a connector has leased it and is talking to Tally
   * posted   - Tally accepted it
   * rejected - Tally refused it, and `error` says why
   * cancelled- withdrawn before it was sent
   */
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','queued','sending','posted','rejected','cancelled')),

  -- Set when a connector takes it, cleared when it finishes. A lease rather
  -- than a flag: a connector that dies mid-post would otherwise strand the row
  -- in `sending` for ever.
  leased_by     uuid REFERENCES connectors(id) ON DELETE SET NULL,
  leased_until  timestamptz,
  attempts      int NOT NULL DEFAULT 0,

  -- What Tally gave back.
  tally_guid    text NOT NULL DEFAULT '',
  tally_vch_no  text NOT NULL DEFAULT '',
  error         text NOT NULL DEFAULT '',
  -- Tally's own words, kept separately from our summary of them.
  tally_response text NOT NULL DEFAULT '',

  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_name  text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  posted_at     timestamptz
);

-- One voucher per remote id, for ever. This is the database half of the
-- idempotency guarantee; the connector's REMOTEID check is the Tally half.
CREATE UNIQUE INDEX IF NOT EXISTS voucher_drafts_remote_uniq
  ON voucher_drafts (remote_id);

CREATE INDEX IF NOT EXISTS voucher_drafts_org_idx
  ON voucher_drafts (org_id, created_at DESC);

-- The connector's queue: what is waiting, oldest first.
CREATE INDEX IF NOT EXISTS voucher_drafts_outbox_idx
  ON voucher_drafts (company_id, status, created_at)
  WHERE status IN ('queued', 'sending');

/*
 * Writing is off unless it is deliberately switched on.
 *
 * Munim was a read-only product, and every customer who signed up before this
 * existed agreed to that. Defaulting it on would start writing into their books
 * because we shipped a release, which is not a decision that belongs to us.
 */
ALTER TABLE orgs
  ADD COLUMN IF NOT EXISTS writes_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS writes_enabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS writes_enabled_by uuid REFERENCES users(id) ON DELETE SET NULL;
