'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const audit = require('../lib/audit');
const { HttpError } = require('../lib/http');

const { ACTIONS } = audit;

/**
 * Reading the record of who did what.
 *
 * Deliberately read-only, with no delete of any kind. An audit log somebody
 * can edit is not one - and the person most motivated to tidy it is exactly
 * the person it exists to record.
 */

/** Turn a stored change into something readable without a JSON viewer. */
/*
 * Paise are stored as integers everywhere, and printing one raw gives
 * "amountPaise: 480000" - which reads as four hundred and eighty thousand
 * rupees when it means four thousand eight hundred. In an audit entry about
 * money that is not a cosmetic problem.
 */
function showValue(key, v) {
  if (v === null || v === undefined) return 'nothing';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (/paise$/i.test(key) && typeof v === 'number') {
    return `₹${(v / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  }
  if (typeof v === 'object') {
    return Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : 'changed';
  }
  return String(v).slice(0, 40);
}

/** A field name a shop owner would recognise. */
const FIELD = {
  amountPaise: 'amount', vch_no: 'number', vchNo: 'number',
  companies: 'books', permissions: 'what they can do',
};
const fieldName = (k) => FIELD[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

function describe(row) {
  const b = row.before_val ?? {};
  const a = row.after_val ?? {};

  /*
   * Keyed off both sides, not just `after`.
   *
   * A deletion has a before and no after, and keying off `after` alone left
   * every deleted voucher described as an empty string - the entries most
   * worth reading were the ones that said nothing.
   */
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  if (!keys.length) return '';

  return keys.slice(0, 6).map((k) => {
    const was = b[k];
    const now = a[k];
    const name = fieldName(k);
    // "paper: A4 → Thermal" reads; a JSON diff does not.
    if (was === undefined) return `${name}: ${showValue(k, now)}`;
    if (now === undefined) return `${name}: ${showValue(k, was)}`;
    return `${name}: ${showValue(k, was)} → ${showValue(k, now)}`;
  }).join(', ');
}

async function list(ctx) {
  /*
   * Gated on `users`, not `settings`.
   *
   * The log records who changed permissions and who removed people, which is
   * information about staff - so it belongs with the screen that manages them,
   * and a manager who can change settings does not automatically get it.
   */
  const s = perms.require(auth.requireUser(ctx), 'users', 'read');
  const q = ctx.url.searchParams;

  const limit = Math.min(Math.max(parseInt(q.get('limit') ?? '100', 10) || 100, 1), 500);
  const args = [s.org.id];
  let where = 'a.org_id = $1';

  if (q.get('action')) where += ` AND a.action = $${args.push(q.get('action'))}`;
  if (q.get('entity')) where += ` AND a.entity = $${args.push(q.get('entity'))}`;
  if (q.get('user')) where += ` AND a.user_id = $${args.push(q.get('user'))}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '')) {
    where += ` AND a.at >= $${args.push(q.get('from'))}::date`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.get('to') || '')) {
    // Inclusive of the whole end day, which is what a person means by "to".
    where += ` AND a.at < ($${args.push(q.get('to'))}::date + 1)`;
  }
  if (q.get('q')) {
    const i = args.push(`%${q.get('q')}%`);
    where += ` AND (a.entity_name ILIKE $${i} OR a.actor_name ILIKE $${i}
                    OR a.actor_email ILIKE $${i})`;
  }

  const { rows } = await query(
    `SELECT a.*, u.name AS user_name, u.email AS user_email, c.name AS company_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN companies c ON c.id = a.company_id
      WHERE ${where}
      ORDER BY a.at DESC LIMIT $${args.push(limit)}`, args);

  const { rows: actors } = await query(
    `SELECT DISTINCT a.user_id AS id,
            COALESCE(NULLIF(a.actor_name, ''), u.name, a.actor_email, 'Unknown') AS name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.org_id = $1 AND a.user_id IS NOT NULL
      ORDER BY name`, [s.org.id]);

  const { rows: used } = await query(
    `SELECT action, count(*)::int AS n FROM audit_log
      WHERE org_id = $1 GROUP BY action ORDER BY n DESC`, [s.org.id]);

  return {
    entries: rows.map((r) => ({
      id: String(r.id),
      action: r.action,
      // The stored name wins: an entry must not turn anonymous when somebody
      // leaves the company.
      label: ACTIONS[r.action]?.label ?? r.action,
      entity: r.entity,
      entityId: r.entity_id,
      entityName: r.entity_name,
      by: r.actor_name || r.user_name || r.actor_email || r.user_email || 'Unknown',
      byEmail: r.actor_email || r.user_email || '',
      companyName: r.company_name ?? '',
      ipPrefix: r.ip_prefix,
      device: r.device,
      at: r.at,
      changes: describe(r),
      before: r.before_val,
      after: r.after_val,
      meta: r.meta ?? {},
    })),
    // Only actions that have actually happened, so the filter never offers a
    // choice that returns nothing.
    actions: used.map((r) => ({
      key: r.action, label: ACTIONS[r.action]?.label ?? r.action, count: r.n,
    })),
    actors,
    note: 'This record cannot be edited or deleted from Munim.',
  };
}

/** Everything that ever happened to one thing. */
async function forEntity(ctx, entity, entityId) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'read');

  const { rows } = await query(
    `SELECT a.*, u.name AS user_name FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.org_id = $1 AND a.entity = $2 AND a.entity_id = $3
      ORDER BY a.at DESC LIMIT 100`, [s.org.id, entity, entityId]);

  return {
    entity,
    entityId,
    entries: rows.map((r) => ({
      id: String(r.id), action: r.action,
      label: ACTIONS[r.action]?.label ?? r.action,
      by: r.actor_name || r.user_name || 'Unknown',
      at: r.at, changes: describe(r),
    })),
  };
}

/*
 * Exports and downloads happen entirely in the browser or on the phone - the
 * file is built from data the client already holds, and the server never sees
 * the click. They are in the spec and they matter (an export is data leaving
 * the business), so the client reports them here.
 *
 * A client-reported event is only as trustworthy as the client, so this route
 * is deliberately narrow: a fixed whitelist of two actions, no before/after,
 * and a short label. Nothing here can forge a role change or a sign-in.
 */
const CLIENT_ACTIONS = new Set(['export.csv', 'doc.download']);

async function clientEvent(ctx) {
  // No permission gate beyond being signed in: this records what the caller
  // themselves just did, and refusing it would only lose the record.
  auth.requireUser(ctx);

  const action = String(ctx.body?.action ?? '');
  if (!CLIENT_ACTIONS.has(action)) {
    throw new HttpError(400, 'BAD_ACTION', 'That is not something the app reports.');
  }

  await audit.record(ctx, action, {
    entityName: String(ctx.body?.name ?? '').slice(0, 120),
    meta: {
      rows: Number.isFinite(Number(ctx.body?.rows)) ? Number(ctx.body.rows) : undefined,
      format: String(ctx.body?.format ?? '').slice(0, 20) || undefined,
    },
  });
  return { ok: true };
}

module.exports = { list, forEntity, describe, clientEvent };
