const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const sync = require('../src/routes/sync');

/**
 * The connector is the one component running on somebody else's computer,
 * behind their router. Its failures make every figure in the product silently
 * wrong, so what it reports - and what we do with a partial report - is worth
 * testing hard.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['sync-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `s-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,$3) RETURNING *`,
    [o[0].id, `g-${o[0].id}`, 'Sync Co']);
  const { rows: k } = await query(
    `INSERT INTO connectors (org_id, machine_name, token_hash, last_seen_at)
     VALUES ($1,'SHOP-PC',$2, now()) RETURNING id`,
    [o[0].id, `tok-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0], connId: k[0].id };
}

const connCtx = (f, body = {}) => ({
  connector: { id: f.connId, orgId: f.orgId },
  url: new URL('http://x/'),
  body,
});
const userCtx = (f, qs = '', body = {}) => ({
  session: { org: { id: f.orgId, name: 'Sync Co' }, user: { id: f.userId, role: 'owner' } },
  url: new URL(`http://x/${qs}`),
  body,
});

test('failures are classified by what the shop must do about them', () => {
  assert.equal(sync.classify('The operation has timed out'), 'network');
  assert.equal(sync.classify('Unable to connect to the remote server'), 'network');
  assert.equal(sync.classify('401 Unauthorized - token revoked'), 'auth');
  assert.equal(sync.classify('Could not reach Tally on port 9000'), 'tally');
  assert.equal(sync.classify('something odd'), 'other');
  assert.equal(sync.classify(''), '', 'a success has no kind');
});

test('a successful run is recorded against its company', async () => {
  const f = await fixture();
  await sync.reportRun(connCtx(f, {
    tallyGuid: f.co.tally_guid, ok: true, records: 12, durationMs: 900, trigger: 'manual',
  }));
  const h = await sync.history(userCtx(f));
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].records, 12);
  assert.equal(h.runs[0].trigger, 'manual');
  assert.equal(h.runs[0].companyName, 'Sync Co');
});

test('a quiet pass is still a successful run', async () => {
  const f = await fixture();
  await sync.reportRun(connCtx(f, { tallyGuid: f.co.tally_guid, ok: true, records: 0 }));
  const h = await sync.history(userCtx(f));
  // Without this a shop that is simply quiet looks identical to a broken one.
  assert.equal(h.runs[0].ok, true);
  assert.equal(h.week.failures, 0);
});

test('a failure keeps the error verbatim and files it by kind', async () => {
  const f = await fixture();
  await sync.reportRun(connCtx(f, {
    ok: false, error: 'The operation has timed out', durationMs: 30000 }));
  const h = await sync.history(userCtx(f));
  // Rewording a Tally or network error destroys the one string that identifies
  // the fault.
  assert.equal(h.runs[0].error, 'The operation has timed out');
  assert.equal(h.runs[0].errorKind, 'network');
  assert.equal(h.week.failures, 1);
});

test('the week summary reports a rate, not just a count', async () => {
  const f = await fixture();
  for (let i = 0; i < 9; i++) {
    await sync.reportRun(connCtx(f, { tallyGuid: f.co.tally_guid, ok: true, records: 1 }));
  }
  await sync.reportRun(connCtx(f, { ok: false, error: 'boom' }));
  const h = await sync.history(userCtx(f));
  // 3 failures out of 5 and 3 out of 5000 are completely different situations.
  assert.equal(h.week.runs, 10);
  assert.equal(h.week.failures, 1);
  assert.equal(h.week.successPct, 90);
});

test('history can be narrowed to failures', async () => {
  const f = await fixture();
  await sync.reportRun(connCtx(f, { tallyGuid: f.co.tally_guid, ok: true }));
  await sync.reportRun(connCtx(f, { ok: false, error: 'nope' }));
  const all = await sync.history(userCtx(f));
  const bad = await sync.history(userCtx(f, '?failed=1'));
  assert.equal(all.runs.length, 2);
  assert.equal(bad.runs.length, 1);
  assert.equal(bad.runs[0].ok, false);
});

test('an unknown trigger is stored as auto rather than rejected', async () => {
  const f = await fixture();
  // The connector must never fail a sync because a diagnostic field was odd.
  await sync.reportRun(connCtx(f, { tallyGuid: f.co.tally_guid, ok: true, trigger: 'nonsense' }));
  const h = await sync.history(userCtx(f));
  assert.equal(h.runs[0].trigger, 'auto');
});

// --- reconciliation --------------------------------------------------------

async function withVouchers(f, guids) {
  for (const g of guids) {
    await query(
      `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
       VALUES ($1,$2,'1','Sales','2025-07-01','A',100)`, [f.co.id, g]);
  }
}

test('a complete reconcile removes what Tally no longer has', async () => {
  const f = await fixture();
  await withVouchers(f, ['a', 'b', 'c']);
  // Tally now only reports a and b: c was deleted there.
  const r = await sync.reconcile(connCtx(f, {
    tallyGuid: f.co.tally_guid, kind: 'voucher', guids: ['a', 'b'], complete: true }));

  assert.equal(r.stale, 1);
  assert.equal(r.deleted, 1);
  assert.equal(r.inMunim, 2);
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1', [f.co.id]);
  assert.equal(rows[0].n, 2);
});

test('a PARTIAL reconcile never deletes, however many records look stale', async () => {
  const f = await fixture();
  await withVouchers(f, ['a', 'b', 'c']);
  // The connector could only read part of Tally. Acting on that list would
  // destroy real records because somebody's internet hiccuped.
  const r = await sync.reconcile(connCtx(f, {
    tallyGuid: f.co.tally_guid, kind: 'voucher', guids: ['a'], complete: false }));

  assert.equal(r.stale, 2, 'it still reports the discrepancy');
  assert.equal(r.deleted, 0, 'but deletes nothing');
  assert.match(r.note, /partial/i, 'and says why');
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1', [f.co.id]);
  assert.equal(rows[0].n, 3, 'every voucher survived');
});

test('an empty complete reconcile is treated as a real answer', async () => {
  const f = await fixture();
  await withVouchers(f, ['a']);
  // A book genuinely emptied in Tally. complete=true is the connector
  // asserting it read everything and there was nothing.
  const r = await sync.reconcile(connCtx(f, {
    tallyGuid: f.co.tally_guid, kind: 'voucher', guids: [], complete: true }));
  assert.equal(r.deleted, 1);
});

test('a deletion is written to the audit log', async () => {
  const f = await fixture();
  await withVouchers(f, ['a', 'b']);
  await sync.reconcile(connCtx(f, {
    tallyGuid: f.co.tally_guid, kind: 'voucher', guids: ['a'], complete: true }));
  const { rows } = await query(
    `SELECT action, meta FROM audit_log WHERE org_id = $1 AND action = 'sync.reconcile.delete'`,
    [f.orgId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meta.deleted, 1);
});

test('the log says WHICH voucher vanished, not just how many', async () => {
  /*
   * "37 vouchers were removed" is not an audit trail. When a receivable
   * disappears the question is which invoice, whose account, how much - and
   * that detail only exists before the delete runs.
   */
  const f = await fixture();
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'gone','142','Sales','2025-07-01','Ravi Traders',480000)`, [f.co.id]);
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'kept','143','Sales','2025-07-01','Ravi Traders',100)`, [f.co.id]);

  await sync.reconcile(connCtx(f, {
    tallyGuid: f.co.tally_guid, kind: 'voucher', guids: ['kept'], complete: true }));

  const { rows } = await query(
    `SELECT entity_name, before_val, actor_name, user_id FROM audit_log
      WHERE org_id = $1 AND action = 'voucher.deleted'`, [f.orgId]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_name, 'Sales #142');
  assert.equal(rows[0].before_val.party, 'Ravi Traders');
  assert.equal(Number(rows[0].before_val.amountPaise), 480000);
  assert.equal(rows[0].before_val.date, '2025-07-01');
  // Tally did this, not the account owner.
  assert.equal(rows[0].actor_name, 'Tally');
  assert.equal(rows[0].user_id, null);
});

test('the summary entry lists what was removed', async () => {
  const f = await fixture();
  await withVouchers(f, ['a', 'b']);
  await sync.reconcile(connCtx(f, {
    tallyGuid: f.co.tally_guid, kind: 'voucher', guids: [], complete: true }));
  const { rows } = await query(
    `SELECT entity_name, before_val FROM audit_log
      WHERE org_id = $1 AND action = 'sync.reconcile.delete'`, [f.orgId]);
  assert.equal(rows[0].before_val.removed.length, 2);
  assert.match(rows[0].entity_name, /2 vouchers removed/);
});

test('a mass deletion does not write one entry per voucher', async () => {
  // A book emptied wholesale is one event, not a thousand.
  const f = await fixture();
  await withVouchers(f, Array.from({ length: 30 }, (_, i) => `m${i}`));
  await sync.reconcile(connCtx(f, {
    tallyGuid: f.co.tally_guid, kind: 'voucher', guids: [], complete: true }));

  const { rows } = await query(
    `SELECT action, count(*)::int AS n FROM audit_log
      WHERE org_id = $1 GROUP BY action`, [f.orgId]);
  const byAction = Object.fromEntries(rows.map((r) => [r.action, r.n]));
  assert.equal(byAction['voucher.deleted'], undefined, 'no per-voucher flood');
  assert.equal(byAction['sync.reconcile.delete'], 1, 'but the event is still recorded');
});

test('deleting a ledger is recorded without pretending it has an amount', async () => {
  const f = await fixture();
  await query(
    `INSERT INTO ledgers (company_id, guid, name) VALUES ($1,'lg','Old Supplier')`, [f.co.id]);
  await sync.reconcile(connCtx(f, {
    tallyGuid: f.co.tally_guid, kind: 'ledger', guids: [], complete: true }));
  const { rows } = await query(
    `SELECT before_val FROM audit_log
      WHERE org_id = $1 AND action = 'sync.reconcile.delete'`, [f.orgId]);
  assert.equal(rows[0].before_val.removed[0].name, 'Old Supplier');
  assert.equal(rows[0].before_val.removed[0].amountPaise, undefined);
});

test('reconcile refuses an unknown record kind', async () => {
  const f = await fixture();
  await assert.rejects(
    () => sync.reconcile(connCtx(f, {
      tallyGuid: f.co.tally_guid, kind: 'wibble', guids: [], complete: true })),
    (e) => e.status === 400);
});

test('reconcile cannot touch another org\'s company', async () => {
  const a = await fixture();
  const b = await fixture();
  await withVouchers(a, ['x']);
  await assert.rejects(
    () => sync.reconcile(connCtx(b, {
      tallyGuid: a.co.tally_guid, kind: 'voucher', guids: [], complete: true })),
    (e) => e.status === 404);
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1', [a.co.id]);
  assert.equal(rows[0].n, 1, 'the other org\'s voucher survived');
});

// --- commands --------------------------------------------------------------

test('asking for a sync queues one for the connector to collect', async () => {
  const f = await fixture();
  const r = await sync.request(userCtx(f, '', { kind: 'sync' }));
  assert.equal(r.queued, true);
  assert.equal(r.connectorOnline, true);

  const taken = await sync.takeCommands({ id: f.connId });
  assert.equal(taken.length, 1);
  assert.equal(taken[0].kind, 'sync');
});

test('pressing sync twice does not queue two syncs', async () => {
  const f = await fixture();
  await sync.request(userCtx(f, '', { kind: 'sync' }));
  const second = await sync.request(userCtx(f, '', { kind: 'sync' }));
  assert.equal(second.queued, false);
  assert.equal(second.alreadyQueued, true);
  assert.match(second.message, /already/i);
});

test('with the connector offline, the wording promises later, not now', async () => {
  const f = await fixture();
  await query(
    `UPDATE connectors SET last_seen_at = now() - interval '2 hours' WHERE id = $1`, [f.connId]);
  const r = await sync.request(userCtx(f, '', { kind: 'sync' }));
  assert.equal(r.queued, true);
  assert.equal(r.connectorOnline, false);
  // A shop PC has no reachable port. Promising "now" would be a lie.
  assert.match(r.message, /offline|as soon as/i);
});

test('with no connector at all, the error says what to install', async () => {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['bare']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `bare-${o[0].id.slice(0, 8)}@example.com`]);
  await assert.rejects(
    () => sync.request({
      session: { org: { id: o[0].id }, user: { id: u[0].id } },
      url: new URL('http://x/'), body: { kind: 'sync' } }),
    (e) => e.status === 409 && /connector/i.test(e.message));
});

test('an unknown command kind is refused', async () => {
  const f = await fixture();
  await assert.rejects(
    () => sync.request(userCtx(f, '', { kind: 'rm -rf' })),
    (e) => e.status === 400);
});

test('a taken command is not handed out twice', async () => {
  const f = await fixture();
  await sync.request(userCtx(f, '', { kind: 'reconcile' }));
  const first = await sync.takeCommands({ id: f.connId });
  const second = await sync.takeCommands({ id: f.connId });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
});

test('the connector reports what came of a command', async () => {
  const f = await fixture();
  await sync.request(userCtx(f, '', { kind: 'logs' }));
  const [cmd] = await sync.takeCommands({ id: f.connId });
  await sync.reportCommand(connCtx(f, { id: cmd.id, ok: true, result: 'sent 42 line(s)' }));
  const { rows } = await query(
    'SELECT ok, result, done_at FROM connector_commands WHERE id = $1', [cmd.id]);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].result, 'sent 42 line(s)');
  assert.ok(rows[0].done_at);
});

// --- logs and settings -----------------------------------------------------

test('uploaded log lines come back newest first, and can be filtered', async () => {
  const f = await fixture();
  await sync.uploadLogs(connCtx(f, { lines: [
    { level: 'info', line: 'watch started' },
    { level: 'error', line: 'could not reach Tally' },
  ] }));
  const all = await sync.logs(userCtx(f));
  const errs = await sync.logs(userCtx(f, '?level=error'));
  assert.equal(all.lines.length, 2);
  assert.equal(errs.lines.length, 1);
  assert.equal(errs.lines[0].line, 'could not reach Tally');
});

test('the sync interval is bounded', async () => {
  const f = await fixture();
  await sync.updateSettings(userCtx(f, '', { intervalSeconds: 60 }));
  const { rows } = await query(
    'SELECT sync_interval_seconds FROM connectors WHERE id = $1', [f.connId]);
  assert.equal(rows[0].sync_interval_seconds, 60);

  for (const bad of [0, 2, 4000, 1.5]) {
    await assert.rejects(
      () => sync.updateSettings(userCtx(f, '', { intervalSeconds: bad })),
      (e) => e.status === 400, `interval ${bad} should be refused`);
  }
});

test('Tally\'s address may only ever be on the connector\'s own machine', async () => {
  const f = await fixture();
  await sync.updateSettings(userCtx(f, '', { tallyUrl: 'http://localhost:9001' }));

  // Anything else is either a mistake or an attempt to make the connector
  // fetch something on someone's behalf.
  for (const bad of ['http://192.168.1.5:9000', 'http://evil.example.com',
                     'http://169.254.169.254/latest/meta-data']) {
    await assert.rejects(
      () => sync.updateSettings(userCtx(f, '', { tallyUrl: bad })),
      (e) => e.status === 400, `${bad} should be refused`);
  }
});
