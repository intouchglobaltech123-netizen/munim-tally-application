'use strict';
const { query } = require('../db');
const audit = require('../lib/audit');
const auth = require('../lib/auth');
const { HttpError } = require('../lib/http');

/**
 * What the connector did, what went wrong, and how to ask it to try again.
 *
 * The connector is the part of Munim that runs on somebody else's computer,
 * behind their router, on their internet. It is the only component we cannot
 * watch directly, and it is the one whose failure makes every figure in the
 * product silently wrong. So it reports what it did, and this is where that
 * lands.
 */

// --------------------------------------------------------- from the connector

/** Classify a failure by what the shop would have to do about it. */
function classify(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return '';
  if (/timed out|timeout|unable to connect|refused|no such host|network|offline|dns/.test(m)) {
    return 'network';
  }
  if (/unauthor|forbidden|revoked|token|licence|license/.test(m)) return 'auth';
  if (/tally|9000|odbc|company .*not open/.test(m)) return 'tally';
  return 'other';
}

/** The connector reporting one pass, successful or not. */
async function reportRun(ctx) {
  const conn = auth.requireConnector(ctx);
  const b = ctx.body || {};

  let companyId = null;
  if (b.tallyGuid) {
    const { rows } = await query(
      'SELECT id FROM companies WHERE org_id = $1 AND tally_guid = $2',
      [conn.orgId, b.tallyGuid]);
    companyId = rows[0]?.id ?? null;
  }

  const started = b.startedAt ? new Date(b.startedAt) : new Date();
  const ok = b.ok !== false;
  const error = String(b.error || '').slice(0, 2000);

  await query(
    `INSERT INTO sync_runs
       (org_id, connector_id, company_id, started_at, duration_ms, trigger, ok,
        records, batches, vouchers, masters, error, error_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [conn.orgId, conn.id, companyId, started,
     Math.max(0, Number(b.durationMs) || 0),
     ['auto', 'manual', 'startup', 'command'].includes(b.trigger) ? b.trigger : 'auto',
     ok,
     Math.max(0, Number(b.records) || 0), Math.max(0, Number(b.batches) || 0),
     Math.max(0, Number(b.vouchers) || 0), Math.max(0, Number(b.masters) || 0),
     error, ok ? '' : classify(error)]);

  /*
   * Kept small deliberately. This is diagnostic history, not an accounting
   * record - a connector beating every three seconds would otherwise write
   * millions of rows a month per shop, and nobody has ever needed the 400th
   * most recent sync.
   */
  await query(
    `DELETE FROM sync_runs WHERE org_id = $1 AND id NOT IN (
       SELECT id FROM sync_runs WHERE org_id = $1 ORDER BY started_at DESC LIMIT 500)`,
    [conn.orgId]);

  /*
   * Only a FAILED run and a run that carried something are worth telling
   * anybody about. A connector reports every three seconds, and a webhook per
   * heartbeat would drown a receiver in "nothing happened".
   */
  if (!ok) {
  } else if (Number(b.records) > 0) {
  }

  return { recorded: true };
}

/** Log lines, uploaded when somebody asked for them. */
async function uploadLogs(ctx) {
  const conn = auth.requireConnector(ctx);
  const lines = Array.isArray(ctx.body.lines) ? ctx.body.lines.slice(0, 500) : [];
  if (!lines.length) return { stored: 0 };

  for (const l of lines) {
    await query(
      `INSERT INTO connector_logs (org_id, connector_id, at, level, line)
       VALUES ($1,$2,$3,$4,$5)`,
      [conn.orgId, conn.id,
       l.at ? new Date(l.at) : new Date(),
       ['info', 'warn', 'error'].includes(l.level) ? l.level : 'info',
       String(l.line || '').slice(0, 2000)]);
  }

  await query(
    `DELETE FROM connector_logs WHERE org_id = $1 AND id NOT IN (
       SELECT id FROM connector_logs WHERE org_id = $1 ORDER BY at DESC LIMIT 2000)`,
    [conn.orgId]);

  return { stored: lines.length };
}

/**
 * Reconciliation: what Tally holds against what we hold.
 *
 * The incremental sync is driven by ALTERID, which only ever counts upward as
 * records change. Tally does not raise an ALTERID when a voucher is DELETED -
 * so a deleted voucher stays in Munim for ever, and every total that includes
 * it is quietly wrong. Nothing else in the pipeline can detect that.
 *
 * The connector sends the full set of GUIDs it can see; anything we hold that
 * is not in that set is gone from Tally and must go from here too.
 */
/** One removed record, in the few fields worth keeping a copy of. */
function describeRemoved(r) {
  const out = { name: r.vch_no || '' };
  if (r.vch_type !== undefined) {
    out.type = r.vch_type || '';
    out.party = r.party || '';
    out.amountPaise = Math.abs(Number(r.amount_paise) || 0);
    out.date = audit.dateOnly(r.vch_date);
  }
  return out;
}

async function reconcile(ctx) {
  const conn = auth.requireConnector(ctx);
  const b = ctx.body || {};
  const guids = Array.isArray(b.guids) ? b.guids.filter((g) => typeof g === 'string') : [];
  const kind = b.kind === 'ledger' ? 'ledgers'
    : b.kind === 'stockItem' ? 'stock_items'
    : b.kind === 'voucher' ? 'vouchers' : null;

  if (!kind) throw new HttpError(400, 'BAD_KIND', 'kind must be voucher, ledger or stockItem.');

  const { rows: co } = await query(
    'SELECT id FROM companies WHERE org_id = $1 AND tally_guid = $2',
    [conn.orgId, b.tallyGuid]);
  if (!co.length) throw new HttpError(404, 'NOT_FOUND', 'No such company.');
  const companyId = co[0].id;

  /*
   * "complete" is the safety catch, and it matters more than anything else
   * here.
   *
   * If the connector could only read part of Tally - a timeout halfway, a
   * company that closed mid-pass - then acting on a partial list would delete
   * real records that are simply missing from a truncated answer. Destroying a
   * customer's books because their internet hiccuped is the worst thing this
   * product could do, so a partial reconcile counts and reports, and deletes
   * nothing.
   */
  const complete = b.complete === true;

  /*
   * The identifying detail is fetched BEFORE the delete, not after: once the
   * row is gone there is nothing left to describe, and "37 vouchers were
   * removed" is not an audit trail. Which invoice, for whose account, for how
   * much - that is the thing an owner needs when a receivable disappears.
   *
   * Only vouchers carry number/party/amount; the master tables do not, so the
   * extra columns come back null there and are simply not written.
   */
  const detailCols = kind === 'vouchers'
    ? ', vch_no, vch_type, party, amount_paise, vch_date'
    : ', name AS vch_no';

  const { rows: extra } = await query(
    `SELECT guid${detailCols} FROM ${kind}
      WHERE company_id = $1 AND NOT (guid = ANY($2::text[]))`,
    [companyId, guids]);

  let deleted = 0;
  if (complete && extra.length) {
    const { rowCount } = await query(
      `DELETE FROM ${kind} WHERE company_id = $1 AND NOT (guid = ANY($2::text[]))`,
      [companyId, guids]);
    deleted = rowCount;

    const ctxAsTally = { session: { org: { id: conn.orgId },
                                    user: { id: null, name: 'Tally', email: '' } } };

    await audit.record(ctxAsTally, 'sync.reconcile.delete', {
      companyId,
      entityName: `${deleted} ${kind.replace('_', ' ')} removed`,
      // Capped: a large reconcile should not put a megabyte of JSON in one row.
      before: { removed: extra.slice(0, 50).map(describeRemoved) },
      meta: { kind, deleted, listed: Math.min(extra.length, 50),
              via: 'connector', connectorId: conn.id },
    });

    /*
     * A deleted voucher gets its own entry as well as the summary above.
     *
     * The summary answers "what happened during that sync"; these answer "what
     * ever happened to invoice 142", which is the question actually asked, and
     * they are what /v1/audit/voucher/<guid> looks up. Only for vouchers, and
     * only for a handful, for the same flooding reason as everywhere else.
     */
    if (kind === 'vouchers' && extra.length <= 25) {
      for (const v of extra) {
        await audit.record(ctxAsTally, 'voucher.deleted', {
          companyId,
          entityId: v.guid,
          entityName: `${v.vch_type || 'Voucher'} #${v.vch_no || '?'}`,
          before: describeRemoved(v),
          meta: { via: 'connector', connectorId: conn.id },
        });
      }
    }
  }

  const { rows: mine } = await query(
    `SELECT count(*)::int AS n FROM ${kind} WHERE company_id = $1`, [companyId]);

  return {
    kind, inTally: guids.length, inMunim: mine[0].n,
    stale: extra.length,
    deleted,
    // Said explicitly so the connector, and anyone reading a log, knows why
    // nothing was removed.
    note: complete ? 'Reconciled.'
      : 'Counted only. A partial read never deletes, in case the list was truncated.',
  };
}

/** The connector collecting whatever the app asked it to do. */
async function takeCommands(conn) {
  const { rows } = await query(
    `UPDATE connector_commands SET taken_at = now()
      WHERE id IN (
        SELECT id FROM connector_commands
         WHERE connector_id = $1 AND taken_at IS NULL
         ORDER BY created_at LIMIT 10)
      RETURNING id, kind, args`,
    [conn.id]);
  return rows.map((r) => ({ id: String(r.id), kind: r.kind, args: r.args }));
}

/** The connector saying what came of one. */
async function reportCommand(ctx) {
  const conn = auth.requireConnector(ctx);
  const id = Number(ctx.body.id);
  if (!Number.isFinite(id)) throw new HttpError(400, 'BAD_ID', 'A command id is required.');

  await query(
    `UPDATE connector_commands
        SET done_at = now(), ok = $3, result = $4
      WHERE id = $1 AND connector_id = $2`,
    [id, conn.id, ctx.body.ok !== false, String(ctx.body.result || '').slice(0, 1000)]);
  return { recorded: true };
}

// --------------------------------------------------------------- for the apps

/** Recent runs, newest first, with the failures called out. */
async function history(ctx) {
  const s = auth.requireUser(ctx);
  const limit = Math.min(Math.max(
    parseInt(ctx.url.searchParams.get('limit') ?? '50', 10) || 50, 1), 200);
  const onlyFailed = ctx.url.searchParams.get('failed') === '1';

  const { rows } = await query(
    `SELECT r.*, c.name AS company_name
       FROM sync_runs r
       LEFT JOIN companies c ON c.id = r.company_id
      WHERE r.org_id = $1 ${onlyFailed ? 'AND NOT r.ok' : ''}
      ORDER BY r.started_at DESC LIMIT $2`,
    [s.org.id, limit]);

  const { rows: agg } = await query(
    `SELECT count(*)::int AS runs,
            count(*) FILTER (WHERE NOT ok)::int AS failures,
            COALESCE(sum(records), 0)::int AS records,
            COALESCE(round(avg(duration_ms)), 0)::int AS avg_ms,
            max(started_at) FILTER (WHERE ok) AS last_ok,
            max(started_at) FILTER (WHERE NOT ok) AS last_fail
       FROM sync_runs
      WHERE org_id = $1 AND started_at > now() - interval '7 days'`,
    [s.org.id]);

  const a = agg[0];
  return {
    runs: rows.map((r) => ({
      id: String(r.id),
      companyName: r.company_name,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      trigger: r.trigger,
      ok: r.ok,
      records: r.records,
      batches: r.batches,
      vouchers: r.vouchers,
      masters: r.masters,
      error: r.error,
      errorKind: r.error_kind,
    })),
    week: {
      runs: a.runs,
      failures: a.failures,
      records: a.records,
      avgMs: a.avg_ms,
      lastOkAt: a.last_ok,
      lastFailAt: a.last_fail,
      // A rate rather than a count: 3 failures out of 5 and 3 out of 5000 are
      // completely different situations.
      successPct: a.runs > 0 ? Math.round(((a.runs - a.failures) / a.runs) * 1000) / 10 : null,
    },
  };
}

/** Log lines that were uploaded. */
async function logs(ctx) {
  const s = auth.requireUser(ctx);
  const limit = Math.min(Math.max(
    parseInt(ctx.url.searchParams.get('limit') ?? '200', 10) || 200, 1), 1000);
  const level = ctx.url.searchParams.get('level');

  const { rows } = await query(
    `SELECT at, level, line FROM connector_logs
      WHERE org_id = $1 ${['warn', 'error'].includes(level) ? "AND level = $3" : ''}
      ORDER BY at DESC LIMIT $2`,
    ['warn', 'error'].includes(level) ? [s.org.id, limit, level] : [s.org.id, limit]);

  const { rows: pending } = await query(
    `SELECT count(*)::int AS n FROM connector_commands
      WHERE org_id = $1 AND kind = 'logs' AND done_at IS NULL`, [s.org.id]);

  return {
    lines: rows.map((r) => ({ at: r.at, level: r.level, line: r.line })),
    // So the screen can say "asked for, waiting" rather than looking empty.
    fetchPending: pending[0].n > 0,
  };
}

const KINDS = ['sync', 'reconcile', 'logs', 'outbox'];

/**
 * Ask the connector to do something on its next beat.
 *
 * Not a command that runs now, and the wording everywhere says so. A shop PC
 * has no port anybody can reach; this waits until the connector next checks in.
 */
async function request(ctx) {
  const s = auth.requireUser(ctx);
  const kind = String(ctx.body.kind || '');
  if (!KINDS.includes(kind)) {
    throw new HttpError(400, 'BAD_KIND', `kind must be one of ${KINDS.join(', ')}.`);
  }

  const { rows: conns } = await query(
    `SELECT id, last_seen_at FROM connectors
      WHERE org_id = $1 AND revoked_at IS NULL
      ORDER BY last_seen_at DESC NULLS LAST`, [s.org.id]);
  if (!conns.length) {
    throw new HttpError(409, 'NO_CONNECTOR',
      'No computer is linked yet. Install the connector on the PC that runs Tally.');
  }

  // Only one of each kind outstanding. Pressing "sync now" five times must not
  // queue five syncs the connector then runs one after another.
  const { rows } = await query(
    `INSERT INTO connector_commands (org_id, connector_id, kind, args, created_by)
     SELECT $1, $2, $3, $4::jsonb, $5
      WHERE NOT EXISTS (
        SELECT 1 FROM connector_commands
         WHERE connector_id = $2 AND kind = $3 AND done_at IS NULL)
     RETURNING id`,
    [s.org.id, conns[0].id, kind, JSON.stringify(ctx.body.args || {}), s.user.id]);

  const seen = conns[0].last_seen_at;
  const online = seen && (Date.now() - new Date(seen).getTime()) < 5 * 60_000;

  await audit.record(ctx, 'sync.request', { entityId: kind, entityName: kind });

  return {
    queued: rows.length > 0,
    alreadyQueued: rows.length === 0,
    connectorOnline: !!online,
    message: !online
      ? 'Saved. The computer running Tally is offline, so this will run as soon as it is back on.'
      : rows.length === 0
        ? 'Already asked for. It runs on the next check-in.'
        : 'Asked for. It runs within a few seconds.',
  };
}

/** How often to sync, and where Tally is. */
async function updateSettings(ctx) {
  const s = auth.requireUser(ctx);
  const b = ctx.body || {};
  const sets = [];
  const args = [s.org.id];

  if (b.intervalSeconds !== undefined) {
    const n = Number(b.intervalSeconds);
    if (!Number.isInteger(n) || n < 3 || n > 3600) {
      throw new HttpError(400, 'BAD_INTERVAL',
        'Sync interval must be between 3 seconds and 1 hour.');
    }
    sets.push(`sync_interval_seconds = $${args.push(n)}`);
  }

  if (b.tallyUrl !== undefined) {
    const url = String(b.tallyUrl || '').trim();
    // Only a local address: this is the URL of Tally on the shop's own PC, and
    // pointing it anywhere else is either a mistake or an attempt to make the
    // connector fetch something for someone.
    if (url && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/?$/i.test(url)) {
      throw new HttpError(400, 'BAD_TALLY_URL',
        'Tally runs on the same computer as the connector, so this must be '
        + 'http://localhost:9000 (or another port on localhost).');
    }
    sets.push(`tally_url = $${args.push(url)}`);
  }

  if (!sets.length) throw new HttpError(400, 'NOTHING_TO_DO', 'No settings were given.');

  await query(
    `UPDATE connectors SET ${sets.join(', ')} WHERE org_id = $1 AND revoked_at IS NULL`, args);
  await audit.record(ctx, 'sync.settings', { after: ctx.body });
  return { saved: true, note: 'Takes effect on the connector\'s next check-in.' };
}

module.exports = {
  reportRun, uploadLogs, reconcile, takeCommands, reportCommand,
  history, logs, request, updateSettings, classify,
};
