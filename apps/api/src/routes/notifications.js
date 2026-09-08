'use strict';
const { query } = require('../db');
const audit = require('../lib/audit');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const { EVENTS, raise, inQuietHours } = require('../lib/events');
const { HttpError } = require('../lib/http');
const { companyFor } = require('./reports');

/**
 * The feed, and who sees what.
 *
 * Visibility falls out of permissions rather than being configured: every
 * event declares the module it belongs to, so a salesperson who cannot open
 * purchases is not told about a new bill either. That cannot drift from what
 * the screens actually show, which a second list of recipients would.
 */

/** Which events this session is allowed to hear about. */
function visibleEvents(session) {
  return Object.entries(EVENTS)
    .filter(([, def]) => perms.can(session, def.module, 'read'))
    .map(([key]) => key);
}

async function feed(ctx) {
  const s = auth.requireUser(ctx);
  const q = ctx.url.searchParams;
  const limit = Math.min(Math.max(parseInt(q.get('limit') ?? '50', 10) || 50, 1), 200);
  const unreadOnly = q.get('unread') === '1';

  const allowed = visibleEvents(s);
  if (!allowed.length) return { notifications: [], unread: 0, events: {} };

  const args = [s.org.id, s.user.id, allowed, limit];
  const { rows } = await query(
    `SELECT n.*, r.at AS read_at, c.name AS company_name
       FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $2
       LEFT JOIN companies c ON c.id = n.company_id
      WHERE n.org_id = $1 AND n.event = ANY($3)
        ${unreadOnly ? 'AND r.at IS NULL' : ''}
      ORDER BY n.at DESC LIMIT $4`, args);

  const { rows: unread } = await query(
    `SELECT count(*)::int AS n
       FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $2
      WHERE n.org_id = $1 AND n.event = ANY($3) AND r.at IS NULL`,
    [s.org.id, s.user.id, allowed]);

  return {
    notifications: rows.map((n) => ({
      id: String(n.id),
      event: n.event,
      label: EVENTS[n.event]?.label ?? n.event,
      level: n.level,
      title: n.title,
      body: n.body,
      link: n.link,
      companyName: n.company_name ?? '',
      at: n.at,
      read: !!n.read_at,
    })),
    unread: unread[0].n,
    // Sent so a screen can label and group without a second request.
    events: Object.fromEntries(allowed.map((k) => [k, EVENTS[k]])),
  };
}

/** Mark some, or all, as read. */
async function markRead(ctx) {
  const s = auth.requireUser(ctx);
  const ids = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(Number).filter(Number.isFinite) : [];

  if (ids.length) {
    await query(
      `INSERT INTO notification_reads (notification_id, user_id)
       SELECT n.id, $2 FROM notifications n
        WHERE n.org_id = $1 AND n.id = ANY($3::bigint[])
       ON CONFLICT DO NOTHING`, [s.org.id, s.user.id, ids]);
    return { read: ids.length };
  }

  // Everything this person can see, which is what "mark all read" means to
  // them - not everything in the table.
  const allowed = visibleEvents(s);
  const { rowCount } = await query(
    `INSERT INTO notification_reads (notification_id, user_id)
     SELECT n.id, $2 FROM notifications n
      WHERE n.org_id = $1 AND n.event = ANY($3)
     ON CONFLICT DO NOTHING`, [s.org.id, s.user.id, allowed]);
  return { read: rowCount };
}

/** The rules, and this person's own quiet hours. */
async function settings(ctx) {
  const s = auth.requireUser(ctx);

  const { rows } = await query(
    'SELECT * FROM notification_rules WHERE org_id = $1', [s.org.id]);
  const byEvent = new Map(rows.map((r) => [r.event, r]));

  const { rows: me } = await query(
    'SELECT quiet_from, quiet_to, notify_muted FROM users WHERE id = $1', [s.user.id]);

  return {
    rules: Object.entries(EVENTS).map(([key, def]) => {
      const r = byEvent.get(key);
      return {
        event: key,
        label: def.label,
        hint: def.hint,
        module: def.module,
        level: def.level,
        // Absent means the built-in default, so a new event works everywhere
        // without a backfill.
        enabled: r ? r.enabled : true,
        minAmountPaise: r ? Number(r.min_amount_paise) : def.defaultMin,
        // Whether this person would even see it, so the screen can explain a
        // rule they cannot act on rather than hiding it.
        visibleToMe: perms.can(s, def.module, 'read'),
      };
    }),
    mine: {
      quietFrom: me[0].quiet_from,
      quietTo: me[0].quiet_to,
      muted: me[0].notify_muted,
      inQuietHoursNow: inQuietHours({
        quietFrom: me[0].quiet_from, quietTo: me[0].quiet_to,
        notifyMuted: me[0].notify_muted,
      }),
    },
    note: 'Who hears about an event follows what they can already see. '
        + 'A salesperson who cannot open purchases is not told about a new bill.',
  };
}

/** Turn an event on or off for the whole business. */
async function setRule(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');
  const b = ctx.body || {};
  const event = String(b.event ?? '');
  if (!EVENTS[event]) throw new HttpError(400, 'BAD_EVENT', `There is no "${event}" event.`);

  const min = b.minAmountPaise === undefined ? 0 : Number(b.minAmountPaise);
  if (!Number.isFinite(min) || min < 0) {
    throw new HttpError(400, 'BAD_AMOUNT', 'The threshold must be zero or more.');
  }

  await query(
    `INSERT INTO notification_rules (org_id, event, enabled, min_amount_paise)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, event) DO UPDATE SET
       enabled = EXCLUDED.enabled, min_amount_paise = EXCLUDED.min_amount_paise`,
    [s.org.id, event, b.enabled !== false, Math.round(min)]);

  await audit.record(ctx, 'notify.rule', {
    entityId: event, entityName: EVENTS[event].label,
    after: { enabled: b.enabled !== false, minAmountPaise: Math.round(min) },
  });
  return { event, saved: true };
}

/** This person's own quiet hours. Personal, not a business setting. */
async function setMine(ctx) {
  const s = auth.requireUser(ctx);
  const b = ctx.body || {};
  const sets = [];
  const args = [s.user.id];

  for (const [key, col] of [['quietFrom', 'quiet_from'], ['quietTo', 'quiet_to']]) {
    if (b[key] === undefined) continue;
    const n = Number(b[key]);
    if (!Number.isInteger(n) || n < 0 || n > 23) {
      throw new HttpError(400, 'BAD_HOUR', 'Hours must be between 0 and 23.');
    }
    sets.push(`${col} = $${args.push(n)}`);
  }
  if (b.muted !== undefined) sets.push(`notify_muted = $${args.push(!!b.muted)}`);
  if (!sets.length) throw new HttpError(400, 'NOTHING_TO_DO', 'Nothing to change.');

  await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, args);
  return { saved: true };
}

/**
 * Check the things nobody reports on their own.
 *
 * A voucher arriving announces itself at ingest. A bill falling overdue, an
 * item dropping below its reorder level and a connector going quiet do not -
 * nothing happens at the moment they become true. So they are checked when
 * somebody opens the app, which is the only time the answer matters.
 */
async function sweep(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const rupees = (p) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

  const { rows: asOfRow } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [co.id]);
  const asOf = asOfRow[0].d;
  const day = new Date(asOf).toISOString().slice(0, 10);

  let raised = 0;

  // Bills that have just passed their due date.
  const { rows: overdue } = await query(
    `SELECT b.ref, b.party, b.amount_paise,
            ($2::date - effective_due(b.due_date, b.bill_date, l.credit_days)) AS days
       FROM open_bills b
       LEFT JOIN ledgers l ON l.company_id = b.company_id AND l.name = b.party
      WHERE b.company_id = $1
      ORDER BY b.amount_paise DESC LIMIT 20`, [co.id, asOf]);

  for (const b of overdue.filter((x) => Number(x.days) > 0).slice(0, 5)) {
    if (await raise(s.org.id, 'bill.overdue', {
      companyId: co.id,
      title: `${b.party} is ${b.days} days overdue`,
      body: `${rupees(Number(b.amount_paise))} against ${b.ref}`,
      amountPaise: Number(b.amount_paise),
      link: { screen: 'party', name: b.party },
      // Once per bill per day: a bill 40 days overdue is not 40 events.
      dedupeKey: `${b.ref}-${day}`,
    })) raised += 1;
  }

  for (const b of overdue.filter((x) => Number(x.days) === 0).slice(0, 5)) {
    if (await raise(s.org.id, 'bill.due', {
      companyId: co.id,
      title: `${b.party} — payment due today`,
      body: `${rupees(Number(b.amount_paise))} against ${b.ref}`,
      amountPaise: Number(b.amount_paise),
      link: { screen: 'party', name: b.party },
      dedupeKey: `${b.ref}-${day}`,
    })) raised += 1;
  }

  // Stock that needs attention.
  const { rows: stock } = await query(
    `SELECT name, closing_qty, reorder_level, unit FROM stock_items
      WHERE company_id = $1
        AND (closing_qty < 0 OR (reorder_level > 0 AND closing_qty <= reorder_level))
      ORDER BY closing_qty LIMIT 10`, [co.id]);

  for (const i of stock) {
    const negative = Number(i.closing_qty) < 0;
    if (await raise(s.org.id, negative ? 'stock.negative' : 'stock.low', {
      companyId: co.id,
      title: negative ? `${i.name} has gone negative` : `${i.name} is low`,
      body: negative
        ? `${i.closing_qty} ${i.unit || ''} — sold more than was bought`.trim()
        : `${i.closing_qty} ${i.unit || ''} left, reorder at ${i.reorder_level}`.trim(),
      link: { screen: 'item', name: i.name },
      dedupeKey: `${i.name}-${day}`,
    })) raised += 1;
  }

  // A connector that has stopped checking in.
  const { rows: conn } = await query(
    `SELECT machine_name, last_seen_at FROM connectors
      WHERE org_id = $1 AND revoked_at IS NULL
      ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`, [s.org.id]);

  if (conn.length && conn[0].last_seen_at) {
    const hours = (Date.now() - new Date(conn[0].last_seen_at).getTime()) / 3_600_000;
    if (hours > 6) {
      if (await raise(s.org.id, 'connector.offline', {
        title: 'The computer running Tally is offline',
        body: `${conn[0].machine_name || 'It'} has not checked in for `
            + `${Math.round(hours)} hours. Figures here are not current.`,
        link: { screen: 'sync' },
        // Once per day, not once per app open.
        dedupeKey: `offline-${new Date().toISOString().slice(0, 10)}`,
      })) raised += 1;
    }
  }

  return { raised };
}

module.exports = { feed, markRead, settings, setRule, setMine, sweep, visibleEvents };
