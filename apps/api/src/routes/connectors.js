'use strict';
const crypto = require('crypto');
const { query, tx } = require('../db');
const { HttpError, bad, notFound } = require('../lib/http');
const auth = require('../lib/auth');
const sync = require('./sync');

const INTENT_MINUTES = 15;

/**
 * The PC asks for a pairing code. Unauthenticated on purpose: the computer has
 * no account yet, and the code is worthless until a signed-in phone approves it.
 */
async function createIntent(ctx) {
  const code = 'int_' + crypto.randomBytes(9).toString('base64url');
  const { rows } = await query(
    `INSERT INTO pair_intents (code, expires_at)
     VALUES ($1, now() + ($2 || ' minutes')::interval) RETURNING code`,
    [code, String(INTENT_MINUTES)],
  );
  // Only offer a link when one actually resolves. Printing a munim.app URL on
  // a machine talking to a local API sends the owner to a domain that does not
  // answer - the code itself is what pairs, and it works with no domain at all.
  const base = process.env.PAIR_LINK_BASE;
  return {
    intentId: rows[0].code,
    pairUrl: base ? base.replace(/\/$/, '') + '/' + rows[0].code : null,
    ttl: INTENT_MINUTES * 60,
  };
}

/** The PC polls this. It hands the device token over exactly once. */
async function pollIntent(ctx) {
  const code = ctx.url.searchParams.get('id');
  if (!code) throw bad('BAD_REQUEST', 'Missing pairing code.');

  return tx(async (c) => {
    const { rows } = await c.query(
      'SELECT * FROM pair_intents WHERE code = $1 FOR UPDATE', [code]);
    if (!rows.length) throw notFound('This pairing code is not valid.');
    const i = rows[0];

    // Expiry is a normal state, not an error: the PC should offer a new code.
    if (new Date(i.expires_at) < new Date()) return { approved: false, expired: true };
    if (!i.approved_at) return { approved: false, expired: false };

    const { rows: org } = await c.query('SELECT name FROM orgs WHERE id = $1', [i.org_id]);
    const { rows: by } = await c.query('SELECT phone FROM users WHERE id = $1', [i.approved_by]);

    // Clear the one-time token so a replayed poll cannot hand it out twice.
    await c.query('UPDATE pair_intents SET device_token_once = NULL WHERE code = $1', [code]);

    return {
      approved: true,
      expired: false,
      deviceToken: i.device_token_once,
      connectorId: i.connector_id,
      orgId: i.org_id,
      orgName: org[0]?.name ?? '',
      approvedBy: by[0]?.phone ?? '',
    };
  });
}

/** Called BY THE MOBILE APP after scanning. This is what binds PC to tenant. */
async function approveIntent(ctx) {
  const s = auth.requireOnboarded(ctx);   // nothing to link Tally to otherwise
  const { intentId, machineName, tallyVersion, appVersion } = ctx.body;

  return tx(async (c) => {
    const { rows } = await c.query(
      'SELECT * FROM pair_intents WHERE code = $1 FOR UPDATE', [intentId]);
    if (!rows.length) throw notFound('This pairing code is not valid.');
    const i = rows[0];

    if (new Date(i.expires_at) < new Date()) {
      throw bad('EXPIRED', 'This code has expired. Get a new one on the computer.');
    }
    if (i.approved_at) throw new HttpError(409, 'ALREADY_PAIRED', 'This code was already used.');

    const token = auth.newToken('dev');
    const { rows: conn } = await c.query(
      `INSERT INTO connectors (org_id, machine_name, tally_version, app_version, token_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [s.org.id, machineName || 'Tally PC', tallyVersion || 'prime',
       appVersion || '', auth.hash(token)],
    );

    await c.query(
      `UPDATE pair_intents
          SET org_id = $1, approved_by = $2, approved_at = now(),
              connector_id = $3, device_token_once = $4
        WHERE code = $5`,
      [s.org.id, s.user.id, conn[0].id, token, intentId],
    );
    await c.query(
      `INSERT INTO audit_log (org_id, user_id, action, meta)
       VALUES ($1, $2, 'connector.paired', $3)`,
      [s.org.id, s.user.id, JSON.stringify({ machineName })],
    );

    return { success: true, connectorId: conn[0].id, orgName: s.org.name };
  });
}

/**
 * Every company Tally has open. The owner does not pick books on the PC - these
 * are their own books. What syncs is settled in the app and returned by the
 * heartbeat below.
 */
async function discover(ctx) {
  const conn = auth.requireConnector(ctx);
  const list = Array.isArray(ctx.body.companies) ? ctx.body.companies : [];

  const registered = [];
  for (const co of list) {
    if (!co.tallyGuid) continue;
    await query(
      `INSERT INTO companies (org_id, tally_guid, name, fy_start)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, tally_guid)
       DO UPDATE SET name = EXCLUDED.name`,
      [conn.orgId, co.tallyGuid, co.name || co.tallyGuid, co.fyStart || ''],
    );
    registered.push(co.tallyGuid);
  }
  return { registered };
}

/**
 * Health in, instructions out. This is the only inbound control path: a shop PC
 * has no reachable port, so anything we want it to do rides on its next beat.
 */
async function heartbeat(ctx) {
  const conn = auth.requireConnector(ctx);
  const { status, tallyUp, appVersion, lastError, queuedBatches,
          tallyEdition, tallyRelease } = ctx.body;

  await query(
    `UPDATE connectors
        SET last_seen_at = now(), status = $2, tally_up = $3,
            app_version = COALESCE(NULLIF($4,''), app_version),
            last_error = COALESCE($5,''),
            -- How far behind this machine is, so the fleet view can tell a
            -- brief blip from a shop that has been offline for days.
            queued_batches = GREATEST(COALESCE($6, 0), 0),
            -- "Not supported" is a very different support call from "not
            -- running", and only the connector can tell the two apart.
            tally_edition = COALESCE(NULLIF($7,''), tally_edition),
            tally_release = COALESCE(NULLIF($8,''), tally_release)
      WHERE id = $1`,
    [conn.id, status || 'ok', tallyUp !== false, appVersion || '', lastError || '',
     Number.isFinite(Number(queuedBatches)) ? Number(queuedBatches) : 0,
     tallyEdition || '', tallyRelease || ''],
  );

  const { rows } = await query(
    'SELECT tally_guid, enabled FROM companies WHERE org_id = $1', [conn.orgId]);

  // Anything the app asked for while this machine was away. The heartbeat is
  // the only way in, so this is where "sync now" is actually delivered.
  const commands = await sync.takeCommands(conn);

  const { rows: cfg } = await query(
    'SELECT sync_interval_seconds, tally_url FROM connectors WHERE id = $1', [conn.id]);

  /*
   * Is there anything to write?
   *
   * A boolean rather than the vouchers themselves: the heartbeat runs every few
   * seconds and is meant to stay tiny, and the outbox call that follows takes a
   * lease, which a heartbeat must not do. One cheap EXISTS beats sending an
   * empty array a million times a day.
   *
   * Gated on the org's own switch, so a business that has never turned writing
   * on never even gets asked.
   */
  const { rows: pending } = await query(
    `SELECT EXISTS (
       SELECT 1 FROM voucher_drafts d
         JOIN orgs o ON o.id = d.org_id
        WHERE d.org_id = $1 AND o.writes_enabled
          AND (d.status = 'queued'
               OR (d.status = 'sending' AND d.leased_until < now()))
     ) AS waiting`, [conn.orgId]);

  return {
    commands,
    hasOutbox: pending[0].waiting === true,
    // Settings travel down on every beat rather than being read once at start:
    // changing the interval from the app must not need a reinstall.
    settings: {
      intervalSeconds: cfg[0]?.sync_interval_seconds ?? 3,
      tallyUrl: cfg[0]?.tally_url || '',
    },
    companies: rows.map((r) => ({ tallyGuid: r.tally_guid, enabled: r.enabled })),
  };
}

module.exports = { createIntent, pollIntent, approveIntent, discover, heartbeat };
