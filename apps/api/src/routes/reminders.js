'use strict';
const { query, tx } = require('../db');
const audit = require('../lib/audit');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const features = require('../lib/features');
const { HttpError } = require('../lib/http');
const { companyFor } = require('./reports');

/**
 * Deciding who to chase, and writing what to say.
 *
 * Munim does not send anything. Sending on a customer's behalf means a
 * WhatsApp Business account billed per conversation and a mail domain with its
 * own deliverability problems - real money, for a worse result than the shop's
 * own number, which is what their customer recognises.
 *
 * So the product here is the judgement, not the transport: which bills are due
 * a chase today, in what order, with the message already written. The owner
 * taps once per customer and their own WhatsApp opens with it ready.
 */

/*
 * Templates a shop would actually send.
 *
 * Written the way an Indian SMB writes to a customer they want to keep:
 * specific about the amount and the bill, unembarrassing about the ask, and
 * short enough to read on a phone.
 */
const DEFAULT_TEMPLATES = [
  {
    name: 'Gentle reminder (before due)',
    channel: 'whatsapp',
    body: 'Hello {{party}},\n\nA friendly reminder that {{amount}} is due on '
        + '{{dueDate}} against {{bills}}.\n\nThank you for your business.\n{{company}}',
  },
  {
    name: 'Due today',
    channel: 'whatsapp',
    body: 'Hello {{party}},\n\n{{amount}} against {{bills}} falls due today.\n\n'
        + 'Please arrange payment at your convenience.\n\n{{company}}',
  },
  {
    name: 'Overdue follow-up',
    channel: 'whatsapp',
    body: 'Hello {{party}},\n\nOur records show {{amount}} outstanding against '
        + '{{bills}}, now {{days}} days past due.\n\nPlease let us know when we '
        + 'may expect payment. If you have already paid, kindly ignore this '
        + 'message and share the details.\n\n{{company}}',
  },
  {
    name: 'Final notice',
    channel: 'whatsapp',
    body: 'Dear {{party}},\n\n{{amount}} against {{bills}} is now {{days}} days '
        + 'overdue despite earlier reminders.\n\nWe would like to settle this '
        + 'amicably. Please contact us on {{phone}}.\n\n{{company}}',
  },
];

/** Sensible rules, so the feature works before anyone configures it. */
const DEFAULT_RULES = [
  { name: 'Three days before due', trigger: 'before', days: 3,
    template: 'Gentle reminder (before due)', repeat_days: 30, max_reminders: 1 },
  { name: 'On the due date', trigger: 'on', days: 0,
    template: 'Due today', repeat_days: 30, max_reminders: 1 },
  { name: 'A week overdue', trigger: 'after', days: 7,
    template: 'Overdue follow-up', repeat_days: 7, max_reminders: 3 },
  { name: 'A month overdue', trigger: 'after', days: 30,
    template: 'Final notice', repeat_days: 14, max_reminders: 2 },
];

/** Seed an org's templates and rules once. Idempotent. */
async function ensureDefaults(orgId) {
  for (const t of DEFAULT_TEMPLATES) {
    await query(
      `INSERT INTO reminder_templates (org_id, name, channel, body, is_default)
       VALUES ($1,$2,$3,$4,true) ON CONFLICT (org_id, name) DO NOTHING`,
      [orgId, t.name, t.channel, t.body]);
  }
  for (const r of DEFAULT_RULES) {
    const { rows } = await query(
      'SELECT id FROM reminder_templates WHERE org_id = $1 AND name = $2',
      [orgId, r.template]);
    await query(
      `INSERT INTO reminder_rules
         (org_id, name, trigger, days, template_id, repeat_days, max_reminders)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id, name) DO NOTHING`,
      [orgId, r.name, r.trigger, r.days, rows[0]?.id ?? null,
       r.repeat_days, r.max_reminders]);
  }
}

const money = (paise) =>
  `₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/**
 * Fill a template.
 *
 * Unknown placeholders are left standing rather than blanked, so a typo in a
 * template is visible in the preview instead of producing a sentence with a
 * hole in it.
 */
function render(body, vars) {
  return String(body || '').replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole));
}

/**
 * Clean up what a missing value leaves behind.
 *
 * A company with no phone number in Tally produced "Please contact us on ." -
 * a sentence with a hole in it, sent to a customer. Rather than make every
 * template defensive, the whole line goes when the value it existed for is
 * missing.
 */
function tidy(text) {
  return String(text)
    // A sentence that ends on a dangling preposition and punctuation.
    .split('\n')
    .filter((line) => !/\b(on|at|to)\s*[.:]?\s*$/i.test(line.trim()) || line.trim() === '')
    .join('\n')
    // Collapse the blank runs that removing a line can leave.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Who to chase today, and what to say to each of them.
 *
 * The heart of the module. Every open bill is measured against every enabled
 * rule; the first rule that matches wins, so a bill a month overdue gets the
 * final notice rather than four messages at once.
 */
async function worklist(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'outstanding', 'read');
  features.requireFeature(s, 'reminders');
  const co = await companyFor(s, tallyGuid);
  await ensureDefaults(s.org.id);

  const { rows: cos } = await query('SELECT * FROM companies WHERE id = $1', [co.id]);
  const company = cos[0];

  const { rows: last } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [co.id]);
  const asOf = new Date(last[0].d);

  const [rules, bills, history] = await Promise.all([
    query(
      `SELECT r.*, t.body, t.name AS template_name
         FROM reminder_rules r
         LEFT JOIN reminder_templates t ON t.id = r.template_id
        WHERE r.org_id = $1 AND r.enabled
        ORDER BY r.trigger DESC, r.days DESC`, [s.org.id]),

    query(
      `SELECT b.ref, b.party, b.bill_date::text AS bill_date,
              effective_due(b.due_date, b.bill_date, l.credit_days)::text AS due,
              b.amount_paise, l.phone, l.email, l.no_reminders,
              (effective_due(b.due_date, b.bill_date, l.credit_days) - $2::date) AS days
         FROM open_bills b
         LEFT JOIN ledgers l ON l.company_id = b.company_id AND l.name = b.party
        WHERE b.company_id = $1
        ORDER BY due`,
      [co.id, asOf.toISOString().slice(0, 10)]),

    query(
      `SELECT party, count(*)::int AS n, max(sent_at) AS last_at
         FROM reminders
        WHERE org_id = $1 AND status IN ('handed-off','sent')
        GROUP BY party`, [s.org.id]),
  ]);

  const seen = new Map(history.rows.map((h) => [h.party, h]));

  /*
   * One entry per PARTY, not per bill.
   *
   * A customer with nine overdue invoices should get one message listing them,
   * not nine messages. Sending nine is how a reminder feature turns into a
   * reason to block the sender.
   */
  const byParty = new Map();
  for (const b of bills.rows) {
    if (b.no_reminders) continue;
    const days = Number(b.days);

    // The first matching rule wins - rules are ordered most-overdue first, so
    // a bill a month late gets the final notice, not four messages.
    const rule = rules.rows.find((r) => {
      if (r.trigger === 'before') return days === r.days;
      if (r.trigger === 'on') return days === 0;
      return days <= -r.days;                       // 'after'
    });
    if (!rule) continue;

    const cur = byParty.get(b.party) ?? {
      party: b.party, phone: b.phone || '', email: b.email || '',
      bills: [], amountPaise: 0, worstDays: 0, rule,
    };
    cur.bills.push({ ref: b.ref, dueDate: b.due, amountPaise: Number(b.amount_paise) });
    cur.amountPaise += Number(b.amount_paise);
    // The oldest bill decides the tone for the whole message.
    if (-days > cur.worstDays) { cur.worstDays = -days; cur.rule = rule; }
    byParty.set(b.party, cur);
  }

  const out = [];
  for (const e of byParty.values()) {
    if (e.amountPaise < Number(e.rule.min_amount_paise)) continue;

    const past = seen.get(e.party);
    if (past) {
      if (past.n >= e.rule.max_reminders) continue;
      const sinceDays = (Date.now() - new Date(past.last_at).getTime()) / 86_400_000;
      // Do not pester: a bill chased on Monday is not chased again on Tuesday.
      if (sinceDays < Number(e.rule.repeat_days)) continue;
    }

    /*
     * The bill list, kept readable.
     *
     * A customer with fifteen open invoices should not receive fifteen
     * references in one WhatsApp message - nobody reads that, and it makes a
     * polite reminder look like a dunning letter. Four and a count is enough
     * for them to recognise what it is about and ask for the rest.
     */
    const refs = [...new Set(e.bills.map((b) => b.ref))];
    const billList = refs.length <= 4
      ? refs.join(', ')
      : `${refs.slice(0, 4).join(', ')} and ${refs.length - 4} more`;

    const vars = {
      party: e.party,
      amount: money(e.amountPaise),
      bills: billList,
      dueDate: e.bills[0]?.dueDate ?? '',
      days: String(Math.max(0, e.worstDays)),
      company: company.formal_name || company.name,
      phone: company.phone || '',
    };

    out.push({
      party: e.party,
      phone: e.phone,
      email: e.email,
      amountPaise: e.amountPaise,
      bills: e.bills,
      daysOverdue: Math.max(0, e.worstDays),
      rule: { id: e.rule.id, name: e.rule.name, trigger: e.rule.trigger, days: e.rule.days },
      templateId: e.rule.template_id,
      channel: e.rule.channel,
      message: tidy(render(e.rule.body ?? '', vars)),
      // Surfaced rather than silently skipped: a customer who owes money and
      // has no number on file is a problem to fix, not a row to hide.
      reachable: !!e.phone,
      remindedBefore: past?.n ?? 0,
    });
  }

  out.sort((a, b) => b.amountPaise - a.amountPaise);

  return {
    asOf: asOf.toISOString().slice(0, 10),
    company: { name: company.formal_name || company.name },
    worklist: out,
    totals: {
      parties: out.length,
      amountPaise: out.reduce((n, x) => n + x.amountPaise, 0),
      unreachable: out.filter((x) => !x.reachable).length,
    },
    note: 'Munim writes the message and opens WhatsApp on your phone. '
        + 'You press send, so it comes from your own number.',
  };
}

/**
 * Record that a reminder was handed to WhatsApp or mail.
 *
 * Status says what we actually know. There is no "delivered" here, because
 * handing a message to WhatsApp tells us nothing about whether it arrived -
 * and a history full of unearned "delivered" is worse than no history.
 */
async function record(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'outstanding', 'share');
  features.requireFeature(s, 'reminders');
  const co = await companyFor(s, tallyGuid);
  const b = ctx.body || {};

  const status = ['handed-off', 'sent', 'skipped', 'failed'].includes(b.status)
    ? b.status : 'handed-off';
  if (!b.party) throw new HttpError(400, 'BAD_REQUEST', 'Which party was reminded?');

  const { rows } = await query(
    `INSERT INTO reminders
       (org_id, company_id, party, phone, amount_paise, channel, status,
        rule_id, template_id, bill_refs, due_date, days_overdue, message,
        handed_off_at, confirmed_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,'')::date,$12,$13,
             now(), $14, $15)
     RETURNING id, sent_at`,
    [s.org.id, co.id, b.party, b.phone || '', Math.abs(b.amountPaise || 0),
     b.channel || 'whatsapp', status,
     b.ruleId || null, b.templateId || null,
     Array.isArray(b.billRefs) ? b.billRefs : [],
     b.dueDate || '', Math.max(0, Number(b.daysOverdue) || 0),
     String(b.message || '').slice(0, 4000),
     status === 'sent' ? new Date() : null, s.user.id]);

  await audit.record(ctx, 'reminder.sent', {
    companyId: co.id, entityName: b.party,
    meta: { status, channel: b.channel ?? 'whatsapp', amountPaise: b.amountPaise ?? 0 },
  });

  return {
    id: rows[0].id,
    status,
    at: rows[0].sent_at,
    // No credit is charged: nothing was sent on the customer's behalf, so
    // there is nothing to bill for.
    note: 'Recorded. Munim did not send it — your own WhatsApp did.',
  };
}

/** What has been chased, and what came of it. */
async function history(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'outstanding', 'read');
  const limit = Math.min(Math.max(
    parseInt(ctx.url.searchParams.get('limit') ?? '100', 10) || 100, 1), 500);

  const { rows } = await query(
    `SELECT r.*, u.name AS by_name
       FROM reminders r
       LEFT JOIN users u ON u.id = r.created_by
      WHERE r.org_id = $1 ORDER BY r.sent_at DESC LIMIT $2`, [s.org.id, limit]);

  const { rows: agg } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'sent')::int AS sent,
            count(*) FILTER (WHERE status = 'handed-off')::int AS handed,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
            count(DISTINCT party)::int AS parties
       FROM reminders
      WHERE org_id = $1 AND sent_at > now() - interval '90 days'`, [s.org.id]);

  /*
   * Did chasing work?
   *
   * A party reminded in the last 90 days whose balance has since gone to zero
   * or below. Correlation, not proof - they may have paid anyway - so it is
   * labelled as "settled after a reminder" rather than claimed as a result.
   */
  const { rows: settled } = await query(
    `SELECT count(DISTINCT r.party)::int AS n
       FROM reminders r
       JOIN ledgers l ON l.name = r.party AND l.company_id = r.company_id
      WHERE r.org_id = $1 AND r.sent_at > now() - interval '90 days'
        AND l.closing_paise <= 0`, [s.org.id]);

  return {
    reminders: rows.map((r) => ({
      id: r.id, party: r.party, phone: r.phone,
      amountPaise: Number(r.amount_paise), channel: r.channel, status: r.status,
      billRefs: r.bill_refs, daysOverdue: r.days_overdue,
      message: r.message, at: r.sent_at, by: r.by_name ?? '',
    })),
    last90Days: {
      ...agg[0],
      settledAfterReminder: settled[0].n,
      // Stated plainly so nobody reads it as a delivery rate.
      caveat: 'A party may have paid for reasons of their own. This counts '
            + 'who settled after being chased, not who settled because of it.',
    },
  };
}

// ------------------------------------------------------- templates and rules

async function listConfig(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'outstanding', 'read');
  await ensureDefaults(s.org.id);

  const [templates, rules] = await Promise.all([
    query('SELECT * FROM reminder_templates WHERE org_id = $1 ORDER BY name', [s.org.id]),
    query(
      `SELECT r.*, t.name AS template_name FROM reminder_rules r
         LEFT JOIN reminder_templates t ON t.id = r.template_id
        WHERE r.org_id = $1 ORDER BY r.trigger DESC, r.days`, [s.org.id]),
  ]);

  return {
    templates: templates.rows.map((t) => ({
      id: t.id, name: t.name, channel: t.channel, body: t.body, isDefault: t.is_default,
    })),
    rules: rules.rows.map((r) => ({
      id: r.id, name: r.name, enabled: r.enabled, trigger: r.trigger, days: r.days,
      channel: r.channel, templateId: r.template_id, templateName: r.template_name,
      minAmountPaise: Number(r.min_amount_paise),
      repeatDays: r.repeat_days, maxReminders: r.max_reminders,
    })),
    placeholders: [
      { key: 'party', what: 'The customer\'s name' },
      { key: 'amount', what: 'Total outstanding, formatted' },
      { key: 'bills', what: 'The bill references, comma separated' },
      { key: 'dueDate', what: 'Due date of the earliest bill' },
      { key: 'days', what: 'Days overdue' },
      { key: 'company', what: 'Your business name' },
      { key: 'phone', what: 'Your phone number' },
    ],
  };
}

async function saveTemplate(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'outstanding', 'update');
  const b = ctx.body || {};
  const body = String(b.body ?? '').trim();
  const name = String(b.name ?? '').trim().slice(0, 60);

  if (!name) throw new HttpError(400, 'BAD_NAME', 'Give the template a name.');
  if (body.length < 10) throw new HttpError(400, 'BAD_BODY', 'The message is too short.');
  if (body.length > 2000) throw new HttpError(400, 'BAD_BODY', 'The message is too long.');

  if (id) {
    const { rowCount } = await query(
      `UPDATE reminder_templates SET name = $3, body = $4, channel = $5
        WHERE id = $1 AND org_id = $2`,
      [id, s.org.id, name, body, b.channel || 'whatsapp']);
    if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'No such template.');
    return { id, name };
  }

  const { rows } = await query(
    `INSERT INTO reminder_templates (org_id, name, channel, body)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [s.org.id, name, b.channel || 'whatsapp', body]);
  return { id: rows[0].id, name };
}

async function saveRule(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'outstanding', 'update');
  const b = ctx.body || {};

  const sets = [];
  const args = [id, s.org.id];
  const set = (col, val) => sets.push(`${col} = $${args.push(val)}`);

  if (b.name !== undefined) set('name', String(b.name).trim().slice(0, 60));
  if (b.enabled !== undefined) set('enabled', !!b.enabled);
  if (b.trigger !== undefined) {
    if (!['before', 'on', 'after'].includes(b.trigger)) {
      throw new HttpError(400, 'BAD_TRIGGER', 'Trigger must be before, on or after.');
    }
    set('trigger', b.trigger);
  }
  if (b.days !== undefined) {
    const n = Number(b.days);
    if (!Number.isInteger(n) || n < 0 || n > 365) {
      throw new HttpError(400, 'BAD_DAYS', 'Days must be a whole number from 0 to 365.');
    }
    set('days', n);
  }
  if (b.templateId !== undefined) set('template_id', b.templateId || null);
  if (b.minAmountPaise !== undefined) {
    set('min_amount_paise', Math.max(0, Number(b.minAmountPaise) || 0));
  }
  if (b.repeatDays !== undefined) {
    set('repeat_days', Math.min(Math.max(Number(b.repeatDays) || 1, 1), 365));
  }
  if (b.maxReminders !== undefined) {
    set('max_reminders', Math.min(Math.max(Number(b.maxReminders) || 1, 1), 20));
  }
  if (!sets.length) throw new HttpError(400, 'NOTHING_TO_DO', 'Nothing to change.');

  const { rowCount } = await query(
    `UPDATE reminder_rules SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`, args);
  if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'No such rule.');
  return { id, saved: true };
}

/** Stop chasing one party, or start again. */
async function setOptOut(ctx, tallyGuid, name) {
  const s = perms.require(auth.requireUser(ctx), 'outstanding', 'update');
  const co = await companyFor(s, tallyGuid);
  const off = ctx.body?.noReminders !== false;

  const { rowCount } = await query(
    'UPDATE ledgers SET no_reminders = $3 WHERE company_id = $1 AND lower(name) = lower($2)',
    [co.id, name, off]);
  if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'No such party.');

  return {
    party: name,
    noReminders: off,
    note: off ? 'This party will not appear in the reminder list.'
              : 'This party can be chased again.',
  };
}

module.exports = {
  worklist, record, history, listConfig, saveTemplate, saveRule, setOptOut,
  ensureDefaults, render, DEFAULT_TEMPLATES,
};
