'use strict';
const { query } = require('../db');
const audit = require('../lib/audit');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const VT = require('../lib/vouchertypes');
const { HttpError } = require('../lib/http');
const { amountInWords } = require('../lib/words');
const { companyFor } = require('./reports');

/**
 * Turning anything in the product into a message somebody can send.
 *
 * The transport is always the owner's own WhatsApp or mail app. Sending on
 * their behalf needs a WhatsApp Business account billed per conversation, and
 * it would arrive from a number their customer does not recognise - worse, and
 * not free.
 *
 * So what this module owns is the WORDS: what a statement looks like as a
 * WhatsApp message, what an outstanding summary says, and a record of what was
 * sent to whom.
 */

const money = (paise) =>
  `₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

const shortDate = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-IN',
    { day: '2-digit', month: 'short', year: 'numeric' });
};

/*
 * Defaults written the way a shop actually writes to a customer.
 *
 * WhatsApp is not email: no salutation block, no signature block, no subject
 * line. Short enough to read without scrolling, specific enough to act on.
 */
const DEFAULTS = [
  {
    kind: 'statement',
    name: 'Account statement',
    body: 'Hello {{party}},\n\nHere is your account with {{company}} as on {{asOf}}.\n\n'
        + '{{lines}}\n\n*Balance: {{balance}}*\n\n'
        + 'Please let us know if anything looks wrong.\n{{company}}',
  },
  {
    kind: 'outstanding',
    name: 'Outstanding summary',
    body: 'Hello {{party}},\n\nOutstanding with {{company}} as on {{asOf}}:\n\n'
        + '{{lines}}\n\n*Total: {{balance}}*\n{{overdueNote}}\n\n{{company}}',
  },
  {
    kind: 'invoice',
    name: 'Invoice',
    body: '{{company}}\n{{title}} {{number}} · {{date}}\n\n{{lines}}\n\n'
        + '*Total: {{total}}*\n{{inWords}}\n{{dueNote}}',
  },
  {
    kind: 'voucher',
    name: 'Voucher',
    body: '{{company}}\n{{type}} {{number}} · {{date}}\n{{party}}\n\n'
        + '{{lines}}\n\n*Total: {{total}}*',
  },
  {
    kind: 'report',
    name: 'Report summary',
    body: '{{company}} — {{title}}\n{{period}}\n\n{{lines}}\n\nSent from Munim',
  },
  {
    kind: 'item',
    name: 'Item enquiry',
    body: '{{company}}\n\n{{item}}\n{{lines}}\n\nAsk us for current pricing.',
  },
];

async function ensureDefaults(orgId) {
  for (const t of DEFAULTS) {
    await query(
      `INSERT INTO share_templates (org_id, kind, name, body, is_default)
       VALUES ($1,$2,$3,$4,true) ON CONFLICT (org_id, kind, name) DO NOTHING`,
      [orgId, t.kind, t.name, t.body]);
  }
}

/** Unknown placeholders stay visible, so a typo shows up in the preview. */
const render = (body, vars) =>
  String(body || '').replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole));

/**
 * Remove a line whose only purpose was a value that turned out to be empty.
 *
 * The alternative is making every template defensive, which pushes the problem
 * onto whoever edits one.
 */
const tidy = (text) => String(text)
  .split('\n')
  .filter((l) => l.trim() !== '' ? !/\b(on|at|to|is)\s*[.:]?\s*$/i.test(l.trim()) : true)
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const templateFor = async (orgId, kind, id) => {
  if (id) {
    const { rows } = await query(
      'SELECT * FROM share_templates WHERE id = $1 AND org_id = $2', [id, orgId]);
    if (rows.length) return rows[0];
  }
  const { rows } = await query(
    'SELECT * FROM share_templates WHERE org_id = $1 AND kind = $2 ORDER BY is_default DESC LIMIT 1',
    [orgId, kind]);
  return rows[0] ?? null;
};

/**
 * A party's statement, as a message.
 *
 * Capped at the most recent entries: a customer trading for three years has
 * hundreds, and a WhatsApp nobody scrolls to the end of communicates nothing.
 */
async function statementText(companyId, company, name, opts = {}) {
  const { rows: led } = await query(
    'SELECT * FROM ledgers WHERE company_id = $1 AND lower(name) = lower($2)',
    [companyId, name]);
  if (!led.length) throw new HttpError(404, 'NOT_FOUND', 'No such party.');
  const p = led[0];

  const { rows: vouchers } = await query(
    `SELECT v.vch_no, v.vch_type, v.vch_date::text AS date, v.amount_paise
       FROM vouchers v
      WHERE v.company_id = $1 AND v.party = $2 AND ${VT.LIVE}
      ORDER BY v.vch_date DESC LIMIT $3`,
    [companyId, p.name, Math.min(opts.limit ?? 10, 40)]);

  const { rows: asOfRow } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [companyId]);

  const lines = vouchers.map((v) =>
    `${shortDate(v.date)}  ${v.vch_type} ${v.vch_no}  ${money(Math.abs(Number(v.amount_paise)))}`);

  return {
    recipient: p.phone || '',
    email: p.email || '',
    subject: p.name,
    vars: {
      party: p.name,
      company: company.formal_name || company.name,
      asOf: shortDate(asOfRow[0].d),
      lines: lines.length ? lines.join('\n') : 'No entries yet.',
      balance: money(Number(p.closing_paise)),
      count: String(vouchers.length),
    },
  };
}

/** What one party still owes, bill by bill. */
async function outstandingText(companyId, company, name) {
  const { rows: led } = await query(
    'SELECT * FROM ledgers WHERE company_id = $1 AND lower(name) = lower($2)',
    [companyId, name]);
  if (!led.length) throw new HttpError(404, 'NOT_FOUND', 'No such party.');
  const p = led[0];

  const { rows: asOfRow } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [companyId]);
  const asOf = asOfRow[0].d;

  const { rows: bills } = await query(
    `SELECT b.ref, b.bill_date::text AS bill_date,
            effective_due(b.due_date, b.bill_date, l.credit_days)::text AS due,
            b.amount_paise,
            ($3::date - effective_due(b.due_date, b.bill_date, l.credit_days)) AS days
       FROM open_bills b
       LEFT JOIN ledgers l ON l.company_id = b.company_id AND l.name = b.party
      WHERE b.company_id = $1 AND b.party = $2
      ORDER BY due`,
    [companyId, p.name, asOf]);

  const total = bills.reduce((n, b) => n + Number(b.amount_paise), 0);
  const overdue = bills.filter((b) => Number(b.days) > 0);
  const overdueTotal = overdue.reduce((n, b) => n + Number(b.amount_paise), 0);

  const lines = bills.map((b) => {
    const d = Number(b.days);
    const tail = d > 0 ? `  (${d} days overdue)` : `  (due ${shortDate(b.due)})`;
    return `${b.ref}  ${money(Number(b.amount_paise))}${tail}`;
  });

  return {
    recipient: p.phone || '',
    email: p.email || '',
    subject: p.name,
    vars: {
      party: p.name,
      company: company.formal_name || company.name,
      asOf: shortDate(asOf),
      lines: lines.length ? lines.join('\n') : 'Nothing outstanding.',
      balance: money(total),
      // Omitted entirely rather than saying "0 overdue", which reads as a
      // complaint where none is meant.
      overdueNote: overdue.length
        ? `${overdue.length} of these (${money(overdueTotal)}) are past their due date.`
        : '',
    },
  };
}

/** A voucher or invoice, as a message. */
async function voucherText(companyId, company, voucherId) {
  const { rows } = await query(
    `SELECT v.*, v.vch_date::text AS date_text FROM vouchers v
      WHERE v.id = $1 AND v.company_id = $2`, [voucherId, companyId]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such voucher.');
  const v = rows[0];

  const [items, entries, bills, party] = await Promise.all([
    query(`SELECT item_name, qty, rate_paise, amount_paise
             FROM voucher_items WHERE voucher_id = $1 ORDER BY item_name`, [v.id]),
    query(`SELECT ledger_name, amount_paise FROM voucher_entries WHERE voucher_id = $1`, [v.id]),
    query(`SELECT ref, due_date::text AS due FROM bills WHERE voucher_id = $1`, [v.id]),
    query('SELECT phone, email FROM ledgers WHERE company_id = $1 AND lower(name) = lower($2)',
      [companyId, v.party]),
  ]);

  const tax = entries.rows
    .filter((e) => /gst|tax|cess|vat/i.test(e.ledger_name) && !/deduct|tds|tcs/i.test(e.ledger_name))
    .reduce((n, e) => n + Math.abs(Number(e.amount_paise)), 0);

  const lines = items.rows.length
    ? items.rows.map((i) =>
        `${i.item_name}  ${Number(i.qty)} × ${money(Number(i.rate_paise))} = `
        + `${money(Math.abs(Number(i.amount_paise)))}`)
    : ['(no item lines on this entry)'];
  if (tax > 0) lines.push(`Tax: ${money(tax)}`);

  const gross = Math.abs(Number(v.amount_paise));
  const due = bills.rows.find((b) => b.due)?.due;

  return {
    recipient: party.rows[0]?.phone || '',
    email: party.rows[0]?.email || '',
    subject: `${v.vch_type} ${v.vch_no}`,
    vars: {
      company: company.formal_name || company.name,
      title: /credit note/i.test(v.vch_type) ? 'Credit Note'
        : VT.isOrder(v.vch_type) ? 'Order' : 'Invoice',
      type: v.vch_type,
      number: v.vch_no,
      date: shortDate(v.date_text),
      party: v.party,
      lines: lines.join('\n'),
      total: money(gross),
      inWords: amountInWords(gross),
      dueNote: due ? `Due ${shortDate(due)}` : '',
    },
  };
}

/** An item, for answering "do you have this and what does it cost". */
async function itemText(companyId, company, name) {
  const { rows } = await query(
    'SELECT * FROM stock_items WHERE company_id = $1 AND lower(name) = lower($2)',
    [companyId, name]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such item.');
  const i = rows[0];

  const lines = [
    `In stock: ${Number(i.closing_qty)} ${i.unit || ''}`.trim(),
    i.hsn ? `HSN: ${i.hsn}` : '',
    i.gst_rate_bp ? `GST: ${i.gst_rate_bp / 100}%` : '',
  ].filter(Boolean);

  return {
    recipient: '', email: '', subject: i.name,
    vars: {
      company: company.formal_name || company.name,
      item: i.name,
      lines: lines.join('\n'),
    },
  };
}

/**
 * A report, composed by whoever is looking at it.
 *
 * Unlike the others this cannot be rebuilt from an id: a report is whatever
 * the person had on screen, with their period and filters applied. So the
 * screen passes the title and the lines it is already showing, and this wraps
 * them in the template and logs them.
 *
 * Everything is bounded and escaped by being treated as text - it goes into a
 * message the user is about to read and send, never into SQL or markup.
 */
async function reportText(companyId, company, subject, opts = {}) {
  const lines = (opts.lines || [])
    .map((l) => String(l).slice(0, 200))
    .slice(0, 40);

  return {
    recipient: '', email: '',
    subject: String(subject || 'Report').slice(0, 120),
    vars: {
      company: company.formal_name || company.name,
      title: String(subject || 'Report').slice(0, 120),
      period: String(opts.period || '').slice(0, 120),
      lines: lines.length ? lines.join('\n') : 'Nothing in this period.',
    },
  };
}

const BUILDERS = {
  statement: { module: 'ledgers', build: statementText },
  outstanding: { module: 'outstanding', build: outstandingText },
  invoice: { module: 'sales', build: voucherText },
  voucher: { module: 'sales', build: voucherText },
  item: { module: 'inventory', build: itemText },
  report: { module: 'reports', build: reportText },
};

/**
 * Build the message, without sending it.
 *
 * Returns the recipient too, so the app can open WhatsApp on the right number
 * rather than making somebody pick from their contacts.
 */
async function preview(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;

  const kind = q.get('kind') || '';
  const subject = q.get('subject') || '';
  const builder = BUILDERS[kind];
  if (!builder) {
    throw new HttpError(400, 'BAD_KIND',
      `Cannot share "${kind}". Try ${Object.keys(BUILDERS).join(', ')}.`);
  }
  // Sharing is a read plus a share: somebody who cannot see a statement must
  // not be able to send one either.
  perms.require(s, builder.module, 'read');
  perms.require(s, builder.module, 'share');

  await ensureDefaults(s.org.id);
  const { rows: cos } = await query('SELECT * FROM companies WHERE id = $1', [co.id]);

  const built = await builder.build(co.id, cos[0], subject, {
    limit: parseInt(q.get('limit') ?? '10', 10) || 10,
    period: q.get('period') || '',
    // Repeated `line` parameters, so a screen can hand over exactly what it
    // is showing without inventing a serialisation format.
    lines: q.getAll('line'),
  });
  const template = await templateFor(s.org.id, kind, q.get('templateId'));

  return {
    kind,
    subject: built.subject,
    recipient: built.recipient,
    email: built.email,
    templateId: template?.id ?? null,
    message: tidy(render(template?.body ?? '{{lines}}', built.vars)),
    // Returned so a screen can offer a custom message with the same values.
    variables: built.vars,
  };
}

/** Record what was handed to WhatsApp or mail. */
async function record(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const b = ctx.body || {};

  const status = ['handed-off', 'sent', 'failed'].includes(b.status) ? b.status : 'handed-off';
  const { rows } = await query(
    `INSERT INTO share_log (org_id, company_id, user_id, kind, subject, channel,
                            recipient, status, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, at`,
    [s.org.id, co.id, s.user.id, String(b.kind || '').slice(0, 40),
     String(b.subject || '').slice(0, 200), b.channel || 'whatsapp',
     String(b.recipient || '').slice(0, 120), status,
     String(b.message || '').slice(0, 4000)]);

  await audit.record(ctx, 'share.sent', {
    companyId: co.id, entityId: String(b.kind ?? ''), entityName: String(b.subject ?? ''),
    meta: { channel: b.channel ?? 'whatsapp', recipient: b.recipient ?? '', status },
  });

  return {
    id: String(rows[0].id), status, at: rows[0].at,
    // The same honesty as reminders: we know we handed it over, no more.
    note: 'Recorded. Munim did not send it — your own WhatsApp or mail app did.',
  };
}

/** What has been shared, and with whom. */
async function log(ctx) {
  const s = auth.requireUser(ctx);
  const q = ctx.url.searchParams;
  const limit = Math.min(Math.max(parseInt(q.get('limit') ?? '100', 10) || 100, 1), 500);

  const args = [s.org.id, limit];
  let filter = '';
  if (q.get('subject')) filter += ` AND l.subject = $${args.push(q.get('subject'))}`;
  if (q.get('kind')) filter += ` AND l.kind = $${args.push(q.get('kind'))}`;

  const { rows } = await query(
    `SELECT l.*, u.name AS by_name FROM share_log l
       LEFT JOIN users u ON u.id = l.user_id
      WHERE l.org_id = $1${filter} ORDER BY l.at DESC LIMIT $2`, args);

  return {
    shares: rows.map((r) => ({
      id: String(r.id), kind: r.kind, subject: r.subject, channel: r.channel,
      recipient: r.recipient, status: r.status, at: r.at, by: r.by_name ?? '',
    })),
  };
}

/** The templates, and what can go in them. */
async function templates(ctx) {
  const s = auth.requireUser(ctx);
  await ensureDefaults(s.org.id);
  const { rows } = await query(
    'SELECT * FROM share_templates WHERE org_id = $1 ORDER BY kind, name', [s.org.id]);

  return {
    templates: rows.map((t) => ({
      id: t.id, kind: t.kind, name: t.name, body: t.body, isDefault: t.is_default,
    })),
    placeholders: {
      statement: ['party', 'company', 'asOf', 'lines', 'balance', 'count'],
      outstanding: ['party', 'company', 'asOf', 'lines', 'balance', 'overdueNote'],
      invoice: ['company', 'title', 'number', 'date', 'party', 'lines', 'total',
                'inWords', 'dueNote'],
      voucher: ['company', 'type', 'number', 'date', 'party', 'lines', 'total'],
      item: ['company', 'item', 'lines'],
      report: ['company', 'title', 'period', 'lines'],
    },
  };
}

async function saveTemplate(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');
  const b = ctx.body || {};
  const body = String(b.body ?? '').trim();
  if (body.length < 5) throw new HttpError(400, 'BAD_BODY', 'The message is too short.');
  if (body.length > 2000) throw new HttpError(400, 'BAD_BODY', 'The message is too long.');

  const { rowCount } = await query(
    'UPDATE share_templates SET body = $3 WHERE id = $1 AND org_id = $2',
    [id, s.org.id, body]);
  if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'No such template.');
  return { id, saved: true };
}

module.exports = {
  preview, record, log, templates, saveTemplate,
  ensureDefaults, render, tidy, BUILDERS, DEFAULTS,
};
