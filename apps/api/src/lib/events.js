'use strict';
const { query } = require('../db');

/**
 * The things worth telling somebody about.
 *
 * Every event is declared here with the module it belongs to, so who hears
 * about it falls out of the permissions that already exist: a salesperson who
 * cannot see purchases is not told about a new bill either. Nobody has to
 * configure that, and it cannot drift from what the screens show.
 */

const EVENTS = {
  'sale.new': {
    label: 'New sale', module: 'sales', level: 'info',
    hint: 'A sales invoice arrives from Tally.',
    defaultMin: 0,
  },
  'purchase.new': {
    label: 'New purchase', module: 'purchase', level: 'info',
    hint: 'A purchase bill arrives from Tally.',
    defaultMin: 0,
  },
  'payment.received': {
    label: 'Payment received', module: 'cashbank', level: 'info',
    hint: 'A receipt arrives from Tally.',
    defaultMin: 0,
  },
  'bill.due': {
    label: 'Bill due', module: 'outstanding', level: 'warn',
    hint: 'A bill reaches its due date.',
    defaultMin: 0,
  },
  'bill.overdue': {
    label: 'Bill overdue', module: 'outstanding', level: 'bad',
    hint: 'A bill passes its due date without being paid.',
    defaultMin: 0,
  },
  'stock.low': {
    label: 'Stock low', module: 'inventory', level: 'warn',
    hint: 'An item falls to or below its reorder level.',
    defaultMin: 0,
  },
  'stock.negative': {
    label: 'Negative stock', module: 'inventory', level: 'bad',
    hint: 'More of an item has been sold than bought.',
    defaultMin: 0,
  },
  'sync.failed': {
    label: 'Sync failed', module: 'sync', level: 'bad',
    hint: 'The connector could not read Tally or reach Munim.',
    defaultMin: 0,
  },
  'connector.offline': {
    label: 'Tally computer offline', module: 'sync', level: 'bad',
    hint: 'The computer running Tally has stopped checking in.',
    defaultMin: 0,
  },
  'backup.done': {
    label: 'Backup taken', module: 'settings', level: 'info',
    hint: 'An automatic backup finished.',
    defaultMin: 0,
  },
  'backup.failed': {
    label: 'Backup failed', module: 'settings', level: 'bad',
    hint: 'An automatic backup did not finish.',
    defaultMin: 0,
  },
};

/**
 * Raise one.
 *
 * Never throws. An event is a side effect of something that already succeeded;
 * failing to announce a sale must not fail the sale.
 */
async function raise(orgId, event, {
  companyId = null, title, body = '', link = {}, dedupeKey = '', amountPaise = 0,
} = {}) {
  try {
    const def = EVENTS[event];
    if (!def) return null;

    const { rows: rule } = await query(
      'SELECT enabled, min_amount_paise FROM notification_rules WHERE org_id = $1 AND event = $2',
      [orgId, event]);

    // Absent means the built-in default, so a new event type works for every
    // existing customer without a backfill.
    if (rule.length && !rule[0].enabled) return null;
    const min = rule.length ? Number(rule[0].min_amount_paise) : def.defaultMin;
    if (min > 0 && Math.abs(amountPaise) < min) return null;

    const { rows } = await query(
      `INSERT INTO notifications (org_id, company_id, event, level, title, body,
                                  link, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (org_id, event, dedupe_key) DO NOTHING
       RETURNING id`,
      [orgId, companyId, event, def.level, String(title).slice(0, 200),
       String(body).slice(0, 500), JSON.stringify(link), String(dedupeKey).slice(0, 200)]);

    /*
     * Trimmed here rather than on a schedule.
     *
     * Nothing in this system runs on a timer, and a feed nobody prunes grows
     * until the query that reads it becomes the slowest thing on the
     * dashboard.
     */
    if (rows.length && rows[0].id % 50 === 0) {
      await query(
        `DELETE FROM notifications WHERE org_id = $1 AND id NOT IN (
           SELECT id FROM notifications WHERE org_id = $1 ORDER BY at DESC LIMIT 500)`,
        [orgId]);
    }

    return rows[0]?.id ?? null;
  } catch (e) {
    console.warn('  could not raise notification:', e.message);
    return null;
  }
}

/**
 * Is it a reasonable hour for this person?
 *
 * Quiet hours wrap midnight, which is the normal case: 22 to 7 means the whole
 * night, not "never". Getting this wrong either silences everything or
 * silences nothing.
 */
function inQuietHours(user, now = new Date()) {
  if (!user || user.notifyMuted) return true;
  const from = user.quietFrom ?? 22;
  const to = user.quietTo ?? 7;
  const h = now.getHours();
  return from <= to ? (h >= from && h < to) : (h >= from || h < to);
}

module.exports = { EVENTS, raise, inQuietHours };
