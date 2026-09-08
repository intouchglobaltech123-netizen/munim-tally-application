'use strict';
const crypto = require('crypto');
const { query } = require('../db');
const { HttpError } = require('./http');
const plans = require('./plans');

/**
 * Keys for other people's software.
 *
 * Deliberately not the same thing as a session. A session belongs to a person
 * and ends when they sign out; a key belongs to a program and has to outlive
 * everybody, including the employee who created it. Sharing one mechanism means
 * either sessions that never die or integrations that break when somebody
 * leaves - and the second is discovered at the worst possible moment.
 *
 * Read-only, always. Munim does not write to Tally, so an API that could write
 * would be writing to a copy - and the customer's accountant would reconcile
 * two sets of books that disagree. Every scope below is a read.
 */

const PREFIX = 'munim_';
const KEY_BYTES = 32;

/*
 * The twelve modules, same names the permission system uses.
 *
 * One vocabulary, so a key can never be granted something a role could not be,
 * and so a reader of either does not have to learn two words for one idea.
 */
const SCOPES = {
  dashboard:   'Totals and charts',
  sales:       'Sales vouchers',
  purchase:    'Purchase vouchers',
  cashbank:    'Receipts, payments and contra',
  outstanding: 'Receivables and payables',
  ledgers:     'Ledgers and statements',
  inventory:   'Stock items and quantities',
  reports:     'Day book, P&L, balance sheet',
  gst:         'GST returns and summaries',
  insights:    'Rankings and trends',
  settings:    'Company details and settings',
  users:       'People and roles',
};

/** A new key. Returned once, in clear, and never again. */
function mint() {
  const raw = crypto.randomBytes(KEY_BYTES).toString('base64url');
  const key = `${PREFIX}${raw}`;
  return { key, hash: hash(key), prefix: key.slice(0, PREFIX.length + 6) };
}

/*
 * SHA-256 rather than bcrypt, and the reason is not laziness.
 *
 * A password is short, human-chosen and brute-forceable, which is what a slow
 * hash defends against. This key is 32 bytes of CSPRNG output; there is nothing
 * to brute-force. What matters here is that verification is fast, because it
 * happens on every single API call, and a bcrypt round on every request is a
 * denial-of-service vector somebody else controls.
 */
const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');

/**
 * Resolve a key from a request, or return null.
 *
 * Never throws for a missing key: plenty of routes are session-authenticated
 * and asking about an API key first must not break them.
 */
async function resolve(rawKey) {
  if (typeof rawKey !== 'string' || !rawKey.startsWith(PREFIX)) return null;

  const { rows } = await query(
    `SELECT k.*, o.plan, o.limits, o.name AS org_name,
            o.max_connectors, o.max_companies, o.features
       FROM api_keys k JOIN orgs o ON o.id = k.org_id
      WHERE k.key_hash = $1`, [hash(rawKey)]);
  if (!rows.length) return null;

  const k = rows[0];
  if (k.revoked_at) {
    throw new HttpError(401, 'KEY_REVOKED', 'That API key has been revoked.');
  }
  if (k.expires_at && new Date(k.expires_at) < new Date()) {
    throw new HttpError(401, 'KEY_EXPIRED', 'That API key has expired.');
  }

  /*
   * The API is a paid feature, checked here rather than per route.
   *
   * A key that keeps working after a customer downgrades is revenue quietly
   * given away, and a key that stops with a 404 instead of a clear message is a
   * support call.
   */
  if (!plans.featuresFor(k).api) {
    throw new HttpError(403, 'API_NOT_ENABLED',
      'The API is not enabled on your plan. Upgrade to Pro to use it.');
  }

  return {
    id: k.id,
    orgId: k.org_id,
    orgName: k.org_name,
    name: k.name,
    scopes: k.scopes ?? [],
    companyId: k.company_id,
    org: {
      id: k.org_id, name: k.org_name, plan: k.plan, limits: k.limits,
      features: k.features, max_connectors: k.max_connectors, max_companies: k.max_companies,
    },
  };
}

/** Refuse a key that was not granted this module. */
function requireScope(apiKey, scope) {
  if (!apiKey) throw new HttpError(401, 'NO_KEY', 'Send an API key.');
  if (apiKey.scopes.includes(scope)) return;

  /*
   * The label is used as written, never lower-cased. "gst returns" and
   * "p&l" read as a product that mangles its own vocabulary, and this string
   * is read by a developer deciding whether Munim is worth integrating with.
   */
  const what = SCOPES[scope] ?? scope;
  throw new HttpError(403, 'SCOPE_MISSING',
    `This key cannot read ${what}. Add the "${scope}" scope to it.`);
}

/**
 * Record the call.
 *
 * Fire and forget, and never allowed to fail the request it describes: a log
 * write that breaks somebody's integration is worse than a missing log line.
 */
async function record(apiKey, { method, path, status, ms, ipPrefix = '', error = '' }) {
  if (!apiKey) return;
  try {
    await query(
      `INSERT INTO api_log (org_id, api_key_id, method, path, status, duration_ms,
                            ip_prefix, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [apiKey.orgId, apiKey.id, method, String(path).slice(0, 200), status,
       Math.round(ms), ipPrefix, String(error).slice(0, 300)]);

    await query(
      `UPDATE api_keys SET calls = calls + 1, last_used_at = now(), last_ip = $2
        WHERE id = $1`, [apiKey.id, ipPrefix]);
  } catch (e) {
    console.warn('  could not write api log:', e.message);
  }
}

module.exports = { mint, hash, resolve, requireScope, record, SCOPES, PREFIX };
