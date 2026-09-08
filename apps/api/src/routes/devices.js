'use strict';
const { query } = require('../db');
const { notFound } = require('../lib/http');
const auth = require('../lib/auth');
const audit = require('../lib/audit');

/**
 * Linked devices - the Tally computers, and the phones signed in.
 *
 * Revoking must be possible from the app. A shop PC that was sold, stolen or
 * replaced should stop syncing without anyone travelling to it, and a phone
 * left signed in at a previous job should be removable by the owner.
 */

async function list(ctx) {
  const s = auth.requireUser(ctx);

  const { rows: connectors } = await query(
    `SELECT id, machine_name, tally_version, app_version, status, tally_up,
            paired_at, last_seen_at, revoked_at
       FROM connectors WHERE org_id = $1 ORDER BY paired_at DESC`,
    [s.org.id],
  );

  const { rows: sessions } = await query(
    `SELECT s.token_hash, s.created_at, s.expires_at, s.revoked_at,
            s.device_label, s.last_seen_at,
            u.phone, u.name, u.id AS user_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE u.org_id = $1 AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > now())
      ORDER BY s.created_at DESC LIMIT 20`,
    [s.org.id],
  );

  const thisSession = auth.hash(ctx.token);

  return {
    connectors: connectors.map((c) => ({
      id: c.id, machine: c.machine_name, tallyVersion: c.tally_version,
      appVersion: c.app_version, status: c.revoked_at ? 'revoked' : c.status,
      tallyUp: c.tally_up, pairedAt: c.paired_at, lastSeenAt: c.last_seen_at,
      revoked: !!c.revoked_at,
    })),
    signIns: sessions.map((r) => ({
      // Never expose the token, even hashed - just enough to recognise it.
      id: r.token_hash.slice(0, 12),
      phone: r.phone, name: r.name,
      device: r.device_label,
      signedInAt: r.created_at, expiresAt: r.expires_at,
      lastSeenAt: r.last_seen_at,
      current: r.token_hash === thisSession,
    })),
  };
}

/** Unlink a Tally computer. Its device token stops working immediately. */
async function revokeConnector(ctx, id) {
  const s = auth.requireUser(ctx);
  const { rowCount } = await query(
    `UPDATE connectors
        SET revoked_at = now(), status = 'revoked',
            -- Break the token so the connector cannot authenticate again. It
            -- has to be re-paired, which is the point of revoking.
            token_hash = 'revoked:' || id::text
      WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL`,
    [id, s.org.id],
  );
  if (!rowCount) throw notFound('No such device in your account.');

  await audit.record(ctx, 'auth.device.revoked', {
    entityId: id, entityName: 'Tally computer', meta: { kind: 'connector' },
  });
  return { revoked: true, id };
}

/** Sign a phone or browser out remotely. */
async function revokeSignIn(ctx, idPrefix) {
  const s = auth.requireUser(ctx);
  const { rowCount } = await query(
    `UPDATE sessions SET revoked_at = now()
      WHERE left(token_hash, 12) = $1
        AND user_id IN (SELECT id FROM users WHERE org_id = $2)
        AND revoked_at IS NULL`,
    [idPrefix, s.org.id],
  );
  if (!rowCount) throw notFound('No such sign-in.');
  await audit.record(ctx, 'auth.device.revoked', {
    entityId: idPrefix, entityName: 'Signed-in device', meta: { kind: 'signin' },
  });
  return { revoked: true, id: idPrefix };
}

/**
 * Sign out every other device.
 *
 * The recovery action for a lost or stolen phone. It does not ask which session
 * to kill, because the owner usually cannot tell - and a wrong guess leaves the
 * thief signed in. Everything except the phone making this request is cut.
 */
async function revokeOtherSignIns(ctx) {
  const s = auth.requireUser(ctx);
  const count = await auth.revokeOtherSessions(s.user.id, ctx.token);
  if (count) {
    await audit.record(ctx, 'auth.device.revoked', {
      entityName: 'All other devices', meta: { kind: 'all-others', revoked: count },
    });
  }
  return {
    revoked: count,
    message: count
      ? `Signed out of ${count} other device${count === 1 ? '' : 's'}.`
      : 'There were no other devices signed in.',
  };
}

module.exports = { list, revokeConnector, revokeSignIn, revokeOtherSignIns };
