const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const ingest = require('../src/routes/ingest');

/**
 * Out-of-order batches must not corrupt the books.
 *
 * The offline outbox makes this reachable by design: a batch queued while the
 * shop's internet was down can arrive after a later batch that got through.
 * ALTERID is Tally's version number for a record, and it only counts upward,
 * so it is what decides which copy wins.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['order-test']);
  orgs.push(o[0].id);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,$3) RETURNING *`,
    [o[0].id, `g-${o[0].id}`, 'Order Co']);
  const { rows: k } = await query(
    `INSERT INTO connectors (org_id, machine_name, token_hash) VALUES ($1,'PC',$2) RETURNING id`,
    [o[0].id, `t-${o[0].id}`]);
  return { orgId: o[0].id, co: c[0], connId: k[0].id };
}

/** One batch, the way the connector sends it: newline-delimited JSON. */
const send = (f, records) => ingest.ingest({
  connector: { id: f.connId, orgId: f.orgId },
  req: { headers: {} },
  url: new URL('http://x/'),
  raw: Buffer.from(records.map((r) => JSON.stringify(r)).join('\n'), 'utf8'),
  body: {},
});

const voucher = (f, alterId, amountPaise, extra = {}) => ({
  kind: 'voucher', companyGuid: f.co.tally_guid, guid: 'v-1', alterId,
  data: {
    vchNo: '1', vchType: 'Sales', date: '2025-07-01', party: 'A',
    amountPaise, entries: [], items: [], bills: [], ...extra,
  },
});

test('a newer voucher replaces an older one', async () => {
  const f = await fixture();
  await send(f, [voucher(f, 10, 100)]);
  const r = await send(f, [voucher(f, 20, 999)]);
  assert.equal(r.accepted, 1);
  const { rows } = await query(
    'SELECT amount_paise, alter_id FROM vouchers WHERE company_id = $1', [f.co.id]);
  assert.equal(Number(rows[0].amount_paise), 999);
  assert.equal(Number(rows[0].alter_id), 20);
});

test('a REPLAYED older voucher does not overwrite the newer one', async () => {
  const f = await fixture();
  await send(f, [voucher(f, 20, 999)]);
  // The Monday batch, stuck in the outbox, finally gets through on Tuesday.
  const r = await send(f, [voucher(f, 10, 100)]);

  assert.equal(r.stale, 1, 'reported as stale');
  assert.equal(r.accepted, 0);
  const { rows } = await query(
    'SELECT amount_paise, alter_id FROM vouchers WHERE company_id = $1', [f.co.id]);
  assert.equal(Number(rows[0].amount_paise), 999, 'Tuesday survived');
  assert.equal(Number(rows[0].alter_id), 20);
});

test('a stale voucher does not drag its children back either', async () => {
  const f = await fixture();
  await send(f, [voucher(f, 20, 999, {
    entries: [{ ledger: 'Sales', amountPaise: 999 }],
    items: [{ item: 'New item', qty: 2, ratePaise: 500, amountPaise: 999 }],
  })]);
  await send(f, [voucher(f, 10, 100, {
    entries: [{ ledger: 'Sales', amountPaise: 100 }],
    items: [{ item: 'Old item', qty: 1, ratePaise: 100, amountPaise: 100 }],
  })]);

  // Children are replaced wholesale, so an unguarded skip would have deleted
  // Tuesday's lines and reinserted Monday's under Tuesday's voucher - worse
  // than either version on its own.
  const { rows } = await query(
    `SELECT vi.item_name FROM voucher_items vi
       JOIN vouchers v ON v.id = vi.voucher_id WHERE v.company_id = $1`, [f.co.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item_name, 'New item');
});

test('the same version arriving twice still applies, so a retry is safe', async () => {
  const f = await fixture();
  await send(f, [voucher(f, 20, 999)]);
  const r = await send(f, [voucher(f, 20, 999)]);
  // Equal, not strictly greater: a connector retrying a batch it is unsure
  // landed must not be silently ignored.
  assert.equal(r.accepted, 1);
  assert.equal(r.stale, 0);
});

test('records with no ALTERID at all still sync', async () => {
  const f = await fixture();
  await send(f, [voucher(f, 0, 100)]);
  const r = await send(f, [voucher(f, 0, 250)]);
  // Some Tally versions report no ALTERID. 0 >= 0 keeps them working rather
  // than freezing them at their first value.
  assert.equal(r.accepted, 1);
  const { rows } = await query(
    'SELECT amount_paise FROM vouchers WHERE company_id = $1', [f.co.id]);
  assert.equal(Number(rows[0].amount_paise), 250);
});

test('the guard protects ledgers too', async () => {
  const f = await fixture();
  const ledger = (alterId, closingPaise) => ({
    kind: 'ledger', companyGuid: f.co.tally_guid, guid: 'l-1', alterId,
    data: { name: 'Acme', parentGroup: 'Sundry Debtors', closingPaise },
  });
  await send(f, [ledger(20, 5000)]);
  await send(f, [ledger(10, 100)]);
  const { rows } = await query(
    'SELECT closing_paise FROM ledgers WHERE company_id = $1', [f.co.id]);
  assert.equal(Number(rows[0].closing_paise), 5000);
});

test('the guard protects stock items too', async () => {
  const f = await fixture();
  const item = (alterId, qty) => ({
    kind: 'stockItem', companyGuid: f.co.tally_guid, guid: 'i-1', alterId,
    data: { name: 'Widget', unit: 'Nos', closingQty: qty, closingValuePaise: qty * 100 },
  });
  await send(f, [item(20, 50)]);
  await send(f, [item(10, 5)]);
  const { rows } = await query(
    'SELECT closing_qty FROM stock_items WHERE company_id = $1', [f.co.id]);
  assert.equal(Number(rows[0].closing_qty), 50);
});

test('one stale record does not stop the good ones in the same batch', async () => {
  const f = await fixture();
  await send(f, [voucher(f, 20, 999)]);
  const r = await send(f, [
    voucher(f, 10, 100),
    { kind: 'voucher', companyGuid: f.co.tally_guid, guid: 'v-2', alterId: 30,
      data: { vchNo: '2', vchType: 'Sales', date: '2025-07-02', party: 'B',
              amountPaise: 777, entries: [], items: [], bills: [] } },
  ]);
  assert.equal(r.stale, 1);
  assert.equal(r.accepted, 1);
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1', [f.co.id]);
  assert.equal(rows[0].n, 2);
});

/*
 * The audit trail for changes made in Tally.
 *
 * These go through the real ingest path, because the interesting half is the
 * SQL: the CTE has to hand back what the row looked like BEFORE the upsert
 * overwrote it, and that is not something a unit test of the judgement can
 * check.
 */

test('a voucher edited in Tally is recorded, with both amounts', async () => {
  const f = await fixture();
  await send(f, [voucher(f, 10, 480000)]);
  await send(f, [voucher(f, 20, 120000)]);

  const { rows } = await query(
    `SELECT action, entity_name, actor_name, user_id, before_val, after_val
       FROM audit_log WHERE org_id = $1 AND action = 'voucher.changed'`, [f.orgId]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_name, 'Sales #1');
  assert.equal(Number(rows[0].before_val.amountPaise), 480000);
  assert.equal(Number(rows[0].after_val.amountPaise), 120000);
  // Nobody in Munim did this, so it is not pinned on whoever owns the account.
  assert.equal(rows[0].actor_name, 'Tally');
  assert.equal(rows[0].user_id, null);
});

test('the first arrival of a voucher is not reported as a change', async () => {
  // It is already on screen as itself. Only an edit to something already held
  // is news.
  const f = await fixture();
  await send(f, [voucher(f, 10, 480000)]);
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE org_id = $1 AND action = 'voucher.changed'`, [f.orgId]);
  assert.equal(rows[0].n, 0);
});

test('a materially back-dated first arrival IS reported', async () => {
  // The fixture voucher is dated well over a month ago, which is the one kind
  // of new entry worth telling somebody about.
  const f = await fixture();
  await send(f, [voucher(f, 10, 480000)]);
  const { rows } = await query(
    `SELECT entity_name, after_val, meta FROM audit_log
      WHERE org_id = $1 AND action = 'voucher.backdated'`, [f.orgId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity_name, 'Sales #1');
  assert.ok(rows[0].meta.daysBack > 30);
});

test('a voucher re-sent unchanged writes nothing', async () => {
  const f = await fixture();
  await send(f, [voucher(f, 10, 480000)]);
  await send(f, [voucher(f, 11, 480000)]);   // ALTERID moved, the data did not
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE org_id = $1 AND action = 'voucher.changed'`, [f.orgId]);
  assert.equal(rows[0].n, 0);
});

test('a stale replay is not recorded as a change', async () => {
  // It did not change anything - the guard rejected it - so recording it would
  // be reporting an edit that never happened.
  const f = await fixture();
  await send(f, [voucher(f, 20, 480000)]);
  await send(f, [voucher(f, 10, 999999)]);
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE org_id = $1 AND action = 'voucher.changed'`, [f.orgId]);
  assert.equal(rows[0].n, 0);
});

test('a bulk replay does not flood the log', async () => {
  // A re-link or a restore replays the whole book. Twenty-six changed vouchers
  // in one batch is not a story anybody reads; it is noise that hides one.
  const f = await fixture();
  const many = (alterId, amt) => Array.from({ length: 30 }, (_, i) => ({
    kind: 'voucher', companyGuid: f.co.tally_guid, guid: `bulk-${i}`, alterId,
    data: { vchNo: String(i), vchType: 'Sales', date: '2025-07-01', party: 'A',
            amountPaise: amt, entries: [], items: [], bills: [] },
  }));
  await send(f, many(10, 100));
  await send(f, many(20, 200));

  const { rows } = await query(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE org_id = $1 AND action = 'voucher.changed'`, [f.orgId]);
  assert.equal(rows[0].n, 0);
});
