'use strict';
const crypto = require('crypto');
const { query } = require('../db');
const { HttpError } = require('./http');

/**
 * Tokens are stored only as a SHA-256 hash. A database dump therefore does not
 * hand anyone a working session or a working connector.
 *
 * SHA-256 (not Argon2) is right here: these are 256-bit random values, not
 * user-chosen passwords, so there is nothing to brute force.
 */
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = (prefix) => `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;

/*
 * Sessions do not expire on a timer.
 *
 * Signing in again every 60 days protects nobody: the token lives on a phone
 * the owner is holding, and an attacker with the phone has it now, not in two
 * months. What actually protects the account is revocation - signing out, or
 * "sign out all other devices" - and that works instantly, whatever the age of
 * the session. So expires_at is NULL and the row lives until someone ends it.
 */

/**
 * `deviceLabel` is what the owner will read months later when deciding which
 * sign-in to cut off, so keep it short and human ("Android 13"). It is supplied
 * by the client and therefore untrusted: it is only ever displayed, never used
 * to decide anything, and is length-capped so it cannot bloat the row.
 */
async function createSession(userId, deviceLabel = null) {
  const token = newToken('acc');
  const label = typeof deviceLabel === 'string' && deviceLabel.trim()
    ? deviceLabel.trim().slice(0, 60)
    : null;
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, device_label, last_seen_at)
     VALUES ($1, $2, NULL, $3, now())`,
    [hash(token), userId, label],
  );
  return token;
}

/** Returns { user, org } for a valid bearer token, or null. */
async function sessionFor(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.id, u.phone, u.name, u.role, u.org_id, u.email, u.status,
            u.role_id, u.branch, u.is_salesperson, u.salesperson_name,
            r.key AS role_key, r.name AS role_name, r.permissions,
            o.name AS org_name, o.plan, o.trial_ends_at, o.message_credits,
            o.features, o.max_connectors, o.max_companies
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN orgs  o ON o.id = u.org_id
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > now())`,
    [hash(token)],
  );
  if (!rows.length) return null;

  const r = rows[0];
  /*
   * A disabled user has no session, however valid their token.
   *
   * Checked here rather than at sign-in alone: the whole point of disabling
   * somebody is that it takes effect on the phone already in their pocket,
   * which is signed in and never expires.
   */
  if (r.status === 'disabled') return null;
  // Fire and forget: last-seen is telemetry, not something to block a request.
  query('UPDATE users SET last_seen_at = now() WHERE id = $1', [r.id]).catch(() => {});
  // Per-session too, so "last used 3 minutes ago" can tell a live phone from a
  // forgotten one. Throttled to a minute: this runs on every single request.
  query(
    `UPDATE sessions SET last_seen_at = now()
      WHERE token_hash = $1
        AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')`,
    [hash(token)],
  ).catch(() => {});

  return {
    user: {
      id: r.id, phone: r.phone, name: r.name, email: r.email,
      // `role` stays the legacy column so existing checks keep working;
      // roleKey and permissions are what the matrix actually reads.
      role: r.role,
      roleId: r.role_id,
      roleKey: r.role_key,
      roleName: r.role_name,
      permissions: r.permissions,
      branch: r.branch,
      isSalesperson: r.is_salesperson,
      salespersonName: r.salesperson_name,
    },
    org: {
      id: r.org_id, name: r.org_name, plan: r.plan,
      trialEndsAt: r.trial_ends_at, messageCredits: r.message_credits,
      // Carried on every request so a route never has to re-read the org just
      // to ask whether the customer is allowed to be here.
      features: r.features || {},
      maxConnectors: r.max_connectors,
      maxCompanies: r.max_companies,
    },
  };
}

async function revokeSession(token) {
  await query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1', [hash(token)]);
}

/**
 * Sign out everywhere except the phone asking.
 *
 * This is the answer to a lost or stolen phone, and it deliberately does not
 * require identifying which session was the lost one - the owner rarely knows,
 * and guessing wrong leaves the thief signed in. Cut them all; the devices you
 * still hold sign in again in seconds.
 */
async function revokeOtherSessions(userId, keepToken) {
  const { rowCount } = await query(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2`,
    [userId, hash(keepToken)],
  );
  return rowCount;
}

/** Returns { id, orgId } for a paired connector's device token, or null. */
async function connectorFor(token) {
  if (!token) return null;
  const { rows } = await query(
    'SELECT id, org_id FROM connectors WHERE token_hash = $1', [hash(token)],
  );
  return rows.length ? { id: rows[0].id, orgId: rows[0].org_id } : null;
}

// Guards. Each throws; the router turns that into a response.
const requireUser = (ctx) => {
  if (!ctx.session) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in again.');
  return ctx.session;
};

const requireOnboarded = (ctx) => {
  const s = requireUser(ctx);
  if (!s.org.name || !s.org.name.trim()) {
    throw new HttpError(409, 'NOT_ONBOARDED', 'Set up your business name first.');
  }
  return s;
};

const requireAdmin = (ctx) => {
  const s = requireUser(ctx);
  if (s.user.role !== 'platform_admin') {
    throw new HttpError(403, 'FORBIDDEN', 'This area is for Munim staff only.');
  }
  return s;
};

const requireConnector = (ctx) => {
  if (!ctx.connector) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'This connector is not paired.');
  }
  return ctx.connector;
};

module.exports = {
  hash, newToken, createSession, sessionFor, revokeSession, revokeOtherSessions,
  connectorFor,
  requireUser, requireOnboarded, requireAdmin, requireConnector,
};
