'use strict';
const crypto = require('crypto');
const { query } = require('../db');
const audit = require('../lib/audit');
const auth = require('../lib/auth');
const { HttpError } = require('../lib/http');

/**
 * Account safety, for a product where sign-in is Google and nothing else.
 *
 * There is no password here to steal, which removes most of the usual attack
 * surface. What is left is worth defending properly: replayed ID tokens,
 * someone grinding the app sign-in code, and - the realistic one for a shop -
 * a phone already signed in, lying on the counter.
 */

/**
 * The network someone came from, at /24, and never finer.
 *
 * Enough to tell "the shop's usual broadband" from "another country", which is
 * the only question anyone asks of it. Keeping the exact address would be a
 * precise record of where a shop owner was sitting, for no extra benefit.
 */
function ipPrefix(ctx) {
  const raw = String(
    ctx.req?.headers?.['x-forwarded-for']?.split(',')[0]
    ?? ctx.req?.socket?.remoteAddress ?? '').trim();
  if (!raw) return '';
  const v4 = raw.replace(/^::ffff:/, '');
  const parts = v4.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  // IPv6: the first four groups are the routing prefix; the rest identifies
  // the device and is not ours to keep.
  const g = v4.split(':').filter(Boolean);
  return g.length >= 4 ? `${g.slice(0, 4).join(':')}::/64` : '';
}

/*
 * Five failures in fifteen minutes, then a fifteen-minute lock.
 *
 * Tuned to make grinding pointless while barely touching a real person: five
 * tries is more than anyone needs, and a shop owner who does hit the limit is
 * back in a quarter of an hour rather than ringing support. A permanent lock
 * would turn every fat-fingered login into a lost customer.
 */
const MAX_FAILURES = 5;
const WINDOW_MINUTES = 15;
const LOCK_MINUTES = 15;

/** Record an attempt. Never throws - logging must not break signing in. */
async function record(ctx, { userId, orgId, email, ok, via, reason }) {
  try {
    await query(
      `INSERT INTO login_events
         (user_id, org_id, email, ok, via, reason, device_kind, device_label, ip_prefix)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [userId ?? null, orgId ?? null, String(email || '').toLowerCase(),
       !!ok, via || '', String(reason || '').slice(0, 200),
       ctx.deviceKind || '', String(ctx.deviceLabel || '').slice(0, 200), ipPrefix(ctx)]);

    // Kept per account, not for ever. This is a security record, not an
    // archive, and nobody has ever needed the 300th most recent sign-in.
    if (userId) {
      await query(
        `DELETE FROM login_events WHERE user_id = $1 AND id NOT IN (
           SELECT id FROM login_events WHERE user_id = $1 ORDER BY at DESC LIMIT 200)`,
        [userId]);
    }
  } catch (e) {
    console.warn('  could not record login event:', e.message);
  }
}

/**
 * Refuse if this caller has been failing too often.
 *
 * Keyed on the NETWORK, not the account, and this is the important part.
 *
 * An invalid Google token can never grant access - the signature check is the
 * real gate, and it is Google's. So locking an ACCOUNT because somebody sent
 * rubbish naming that address protects nothing, while handing any stranger a
 * way to lock any customer out of their own books by spamming their email.
 * That is a denial of service built in on purpose, dressed as security.
 *
 * What unverified attempts actually cost is CPU and log space, and both are
 * per-caller. So the counter is per-caller too.
 *
 * The claimed address is used only as a fallback when there is no usable
 * network prefix (a direct connection with no proxy header, which in practice
 * means development). Even then nothing is written to the user row.
 */
async function assertNotThrottled(ctx, claimedEmail) {
  const net = ipPrefix(ctx);
  const addr = String(claimedEmail || '').toLowerCase();
  if (!net && !addr) return;

  const { rows } = await query(
    `SELECT count(*)::int AS n FROM login_events
      WHERE NOT ok
        AND at > now() - ($1 || ' minutes')::interval
        AND ($2 <> '' AND ip_prefix = $2 OR $2 = '' AND lower(email) = $3)`,
    [String(WINDOW_MINUTES), net, addr]);

  if (rows[0].n >= MAX_FAILURES) {
    throw new HttpError(429, 'TOO_MANY_ATTEMPTS',
      `Too many failed sign-in attempts. Try again in ${LOCK_MINUTES} minutes.`);
  }
}

/**
 * Refuse if the account itself is locked.
 *
 * Reached only where a GUESSABLE secret exists - the app sign-in code - so a
 * lock here answers real guessing rather than noise. Nothing an anonymous
 * caller sends can put an account into this state.
 */
async function assertNotLocked(email) {
  const addr = String(email || '').toLowerCase();
  if (!addr) return;

  const { rows } = await query(
    'SELECT locked_until FROM users WHERE lower(email) = $1', [addr]);

  const lockedUntil = rows[0]?.locked_until;
  if (lockedUntil && new Date(lockedUntil) > new Date()) {
    const mins = Math.max(1, Math.ceil((new Date(lockedUntil) - Date.now()) / 60_000));
    throw new HttpError(429, 'ACCOUNT_LOCKED',
      `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
}

/**
 * Lock an account after repeated failures against a secret we issued.
 *
 * Timed, never permanent: a real owner locked out for good is a lost customer,
 * and the point is to make guessing slow rather than to punish a mistake.
 */
async function lockAccount(userId) {
  await query(
    `UPDATE users SET locked_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
    [userId, String(LOCK_MINUTES)]);
}

/** A successful sign-in clears the slate. */
async function clearFailures(userId, email) {
  await query('UPDATE users SET locked_until = NULL WHERE id = $1', [userId]);
  await query(
    `DELETE FROM login_events WHERE lower(email) = $1 AND NOT ok`,
    [String(email || '').toLowerCase()]);
}

// ------------------------------------------------------------------ for apps

/** Every sign-in on this account, successful or not. */
async function loginHistory(ctx) {
  const s = auth.requireUser(ctx);
  const limit = Math.min(Math.max(
    parseInt(ctx.url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);

  const { rows } = await query(
    `SELECT at, ok, via, reason, device_kind, device_label, ip_prefix
       FROM login_events
      WHERE user_id = $1 OR (user_id IS NULL AND lower(email) = lower($2))
      ORDER BY at DESC LIMIT $3`,
    [s.user.id, s.user.email || '', limit]);

  const { rows: agg } = await query(
    `SELECT count(*) FILTER (WHERE NOT ok)::int AS failures
       FROM login_events
      WHERE (user_id = $1 OR lower(email) = lower($2))
        AND at > now() - interval '30 days'`,
    [s.user.id, s.user.email || '']);

  return {
    events: rows.map((r) => ({
      at: r.at, ok: r.ok, via: r.via, reason: r.reason,
      deviceKind: r.device_kind, deviceLabel: r.device_label,
      ipPrefix: r.ip_prefix,
    })),
    // Surfaced rather than buried: a failed sign-in the owner does not
    // recognise is the one signal that someone else has their token.
    failedLast30Days: agg[0].failures,
  };
}

/** Name a device, or mark it trusted. */
async function updateDevice(ctx, idPrefix) {
  const s = auth.requireUser(ctx);
  const b = ctx.body || {};
  const sets = [];
  const args = [s.user.id, `${idPrefix}%`];

  if (b.nickname !== undefined) {
    const n = String(b.nickname).trim().slice(0, 60);
    sets.push(`nickname = $${args.push(n)}`);
  }
  if (b.trusted !== undefined) {
    sets.push(`trusted = $${args.push(!!b.trusted)}`);
  }
  if (!sets.length) throw new HttpError(400, 'NOTHING_TO_DO', 'Nothing to change.');

  // Scoped to this user's own sessions: a device id must never address
  // somebody else's session, however it was guessed.
  const { rowCount } = await query(
    `UPDATE sessions SET ${sets.join(', ')}
      WHERE user_id = $1 AND token_hash LIKE $2 AND revoked_at IS NULL`, args);

  if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'No such device.');
  return { updated: rowCount };
}

// ------------------------------------------------------------- the app lock

/*
 * 120k rounds of PBKDF2-SHA256.
 *
 * A four-digit PIN is only ten thousand possibilities, so the hash is the only
 * thing standing between a leaked row and the PIN. Deliberately slow, and
 * per-user salted so one table cannot be attacked in bulk.
 */
const PIN_ROUNDS = 120_000;
const hashPin = (pin, salt) =>
  crypto.pbkdf2Sync(String(pin), salt, PIN_ROUNDS, 32, 'sha256').toString('hex');

/** Turn the app lock on, change it, or turn it off. */
async function setAppLock(ctx) {
  const s = auth.requireUser(ctx);
  const b = ctx.body || {};

  if (b.enabled === false) {
    await query(
      `UPDATE users SET app_lock_hash = '', app_lock_salt = '' WHERE id = $1`, [s.user.id]);
    return { enabled: false };
  }

  const pin = String(b.pin ?? '');
  if (!/^\d{4,8}$/.test(pin)) {
    throw new HttpError(400, 'BAD_PIN', 'Choose a PIN of 4 to 8 digits.');
  }
  // Refused because they are the first guesses anyone makes, and a lock that
  // stops nobody is worse than none - it buys false confidence.
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
    throw new HttpError(400, 'WEAK_PIN',
      'That PIN is too easy to guess. Avoid repeats and runs like 1234.');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const minutes = Number.isInteger(Number(b.minutes))
    ? Math.min(Math.max(Number(b.minutes), 0), 1440) : 0;

  await query(
    `UPDATE users SET app_lock_hash = $2, app_lock_salt = $3,
                      app_lock_minutes = $4, app_lock_biometric = $5
      WHERE id = $1`,
    [s.user.id, hashPin(pin, salt), salt, minutes, b.biometric !== false]);

  // The PIN itself is never written down anywhere, including here.
  await audit.record(ctx, 'security.applock', {
    after: { enabled: true, minutes, biometric: b.biometric !== false },
  });
  return { enabled: true, minutes, biometric: b.biometric !== false };
}

/** Check a PIN. Rate limiting is the app's job; this only says yes or no. */
async function checkAppLock(ctx) {
  const s = auth.requireUser(ctx);
  const { rows } = await query(
    'SELECT app_lock_hash, app_lock_salt FROM users WHERE id = $1', [s.user.id]);

  const r = rows[0];
  if (!r?.app_lock_hash) return { ok: true, enabled: false };

  const given = hashPin(String(ctx.body?.pin ?? ''), r.app_lock_salt);
  // Constant time: a fast "wrong" and a slow "wrong" leak how much of the PIN
  // was right.
  const ok = crypto.timingSafeEqual(
    Buffer.from(given, 'hex'), Buffer.from(r.app_lock_hash, 'hex'));

  return { ok, enabled: true };
}

/** What the apps need to know about this account's protection. */
async function status(ctx) {
  const s = auth.requireUser(ctx);
  const { rows } = await query(
    `SELECT app_lock_hash <> '' AS locked, app_lock_minutes, app_lock_biometric,
            locked_until
       FROM users WHERE id = $1`, [s.user.id]);
  const r = rows[0];

  const { rows: devices } = await query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE trusted)::int AS trusted
       FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [s.user.id]);

  return {
    appLock: {
      enabled: r.locked,
      minutes: r.app_lock_minutes,
      biometric: r.app_lock_biometric,
    },
    devices: { active: devices[0].n, trusted: devices[0].trusted },
    accountLockedUntil: r.locked_until,
    // Stated plainly because it is a deliberate decision people ask about.
    sessionPolicy: {
      expires: false,
      note: 'You stay signed in until you sign out, like WhatsApp. '
          + 'Signing in on another phone signs the first one out.',
    },
  };
}

module.exports = {
  record, assertNotThrottled, assertNotLocked, lockAccount, clearFailures, ipPrefix,
  loginHistory, updateDevice, setAppLock, checkAppLock, status,
  MAX_FAILURES, LOCK_MINUTES, WINDOW_MINUTES,
};
