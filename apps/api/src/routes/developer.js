'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const apikeys = require('../lib/apikeys');
const webhooks = require('../lib/webhooks');
const audit = require('../lib/audit');
const plans = require('../lib/plans');
const { HttpError, bad } = require('../lib/http');

/**
 * The screens a customer manages their integration from.
 *
 * Separate from the public API itself: this is the app talking to itself with a
 * session, about keys that other software will use later.
 */

function requireOwner(s, what) {
  if (s.user.role === 'owner' || s.user.role === 'platform_admin') return;
  throw new HttpError(403, 'OWNER_ONLY', `Only an owner can ${what}.`);
}

/** Keys, webhooks, recent calls, and whether the plan allows any of it. */
async function overview(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');

  const { rows: org } = await query('SELECT * FROM orgs WHERE id = $1', [s.org.id]);
  const enabled = plans.featuresFor(org[0]).api;

  const [keys, hooks, calls, recent] = await Promise.all([
    query(`SELECT k.*, u.name AS by_name, c.name AS company_name
             FROM api_keys k
             LEFT JOIN users u ON u.id = k.created_by
             LEFT JOIN companies c ON c.id = k.company_id
            WHERE k.org_id = $1 ORDER BY k.created_at DESC`, [s.org.id]),
    query(`SELECT * FROM webhooks WHERE org_id = $1 ORDER BY created_at DESC`, [s.org.id]),
    query(`SELECT count(*)::int AS n,
                  count(*) FILTER (WHERE status >= 400)::int AS errors,
                  COALESCE(avg(duration_ms), 0)::int AS avg_ms
             FROM api_log WHERE org_id = $1 AND at > now() - interval '24 hours'`,
    [s.org.id]),
    query(`SELECT method, path, status, duration_ms, at, error
             FROM api_log WHERE org_id = $1 ORDER BY at DESC LIMIT 50`, [s.org.id]),
  ]);

  return {
    enabled,
    /*
     * Said plainly rather than hiding the screen. A developer who cannot find
     * the API assumes there isn't one; a developer told it needs Pro asks
     * their client to upgrade.
     */
    disabledNote: enabled ? '' :
      'The API is not enabled on your plan. Upgrade to Pro to create keys.',

    keys: keys.rows.map((k) => ({
      id: k.id,
      name: k.name,
      // Never the key itself. It exists in clear exactly once, at creation.
      prefix: k.prefix,
      scopes: k.scopes,
      company: k.company_name ?? null,
      createdAt: k.created_at,
      createdBy: k.by_name ?? '',
      lastUsedAt: k.last_used_at,
      lastIp: k.last_ip,
      expiresAt: k.expires_at,
      revokedAt: k.revoked_at,
      calls: Number(k.calls),
      status: k.revoked_at ? 'revoked'
        : k.expires_at && new Date(k.expires_at) < new Date() ? 'expired'
        : !k.last_used_at ? 'never used' : 'active',
    })),

    webhooks: hooks.rows.map((h) => ({
      id: h.id,
      url: h.url,
      events: h.events,
      active: h.active,
      lastStatus: h.last_status,
      lastError: h.last_error,
      lastAt: h.last_at,
      failures: h.failures,
      disabledAt: h.disabled_at,
      // The secret is shown once, at creation, like the key.
      secretHint: `${h.secret.slice(0, 11)}…`,
    })),

    usage: {
      calls24h: calls.rows[0].n,
      errors24h: calls.rows[0].errors,
      averageMs: calls.rows[0].avg_ms,
      limitPerDay: plans.limitFor(org[0], 'apiCallsPerDay'),
    },
    recentCalls: recent.rows,

    scopes: Object.entries(apikeys.SCOPES).map(([key, label]) => ({ key, label })),
    events: Object.entries(webhooks.EVENTS).map(([key, label]) => ({ key, label })),
    baseUrl: process.env.PUBLIC_API_URL || '',
    note: 'The API is read-only. Vouchers created in the Munim app can be '
        + 'written to Tally, but never through a key — an integration can '
        + 'read your books and nothing more.',
  };
}

/** Create a key. Shown once. */
async function createKey(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'create');
  requireOwner(s, 'create API keys');

  const { rows: org } = await query('SELECT * FROM orgs WHERE id = $1', [s.org.id]);
  if (!plans.featuresFor(org[0]).api) {
    throw new HttpError(403, 'API_NOT_ENABLED',
      'The API is not enabled on your plan. Upgrade to Pro to create keys.');
  }

  const name = String(ctx.body?.name ?? '').trim();
  if (name.length < 2 || name.length > 60) {
    throw bad('BAD_NAME', 'Give the key a name of 2 to 60 characters — you will '
                        + 'need it to tell keys apart later.');
  }

  const scopes = Array.isArray(ctx.body?.scopes)
    ? [...new Set(ctx.body.scopes.filter((x) => x in apikeys.SCOPES))] : [];
  if (!scopes.length) {
    throw bad('NO_SCOPES', 'Choose at least one thing this key may read.');
  }

  let companyId = null;
  if (ctx.body?.company) {
    const { rows } = await query(
      'SELECT id FROM companies WHERE org_id = $1 AND tally_guid = $2',
      [s.org.id, ctx.body.company]);
    if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such company.');
    companyId = rows[0].id;
  }

  /*
   * An expiry is offered but not forced.
   *
   * A key that silently stops working at 2am on a Sunday because a default
   * expiry lapsed is worse than a long-lived key an owner can see and revoke -
   * and the list shows when each was last used, which is the actual defence
   * against forgotten keys.
   */
  const days = Number(ctx.body?.expiresInDays ?? 0);
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000) : null;

  const { key, hash, prefix } = apikeys.mint();

  const { rows } = await query(
    `INSERT INTO api_keys (org_id, name, key_hash, prefix, scopes, company_id,
                           created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [s.org.id, name, hash, prefix, scopes, companyId, s.user.id, expiresAt]);

  await audit.record(ctx, 'api.key.create', {
    entityId: rows[0].id, entityName: name,
    after: { scopes, expiresAt: expiresAt?.toISOString() ?? null },
  });

  return {
    id: rows[0].id,
    name,
    // The only time this is ever returned.
    key,
    prefix,
    scopes,
    expiresAt,
    warning: 'Copy this now. It is stored only as a hash and cannot be shown '
           + 'again — if you lose it, revoke it and make another.',
  };
}

/** Revoke a key. There is no un-revoke: make a new one. */
async function revokeKey(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'delete');
  requireOwner(s, 'revoke API keys');

  const { rows } = await query(
    `UPDATE api_keys SET revoked_at = now()
      WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL RETURNING name`,
    [id, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such key, or already revoked.');

  await audit.record(ctx, 'api.key.revoke', { entityId: id, entityName: rows[0].name });
  return {
    revoked: true,
    message: `"${rows[0].name}" stops working immediately. Anything using it will `
           + 'start getting 401s.',
  };
}

/** Point Munim at somebody else's software. */
async function createWebhook(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'create');
  requireOwner(s, 'add webhooks');

  const check = webhooks.checkUrl(String(ctx.body?.url ?? ''));
  if (!check.ok) throw bad('BAD_URL', check.why);

  const events = Array.isArray(ctx.body?.events)
    ? [...new Set(ctx.body.events.filter((e) => e in webhooks.EVENTS))] : [];
  if (!events.length) throw bad('NO_EVENTS', 'Choose at least one event to be told about.');

  const secret = webhooks.newSecret();
  const { rows } = await query(
    `INSERT INTO webhooks (org_id, url, events, secret, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [s.org.id, check.url, events, secret, s.user.id]);

  await audit.record(ctx, 'api.webhook.create', {
    entityId: rows[0].id, entityName: check.url, after: { events },
  });

  return {
    id: rows[0].id,
    url: check.url,
    events,
    secret,
    warning: 'Copy this signing secret now — it is not shown again.',
    howToVerify:
      'Every delivery carries X-Munim-Timestamp and X-Munim-Signature. '
      + 'Recompute HMAC-SHA256 of "<timestamp>.<raw body>" with this secret and '
      + 'compare. Reject anything whose timestamp is more than a few minutes '
      + 'old, or a replayed delivery will look genuine for ever.',
  };
}

/** Stop, restart or remove an endpoint. */
async function updateWebhook(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');
  requireOwner(s, 'change webhooks');

  const body = ctx.body || {};
  const setActive = typeof body.active === 'boolean' ? body.active : null;
  const events = Array.isArray(body.events)
    ? [...new Set(body.events.filter((e) => e in webhooks.EVENTS))] : null;

  const { rows } = await query(
    `UPDATE webhooks
        SET active = COALESCE($3, active),
            events = COALESCE($4, events),
            -- Turning one back on clears the failure count, otherwise it is
            -- switched off again after one more bad delivery.
            failures = CASE WHEN $3 = true THEN 0 ELSE failures END,
            disabled_at = CASE WHEN $3 = true THEN NULL ELSE disabled_at END
      WHERE id = $1 AND org_id = $2 RETURNING *`,
    [id, s.org.id, setActive, events]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such webhook.');

  await audit.record(ctx, 'api.webhook.update', {
    entityId: id, entityName: rows[0].url, after: { active: rows[0].active },
  });
  return { id, active: rows[0].active, events: rows[0].events };
}

async function deleteWebhook(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'delete');
  requireOwner(s, 'remove webhooks');

  const { rows } = await query(
    'DELETE FROM webhooks WHERE id = $1 AND org_id = $2 RETURNING url', [id, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such webhook.');

  await audit.record(ctx, 'api.webhook.delete', { entityId: id, entityName: rows[0].url });
  return { deleted: true };
}

/** Send a test delivery, so nobody has to wait for a real event to find a typo. */
async function testWebhook(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');

  const { rows } = await query(
    'SELECT * FROM webhooks WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such webhook.');

  const out = await webhooks.deliver(rows[0], 'sync.completed', {
    test: true,
    message: 'This is a test delivery from Munim.',
    company: s.org.name ?? '',
  });

  return {
    ...out,
    message: out.ok
      ? `Your endpoint answered ${out.status}.`
      : `No good answer: ${out.error}. Munim retried ${webhooks.MAX_ATTEMPTS} times.`,
  };
}

/** What one endpoint has been sent, and how it went. */
async function deliveries(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');
  const { rows } = await query(
    `SELECT d.event, d.status, d.error, d.attempt, d.duration_ms, d.at
       FROM webhook_deliveries d
      WHERE d.webhook_id = $1 AND d.org_id = $2
      ORDER BY d.at DESC LIMIT 100`, [id, s.org.id]);
  return { deliveries: rows };
}

module.exports = {
  overview, createKey, revokeKey,
  createWebhook, updateWebhook, deleteWebhook, testWebhook, deliveries,
};
