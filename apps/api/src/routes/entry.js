'use strict';
const { query, tx } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const audit = require('../lib/audit');
const { dateOnly } = audit;
const { HttpError, bad } = require('../lib/http');

/**
 * Creating a voucher, and sending it to Tally.
 *
 * This is the first thing in Munim that writes to a customer's books, and the
 * whole design is arranged around one fear: putting something into somebody's
 * accounts that they did not agree to, or putting it in twice.
 *
 * Three defences, in order of how much they matter:
 *
 *  1. NOTHING IS SENT UNTIL IT IS SENT. Creating a voucher makes a draft. A
 *     draft is inert - it is not in Tally, it is not in any report, and it can
 *     be edited or thrown away. Sending is a separate, deliberate act.
 *
 *  2. VALIDATION HAPPENS HERE, NOT IN TALLY. A voucher that does not balance,
 *     or that names a ledger the company does not have, is refused before it is
 *     queued. Letting Tally reject it works too, but the error arrives minutes
 *     later on a different machine, and by then the person has moved on.
 *
 *  3. EVERY DRAFT CARRIES ITS OWN IDENTITY. The connector writes it into Tally's
 *     REMOTEID and checks for it before posting, so a connection that drops
 *     between Tally accepting the voucher and us hearing about it cannot produce
 *     a second copy.
 */

/*
 * The kinds Munim can create, and what each one means in double entry.
 *
 * Deliberately not "any voucher type". Tally allows dozens, many of them
 * company-specific with their own rules, and a generic writer that half
 * understands them is worse than one that refuses politely.
 */
const KINDS = {
  sales: {
    label: 'Sales invoice',
    tallyType: 'Sales',
    module: 'sales',
    /*
     * Which way the party leg goes. A sale debits the customer (they owe us)
     * and credits sales income. Getting this backwards produces books that
     * balance and are entirely wrong, so it is stated per kind rather than
     * inferred.
     */
    partySide: 'debit',
    wantsItems: true,
  },
  purchase: {
    label: 'Purchase bill', tallyType: 'Purchase', module: 'purchase',
    partySide: 'credit', wantsItems: true,
  },
  receipt: {
    label: 'Receipt', tallyType: 'Receipt', module: 'cashbank',
    partySide: 'credit', wantsItems: false,
  },
  payment: {
    label: 'Payment', tallyType: 'Payment', module: 'cashbank',
    partySide: 'debit', wantsItems: false,
  },
  contra: {
    label: 'Contra', tallyType: 'Contra', module: 'cashbank',
    partySide: null, wantsItems: false,
  },
  journal: {
    label: 'Journal', tallyType: 'Journal', module: 'reports',
    partySide: null, wantsItems: false,
  },
  'credit-note': {
    label: 'Credit note', tallyType: 'Credit Note', module: 'sales',
    partySide: 'credit', wantsItems: true,
  },
  'debit-note': {
    label: 'Debit note', tallyType: 'Debit Note', module: 'purchase',
    partySide: 'debit', wantsItems: true,
  },
};

/** How long a connector may hold a draft before another may retry it. */
const LEASE_MINUTES = 5;
const MAX_ATTEMPTS = 3;

async function companyFor(session, guid) {
  const { rows } = await query(
    'SELECT * FROM companies WHERE org_id = $1 AND tally_guid = $2',
    [session.org.id, guid]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such company.');
  return rows[0];
}

/**
 * Writing has to be switched on, per business.
 *
 * Every customer who signed up before this feature existed agreed to a product
 * that only read. Turning it on for them because we shipped a release is not a
 * decision that belongs to us.
 */
async function assertWritesOn(orgId) {
  const { rows } = await query(
    'SELECT writes_enabled FROM orgs WHERE id = $1', [orgId]);
  if (!rows[0]?.writes_enabled) {
    throw new HttpError(403, 'WRITES_OFF',
      'Creating entries in Tally is switched off for this business. An owner can '
      + 'turn it on in Settings — until then Munim only reads.');
  }
}

/**
 * Check a voucher hard enough that Tally will not be the one to refuse it.
 *
 * Returns the problems as a list rather than throwing on the first, because
 * somebody filling in a form wants to fix everything at once, not discover the
 * next fault after each save.
 */
async function validate(company, kind, body) {
  const def = KINDS[kind];
  const problems = [];

  const date = String(body.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    problems.push('Give a date as YYYY-MM-DD.');
  } else {
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) problems.push('That date is not a real date.');
    /*
     * A voucher dated years out is nearly always a typo - 2025 typed as 2052 -
     * and it lands in a period nobody looks at. Tally would accept it happily.
     */
    const years = Math.abs(d.getFullYear() - new Date().getFullYear());
    if (years > 5) problems.push(`${date} is ${years} years away. Check the year.`);
  }

  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (entries.length < 2) {
    problems.push('A voucher needs at least two ledger lines — what was received '
                + 'and what it was for.');
  }

  let debits = 0;
  let credits = 0;
  const names = [];
  for (const [i, e] of entries.entries()) {
    const name = String(e?.ledger ?? '').trim();
    const paise = Math.round(Number(e?.amountPaise));
    if (!name) { problems.push(`Line ${i + 1} has no ledger.`); continue; }
    if (!Number.isFinite(paise) || paise === 0) {
      problems.push(`Line ${i + 1} (${name}) has no amount.`);
      continue;
    }
    names.push(name);
    if (paise > 0) debits += paise; else credits += -paise;
  }

  /*
   * Debits must equal credits, to the paisa.
   *
   * Tally will refuse an unbalanced voucher, but it refuses it on a machine in
   * a shop, minutes later, with a message nobody sees. Checking here means the
   * person who typed it is still looking at it.
   */
  if (entries.length >= 2 && debits !== credits) {
    const diff = Math.abs(debits - credits);
    problems.push(
      `This does not balance: ₹${(debits / 100).toLocaleString('en-IN')} debit `
      + `against ₹${(credits / 100).toLocaleString('en-IN')} credit, `
      + `a difference of ₹${(diff / 100).toLocaleString('en-IN')}.`);
  }

  /*
   * Every ledger must already exist in Tally.
   *
   * Munim will not create ledgers. A misspelt customer name would otherwise
   * silently become a second account, and merging those afterwards is a job for
   * an accountant and an evening.
   */
  if (names.length) {
    const { rows: known } = await query(
      `SELECT name FROM ledgers WHERE company_id = $1 AND name = ANY($2::text[])`,
      [company.id, names]);
    const have = new Set(known.map((r) => r.name));
    for (const n of names) {
      if (!have.has(n)) {
        problems.push(`"${n}" is not a ledger in this company. Create it in Tally `
                    + 'first — Munim will not add ledgers on its own.');
      }
    }
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length && !def.wantsItems) {
    problems.push(`A ${def.label.toLowerCase()} does not carry stock items.`);
  }
  if (items.length) {
    const itemNames = items.map((i) => String(i?.item ?? '').trim()).filter(Boolean);
    const { rows: known } = await query(
      `SELECT name FROM stock_items WHERE company_id = $1 AND name = ANY($2::text[])`,
      [company.id, itemNames]);
    const have = new Set(known.map((r) => r.name));
    for (const n of itemNames) {
      if (!have.has(n)) problems.push(`"${n}" is not a stock item in this company.`);
    }
    for (const [i, it] of items.entries()) {
      if (!(Number(it?.qty) > 0)) problems.push(`Item line ${i + 1} has no quantity.`);
    }
  }

  return { problems, debits, credits };
}

const draftOut = (d) => ({
  id: d.id,
  kind: d.kind,
  kindLabel: KINDS[d.kind]?.label ?? d.kind,
  vchType: d.vch_type,
  number: d.vch_no || null,
  tallyNumber: d.tally_vch_no || null,
  date: dateOnly(d.vch_date),
  party: d.party,
  narration: d.narration,
  entries: d.entries,
  items: d.items,
  bills: d.bills,
  amountPaise: Number(d.amount_paise),
  status: d.status,
  statusLabel: {
    draft: 'Draft — not in Tally',
    queued: 'Waiting for your Tally computer',
    sending: 'Being written to Tally',
    posted: 'In Tally',
    rejected: 'Tally refused it',
    cancelled: 'Withdrawn',
  }[d.status] ?? d.status,
  error: d.error,
  tallyResponse: d.tally_response || null,
  tallyGuid: d.tally_guid || null,
  attempts: d.attempts,
  createdBy: d.created_name,
  createdAt: d.created_at,
  sentAt: d.sent_at,
  postedAt: d.posted_at,
  /*
   * Whether the customer can still change it. Computed here so the two apps
   * cannot disagree about whether an edit box should be open.
   */
  editable: d.status === 'draft' || d.status === 'rejected',
});

/** What the entry screen needs: kinds, ledgers, items, and recent drafts. */
async function options(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);

  const { rows: org } = await query(
    'SELECT writes_enabled FROM orgs WHERE id = $1', [s.org.id]);

  const [ledgers, items, types] = await Promise.all([
    query(`SELECT name, parent_group, closing_paise FROM ledgers
            WHERE company_id = $1 ORDER BY name LIMIT 5000`, [co.id]),
    query(`SELECT name, unit, sales_rate_paise, purchase_rate_paise, gst_rate_bp,
                  closing_qty
             FROM stock_items WHERE company_id = $1 ORDER BY name LIMIT 5000`, [co.id]),
    /*
     * The voucher type names this company actually uses, taken from its own
     * history. Tally lets a business rename "Sales" to "Tax Invoice", and
     * posting to a type that does not exist is a rejection.
     */
    query(`SELECT DISTINCT vch_type FROM vouchers
            WHERE company_id = $1 AND vch_type <> '' ORDER BY vch_type`, [co.id]),
  ]);

  return {
    writesEnabled: org[0]?.writes_enabled === true,
    kinds: Object.entries(KINDS)
      .filter(([, def]) => perms.can(s, def.module, 'create'))
      .map(([key, def]) => ({
        key,
        label: def.label,
        tallyType: def.tallyType,
        wantsItems: def.wantsItems,
        partySide: def.partySide,
      })),
    ledgers: ledgers.rows.map((l) => ({
      name: l.name, group: l.parent_group, balancePaise: Number(l.closing_paise),
    })),
    items: items.rows.map((i) => ({
      name: i.name, unit: i.unit,
      salesRatePaise: Number(i.sales_rate_paise ?? 0),
      purchaseRatePaise: Number(i.purchase_rate_paise ?? 0),
      gstRateBp: i.gst_rate_bp ?? 0,
      inStock: Number(i.closing_qty ?? 0),
    })),
    voucherTypes: types.rows.map((t) => t.vch_type),
    note: 'Nothing here reaches Tally until you press Send, and Munim never '
        + 'changes a voucher that is already in your books.',
  };
}

/** Create a draft. Inert until sent. */
async function create(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);

  const kind = String(ctx.body?.kind ?? '');
  const def = KINDS[kind];
  if (!def) throw bad('BAD_KIND', 'Munim cannot create that kind of voucher.');
  perms.require(s, def.module, 'create');

  const { problems, debits } = await validate(co, kind, ctx.body ?? {});
  /*
   * A draft with problems is still saved.
   *
   * Refusing to save half-finished work is how somebody loses ten minutes of
   * typing because a ledger name was wrong. The problems come back with it and
   * sending is what enforces them.
   */
  const { rows } = await query(
    `INSERT INTO voucher_drafts
       (org_id, company_id, kind, vch_type, vch_no, vch_date, party, narration,
        entries, items, bills, amount_paise, created_by, created_name)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14)
     RETURNING *`,
    [s.org.id, co.id, kind,
     String(ctx.body?.vchType ?? def.tallyType).slice(0, 80),
     String(ctx.body?.number ?? '').slice(0, 40),
     ctx.body?.date, String(ctx.body?.party ?? '').slice(0, 200),
     String(ctx.body?.narration ?? '').slice(0, 2000),
     JSON.stringify(ctx.body?.entries ?? []),
     JSON.stringify(ctx.body?.items ?? []),
     JSON.stringify(ctx.body?.bills ?? []),
     debits, s.user.id, s.user.name ?? s.user.email ?? '']);

  await audit.record(ctx, 'entry.draft', {
    companyId: co.id, entityId: rows[0].id,
    entityName: `${def.label} ${ctx.body?.party ?? ''}`.trim(),
    after: { kind, amountPaise: debits, date: ctx.body?.date },
  });

  return { draft: draftOut(rows[0]), problems };
}

/** Change a draft that has not gone anywhere. */
async function update(ctx, id) {
  const s = auth.requireUser(ctx);

  const { rows: existing } = await query(
    'SELECT * FROM voucher_drafts WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!existing.length) throw new HttpError(404, 'NOT_FOUND', 'No such draft.');
  const d = existing[0];

  const def = KINDS[d.kind];
  perms.require(s, def.module, 'update');

  /*
   * Refused once it is anywhere but a draft.
   *
   * Editing a queued voucher would change what gets sent after the person
   * pressed Send, and editing a posted one would show something in Munim that
   * differs from what is in Tally - which is the worst outcome available,
   * because both look authoritative.
   */
  if (!['draft', 'rejected'].includes(d.status)) {
    throw bad('NOT_EDITABLE',
      d.status === 'posted'
        ? 'This is already in Tally. Change it in Tally, or make a credit note.'
        : 'This has been sent and cannot be changed. Cancel it first.');
  }

  const { rows: co } = await query('SELECT * FROM companies WHERE id = $1', [d.company_id]);
  const merged = {
    /*
     * dateOnly, because pg hands a DATE back as a JS Date and the validator
     * wants YYYY-MM-DD. Without it, re-validating a stored draft always failed
     * on "give a date as YYYY-MM-DD" - so a voucher that was fine when typed
     * became unsendable the moment it was read back.
     */
    date: ctx.body?.date ?? dateOnly(d.vch_date),
    entries: ctx.body?.entries ?? d.entries,
    items: ctx.body?.items ?? d.items,
  };
  const { problems, debits } = await validate(co[0], d.kind, merged);

  const { rows } = await query(
    `UPDATE voucher_drafts SET
        vch_type = COALESCE($3, vch_type),
        vch_no = COALESCE($4, vch_no),
        vch_date = COALESCE($5::date, vch_date),
        party = COALESCE($6, party),
        narration = COALESCE($7, narration),
        entries = COALESCE($8::jsonb, entries),
        items = COALESCE($9::jsonb, items),
        bills = COALESCE($10::jsonb, bills),
        amount_paise = $11,
        -- A rejected draft that has been edited is a draft again, and its old
        -- error is no longer about what it now says.
        status = 'draft', error = '', tally_response = '',
        updated_at = now()
      WHERE id = $1 AND org_id = $2 RETURNING *`,
    [id, s.org.id,
     ctx.body?.vchType ?? null, ctx.body?.number ?? null, ctx.body?.date ?? null,
     ctx.body?.party ?? null, ctx.body?.narration ?? null,
     ctx.body?.entries ? JSON.stringify(ctx.body.entries) : null,
     ctx.body?.items ? JSON.stringify(ctx.body.items) : null,
     ctx.body?.bills ? JSON.stringify(ctx.body.bills) : null,
     debits]);

  return { draft: draftOut(rows[0]), problems };
}

/**
 * Send it.
 *
 * The one action in Munim that puts something into a customer's books, so it
 * refuses on any doubt rather than trying its best.
 */
async function send(ctx, id) {
  const s = auth.requireUser(ctx);
  await assertWritesOn(s.org.id);

  const { rows: existing } = await query(
    'SELECT * FROM voucher_drafts WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!existing.length) throw new HttpError(404, 'NOT_FOUND', 'No such draft.');
  const d = existing[0];

  const def = KINDS[d.kind];
  perms.require(s, def.module, 'create');

  if (d.status === 'posted') {
    throw bad('ALREADY_POSTED', 'This is already in Tally.');
  }
  if (['queued', 'sending'].includes(d.status)) {
    throw bad('ALREADY_SENT', 'This is already on its way to Tally.');
  }

  const { rows: co } = await query('SELECT * FROM companies WHERE id = $1', [d.company_id]);
  const { problems } = await validate(co[0], d.kind, {
    date: dateOnly(d.vch_date), entries: d.entries, items: d.items,
  });
  if (problems.length) {
    throw new HttpError(400, 'NOT_VALID',
      `This cannot go to Tally yet: ${problems[0]}`);
  }

  /*
   * There has to be a connector that could actually deliver it.
   *
   * Queueing into a company whose PC has been off for a week leaves somebody
   * believing they invoiced a customer. Better to refuse and say why.
   */
  const { rows: conn } = await query(
    `SELECT count(*)::int AS n FROM connectors
      WHERE org_id = $1 AND revoked_at IS NULL
        AND last_seen_at > now() - interval '1 hour'`, [s.org.id]);
  if (!conn[0].n) {
    throw bad('NO_CONNECTOR',
      'No Tally computer has reported in the last hour, so this cannot be '
      + 'delivered. It stays a draft — switch that computer on and send again.');
  }

  const { rows } = await query(
    `UPDATE voucher_drafts
        SET status = 'queued', sent_at = now(), error = '', updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status IN ('draft','rejected')
      RETURNING *`, [id, s.org.id]);
  if (!rows.length) throw bad('RACE', 'That draft changed while you were sending it.');

  await audit.record(ctx, 'entry.sent', {
    companyId: d.company_id, entityId: id,
    entityName: `${def.label} ${d.party}`.trim(),
    meta: { amountPaise: Number(d.amount_paise), remoteId: d.remote_id },
  });

  return {
    draft: draftOut(rows[0]),
    message: 'Queued. Your Tally computer will write it in within a minute, and '
           + 'this screen will show what Tally said.',
  };
}

/** Withdraw something that has not reached Tally. */
async function cancel(ctx, id) {
  const s = auth.requireUser(ctx);
  const { rows } = await query(
    `UPDATE voucher_drafts SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND org_id = $2 AND status IN ('draft','queued','rejected')
      RETURNING *`, [id, s.org.id]);
  if (!rows.length) {
    throw bad('NOT_CANCELLABLE',
      'That is either already in Tally or already being written. Nothing was changed.');
  }
  await audit.record(ctx, 'entry.cancelled', { entityId: id });
  return { draft: draftOut(rows[0]) };
}

/** What has been created, and where each one got to. */
async function list(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);

  const status = ctx.url.searchParams.get('status');
  const args = [co.id];
  let where = 'company_id = $1';
  if (status) { args.push(status); where += ` AND status = $${args.length}`; }

  const { rows } = await query(
    `SELECT * FROM voucher_drafts WHERE ${where}
      ORDER BY created_at DESC LIMIT 200`, args);

  const { rows: counts } = await query(
    `SELECT status, count(*)::int AS n FROM voucher_drafts
      WHERE company_id = $1 GROUP BY status`, [co.id]);

  return {
    drafts: rows.map(draftOut),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  };
}

async function one(ctx, id) {
  const s = auth.requireUser(ctx);
  const { rows } = await query(
    'SELECT * FROM voucher_drafts WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such draft.');
  return { draft: draftOut(rows[0]) };
}

// --- the connector's half ---------------------------------------------------

/**
 * What this connector should write into Tally.
 *
 * Leased, not just read: two connectors on one company - which happens the day
 * somebody sets up a second machine - would otherwise both post the same
 * voucher. The lease expires so a connector that dies does not strand the queue.
 */
async function outbox(ctx) {
  const conn = auth.requireConnector(ctx);

  const { rows } = await tx(async (c) => {
    const { rows: due } = await c.query(
      `SELECT d.id FROM voucher_drafts d
         JOIN companies co ON co.id = d.company_id
        WHERE d.org_id = $1
          AND (d.status = 'queued'
               OR (d.status = 'sending' AND d.leased_until < now()))
          AND d.attempts < $2
        ORDER BY d.created_at
        LIMIT 20
        FOR UPDATE SKIP LOCKED`, [conn.orgId, MAX_ATTEMPTS]);

    if (!due.length) return { rows: [] };

    return c.query(
      `UPDATE voucher_drafts d
          SET status = 'sending', leased_by = $2,
              leased_until = now() + ($3 || ' minutes')::interval,
              attempts = attempts + 1, updated_at = now()
         FROM companies co
        WHERE d.id = ANY($1::uuid[]) AND co.id = d.company_id
        RETURNING d.*, co.tally_guid, co.name AS company_name`,
      [due.map((r) => r.id), conn.id, String(LEASE_MINUTES)]);
  });

  return {
    vouchers: rows.map((d) => ({
      id: d.id,
      // What the connector writes into Tally's REMOTEID, and checks for first.
      remoteId: d.remote_id,
      company: d.tally_guid,
      companyName: d.company_name,
      vchType: d.vch_type,
      number: d.vch_no || '',
      date: d.vch_date,
      party: d.party,
      narration: d.narration,
      entries: d.entries,
      items: d.items,
      bills: d.bills,
    })),
    leaseMinutes: LEASE_MINUTES,
  };
}

/**
 * What Tally said.
 *
 * Accepts a result for a draft this connector holds a lease on, or one it
 * posted before the lease expired - a connector that took four minutes must
 * still be able to report success, or the voucher gets posted twice on retry.
 */
async function result(ctx, id) {
  const conn = auth.requireConnector(ctx);
  const b = ctx.body || {};

  const { rows: existing } = await query(
    'SELECT * FROM voucher_drafts WHERE id = $1 AND org_id = $2', [id, conn.orgId]);
  if (!existing.length) throw new HttpError(404, 'NOT_FOUND', 'No such voucher.');
  const d = existing[0];

  if (d.status === 'posted') {
    // Already recorded. Saying ok rather than erroring stops a connector that
    // lost our reply from retrying for ever.
    return { recorded: true, alreadyPosted: true };
  }

  const ok = b.ok === true;
  const response = String(b.response ?? '').slice(0, 4000);

  if (ok) {
    await query(
      `UPDATE voucher_drafts
          SET status = 'posted', posted_at = now(), leased_by = NULL,
              leased_until = NULL, error = '',
              tally_guid = $2, tally_vch_no = $3, tally_response = $4,
              updated_at = now()
        -- org_id as well as id. This statement marks a voucher as being in a
        -- customer's books; it is worth being provably tenant-safe on its own
        -- rather than only in combination with the SELECT above it.
        WHERE id = $1 AND org_id = $5`,
      [id, String(b.tallyGuid ?? '').slice(0, 120),
       String(b.voucherNumber ?? '').slice(0, 40), response, conn.orgId]);

    return { recorded: true, posted: true };
  }

  /*
   * A rejection is final for this attempt but not for the voucher.
   *
   * Below the attempt ceiling it goes back in the queue; at it, it stops and
   * waits for a person - because a voucher Tally has refused three times will
   * be refused a fourth, and retrying for ever hides the problem.
   */
  const spent = d.attempts >= MAX_ATTEMPTS;
  await query(
    `UPDATE voucher_drafts
        SET status = $2, leased_by = NULL, leased_until = NULL,
            error = $3, tally_response = $4, updated_at = now()
      WHERE id = $1 AND org_id = $5`,
    [id, spent ? 'rejected' : 'queued',
     String(b.error ?? 'Tally refused it without saying why.').slice(0, 1000),
     response, conn.orgId]);

  return { recorded: true, willRetry: !spent, attemptsLeft: Math.max(0, MAX_ATTEMPTS - d.attempts) };
}

/** Owner switch: does this business let Munim write at all? */
async function setWrites(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');
  if (s.user.role !== 'owner' && s.user.role !== 'platform_admin') {
    throw new HttpError(403, 'OWNER_ONLY', 'Only an owner can turn writing on or off.');
  }

  const on = ctx.body?.enabled === true;
  const { rows } = await query(
    `UPDATE orgs SET writes_enabled = $2,
            writes_enabled_at = CASE WHEN $2 THEN now() ELSE NULL END,
            -- Cast explicitly: the CASE arms are uuid and NULL, and Postgres
            -- infers the parameter as text without it.
            writes_enabled_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END
      WHERE id = $1 RETURNING writes_enabled`, [s.org.id, on, s.user.id]);

  await audit.record(ctx, 'entry.writes', {
    before: { enabled: !on }, after: { enabled: on },
  });

  return {
    enabled: rows[0].writes_enabled,
    message: on
      ? 'Munim can now write vouchers you create here into Tally. It still never '
        + 'changes anything that is already in your books.'
      : 'Writing is off. Munim reads only, and any queued vouchers stay queued.',
  };
}

module.exports = {
  options, create, update, send, cancel, list, one,
  outbox, result, setWrites, validate, KINDS, LEASE_MINUTES, MAX_ATTEMPTS,
};
