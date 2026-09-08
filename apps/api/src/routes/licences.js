'use strict';
const crypto = require('crypto');
const { query, tx } = require('../db');
const auth = require('../lib/auth');
const { bad, HttpError } = require('../lib/http');

/**
 * Licence keys - what a customer buys, and what lets one Tally computer connect.
 *
 * The rules, in order of what they protect:
 *
 *  1. Staff issue keys. Customers cannot mint their own.
 *  2. A key works exactly once. The first connector to redeem it owns it, and
 *     every later attempt fails - which is what stops one paid licence being
 *     passed around a market.
 *  3. Redemption is a single transaction with a row lock, so two machines
 *     racing the same key cannot both win.
 *  4. Keys are stored hashed. Somebody with a database dump gets nothing usable.
 *  5. Staff can revoke, and the connector stops at its next heartbeat.
 */

// No 0/O/1/I/5/S: keys are read off invoices and typed by hand.
const ALPHABET = '2346789ABCDEFGHJKLMNPQRTUVWXYZ';

const hash = (k) => crypto.createHash('sha256').update(normalise(k)).digest('hex');

/** Accepts a key however it is typed: spaces, lower case, missing dashes. */
function normalise(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** MUNM-XXXX-XXXX-XXXX - the prefix makes it obvious what a key is. */
function mint() {
  const bytes = crypto.randomBytes(12);
  let body = '';
  for (let i = 0; i < 12; i++) body += ALPHABET[bytes[i] % ALPHABET.length];
  return `MUNM-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
}

const hintFor = (key) => `${key.slice(0, 9)}-****-****`;

/* -------------------------------------------------------------- staff --- */

/**
 * Issue keys. Staff only.
 *
 * Returns the full keys once and only here - they are hashed on the way in, so
 * this response is the single opportunity to copy them.
 */
async function issue(ctx) {
  const s = auth.requireAdmin(ctx);
  const count = Math.min(Math.max(parseInt(ctx.body?.count ?? 1, 10) || 1, 1), 100);
  const issuedTo = String(ctx.body?.issuedTo ?? '').slice(0, 120);
  const note = String(ctx.body?.note ?? '').slice(0, 240);
  const days = parseInt(ctx.body?.expiresInDays ?? 0, 10) || 0;

  const keys = [];
  for (let i = 0; i < count; i++) {
    const key = mint();
    await query(
      `INSERT INTO licence_keys (key_hash, key_hint, issued_to, note, issued_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, ${days ? `now() + ($6 || ' days')::interval` : 'NULL'})`,
      days
        ? [hash(key), hintFor(key), issuedTo, note, s.user.id, String(days)]
        : [hash(key), hintFor(key), issuedTo, note, s.user.id],
    );
    keys.push(key);
  }

  return {
    issued: keys.length,
    // Say it plainly: there is no second chance to read these.
    warning: 'Copy these now. Keys are stored hashed and cannot be shown again.',
    keys,
  };
}

/** Every key and what became of it. Staff only. */
async function list(ctx) {
  auth.requireAdmin(ctx);
  const { rows } = await query(
    `SELECT k.id, k.key_hint, k.issued_to, k.note, k.issued_at, k.expires_at,
            k.redeemed_at, k.machine_name, k.revoked_at, k.revoked_note,
            o.name AS org_name
       FROM licence_keys k LEFT JOIN orgs o ON o.id = k.org_id
      ORDER BY k.issued_at DESC LIMIT 500`,
  );
  return {
    keys: rows.map((r) => ({
      id: r.id,
      hint: r.key_hint,
      issuedTo: r.issued_to,
      note: r.note,
      issuedAt: r.issued_at,
      expiresAt: r.expires_at,
      status: r.revoked_at ? 'revoked'
        : r.redeemed_at ? 'in use'
        : r.expires_at && r.expires_at <= new Date() ? 'expired'
        : 'unused',
      usedBy: r.org_name,
      machine: r.machine_name,
      redeemedAt: r.redeemed_at,
      revokedNote: r.revoked_note,
    })),
  };
}

/** Kill a key. The connector using it stops at its next heartbeat. */
async function revoke(ctx, id) {
  auth.requireAdmin(ctx);
  const note = String(ctx.body?.note ?? '').slice(0, 240);
  const { rowCount } = await query(
    `UPDATE licence_keys SET revoked_at = now(), revoked_note = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [id, note],
  );
  if (!rowCount) throw bad('NOT_FOUND', 'No such key, or it is already revoked.');

  // Stop the machine too, rather than waiting for it to notice.
  await query(
    `UPDATE connectors SET status = 'revoked', token_hash = 'revoked:' || id::text
      WHERE licence_key_id = $1`,
    [id],
  );
  return { ok: true };
}

/* ---------------------------------------------------------- connector --- */

/**
 * Redeem a key during setup.
 *
 * Called by the connector before pairing. One transaction, one row lock: two
 * machines racing the same key cannot both succeed, which is the whole reason
 * the check lives on the server rather than in the script.
 */
async function redeem(ctx) {
  const key = normalise(ctx.body?.key);
  const machine = String(ctx.body?.machine ?? '').slice(0, 80);

  if (key.length < 12) {
    throw bad('BAD_LICENCE', 'That licence key does not look right. It looks like MUNM-XXXX-XXXX-XXXX.');
  }

  return tx(async (c) => {
    const { rows } = await c.query(
      'SELECT * FROM licence_keys WHERE key_hash = $1 FOR UPDATE', [hash(key)]);

    // One flat message for "no such key": saying which keys exist would let
    // somebody probe for valid ones.
    if (!rows.length) {
      throw new HttpError(403, 'BAD_LICENCE',
        'That licence key is not valid. Check it against your invoice.');
    }
    const k = rows[0];

    if (k.revoked_at) {
      throw new HttpError(403, 'LICENCE_REVOKED',
        'This licence key has been cancelled. Please contact Munim support.');
    }
    if (k.expires_at && k.expires_at <= new Date()) {
      throw new HttpError(403, 'LICENCE_EXPIRED',
        'This licence key has expired. Please contact Munim support.');
    }
    if (k.redeemed_at) {
      // Naming the machine turns "it does not work" into "oh, that is the old
      // shop PC" - which is most of the support call.
      throw new HttpError(403, 'LICENCE_IN_USE',
        `This licence key is already being used by ${k.machine_name || 'another computer'}. `
        + 'Each key connects one computer. Contact Munim for another.');
    }

    await c.query(
      `UPDATE licence_keys SET redeemed_at = now(), machine_name = $2 WHERE id = $1`,
      [k.id, machine],
    );

    return {
      ok: true,
      licenceId: k.id,
      issuedTo: k.issued_to,
    };
  });
}

module.exports = { issue, list, revoke, redeem, _hash: hash, _mint: mint };
