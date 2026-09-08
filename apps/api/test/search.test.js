const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const search = require('../src/routes/search');

/**
 * One box that finds anything.
 *
 * Two things decide whether a search is used: whether the obvious answer is at
 * the top, and whether it ever shows somebody something they should not see.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['sr-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `sr-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Sr Co') RETURNING *`,
    [o[0].id, `sr-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ownerCtx = (f, qs) => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  url: new URL(`http://x/?${qs}`), body: {},
});
const asRole = (f, permissions, qs) => ({
  session: {
    org: { id: f.orgId },
    user: { id: f.userId, role: 'member', roleId: 'r', permissions },
  },
  url: new URL(`http://x/?${qs}`), body: {},
});

const party = (f, name, group, closing = 0, extra = {}) => query(
  `INSERT INTO ledgers (company_id, guid, name, parent_group, closing_paise, gstin, phone)
   VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [f.co.id, `l-${name}`, name, group, closing, extra.gstin ?? '', extra.phone ?? '']);

const voucher = (f, { no, type, partyName, amount, date = '2026-05-01', narration = '' }) => query(
  `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party,
                         amount_paise, narration)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
  [f.co.id, `v-${no}-${type}`, no, type, date, partyName, amount, narration]);

// --- amount parsing ---------------------------------------------------------

test('an amount filter understands how people type money', () => {
  assert.deepEqual(search.amountFilter('5000'), { op: '>=', paise: 500000 });
  assert.deepEqual(search.amountFilter('>10000'), { op: '>', paise: 1000000 });
  assert.deepEqual(search.amountFilter('<= 500'), { op: '<=', paise: 50000 });
  // Indian grouping, which is how it appears everywhere else in the product.
  assert.deepEqual(search.amountFilter('1,50,000'), { op: '>=', paise: 15000000 });
});

test('anything that is not an amount is refused, not guessed at', () => {
  for (const bad of ['rubbish', '', "5000'; DROP TABLE vouchers;--", '=1+1']) {
    assert.equal(search.amountFilter(bad), null, JSON.stringify(bad));
  }
});

// --- ranking ----------------------------------------------------------------

test('an exact match beats a partial one', async () => {
  const f = await fixture();
  await party(f, 'Tiles', 'Sundry Debtors', 1000);
  await party(f, 'Royal Tiles Emporium', 'Sundry Debtors', 900000);

  const r = await search.find(ownerCtx(f, 'q=Tiles'), f.co.tally_guid);
  const customers = r.groups.find((g) => g.kind === 'customer');
  // Even though the other party has a far bigger balance: somebody typing an
  // exact name expects that name.
  assert.equal(customers.results[0].title, 'Tiles');
});

test('a prefix match beats a match in the middle', async () => {
  const f = await fixture();
  await party(f, 'Zenith Cement', 'Sundry Debtors', 5000);
  await party(f, 'Cement Corner', 'Sundry Debtors', 5000);

  const r = await search.find(ownerCtx(f, 'q=Cement'), f.co.tally_guid);
  const customers = r.groups.find((g) => g.kind === 'customer');
  assert.equal(customers.results[0].title, 'Cement Corner');
});

// --- what can be found ------------------------------------------------------

test('a party is found by name, GSTIN or phone', async () => {
  const f = await fixture();
  await party(f, 'Acme Traders', 'Sundry Debtors', 5000,
    { gstin: '33AAPFU0939F1ZV', phone: '9876543210' });

  for (const term of ['acme', '33AAPFU', '98765']) {
    const r = await search.find(ownerCtx(f, `q=${term}`), f.co.tally_guid);
    assert.equal(r.total, 1, `searching ${term}`);
  }
});

test('customers, suppliers and other ledgers are told apart', async () => {
  const f = await fixture();
  await party(f, 'Buyer Ltd', 'Sundry Debtors', 5000);
  await party(f, 'Seller Ltd', 'Sundry Creditors', -3000);
  await party(f, 'Rent Ltd', 'Indirect Expenses', 100);

  const r = await search.find(ownerCtx(f, 'q=Ltd'), f.co.tally_guid);
  const kinds = r.groups.map((g) => g.kind);
  assert.ok(kinds.includes('customer'));
  assert.ok(kinds.includes('supplier'));
  assert.ok(kinds.includes('ledger'));
});

test('a voucher is found by number, party, type or narration', async () => {
  const f = await fixture();
  await voucher(f, { no: 'INV-77', type: 'Sales', partyName: 'Acme',
    amount: 5000, narration: 'urgent delivery' });

  for (const term of ['INV-77', 'Acme', 'urgent']) {
    const r = await search.find(ownerCtx(f, `q=${encodeURIComponent(term)}`), f.co.tally_guid);
    assert.ok(r.total >= 1, `searching ${term}`);
  }
});

test('orders are searched apart from sales', async () => {
  const f = await fixture();
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Acme', amount: 5000 });
  await voucher(f, { no: 'O1', type: 'Sales Order', partyName: 'Acme', amount: 90000 });

  const r = await search.find(ownerCtx(f, 'q=Acme'), f.co.tally_guid);
  const kinds = r.groups.map((g) => g.kind);
  // A commitment is not a sale, here as everywhere else.
  assert.ok(kinds.includes('invoice'));
  assert.ok(kinds.includes('order'));
});

// --- filters ----------------------------------------------------------------

test('filters work with no search term at all', async () => {
  const f = await fixture();
  await voucher(f, { no: '1', type: 'Sales', partyName: 'A', amount: 100, date: '2026-05-01' });
  await voucher(f, { no: '2', type: 'Sales', partyName: 'A', amount: 100, date: '2026-08-01' });

  const r = await search.find(
    ownerCtx(f, 'kind=invoice&from=2026-04-01&to=2026-05-31'), f.co.tally_guid);
  assert.equal(r.total, 1);
});

test('an amount filter narrows the results', async () => {
  const f = await fixture();
  await voucher(f, { no: '1', type: 'Sales', partyName: 'Acme', amount: 10000 });
  await voucher(f, { no: '2', type: 'Sales', partyName: 'Acme', amount: 900000 });

  const big = await search.find(
    ownerCtx(f, 'q=Acme&kind=invoice&amount=>5000'), f.co.tally_guid);
  assert.equal(big.total, 1);
  assert.equal(big.groups[0].results[0].amountPaise, 900000);
});

test('a voucher type filter narrows to that type', async () => {
  const f = await fixture();
  await voucher(f, { no: '1', type: 'Sales', partyName: 'Acme', amount: 100 });
  await voucher(f, { no: '2', type: 'GST Sales', partyName: 'Acme', amount: 100 });

  const r = await search.find(
    ownerCtx(f, 'q=Acme&kind=invoice&type=GST'), f.co.tally_guid);
  assert.equal(r.total, 1);
});

test('a term too short says so rather than returning everything', async () => {
  const f = await fixture();
  await party(f, 'Acme', 'Sundry Debtors', 100);
  const r = await search.find(ownerCtx(f, 'q=a'), f.co.tally_guid);
  assert.equal(r.total, 0);
  assert.match(r.hint, /two letters/);
});

test('nothing found says so, scoped to what the person can see', async () => {
  const f = await fixture();
  const r = await search.find(ownerCtx(f, 'q=nothinghere'), f.co.tally_guid);
  assert.match(r.hint, /Nothing matches.*what you can see/);
});

// --- permission ---------------------------------------------------------------

test('search never returns something the person cannot open', async () => {
  const f = await fixture();
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Acme', amount: 5000 });
  await voucher(f, { no: 'P1', type: 'Purchase', partyName: 'Acme', amount: 3000 });
  await query(
    `INSERT INTO stock_items (company_id, guid, name, unit, closing_qty)
     VALUES ($1,'i1','Acme Cement','Bag',5)`, [f.co.id]);

  // A salesperson who cannot open purchases must not learn what the shop pays.
  const sales = await search.find(asRole(f, { sales: ['read'] }, 'q=Acme'), f.co.tally_guid);
  const kinds = sales.groups.map((g) => g.kind);
  assert.ok(kinds.includes('invoice'));
  assert.ok(!kinds.includes('purchase'));
  assert.ok(!kinds.includes('item'));
});

test('somebody who can see nothing gets nothing, not an error', async () => {
  const f = await fixture();
  await party(f, 'Acme', 'Sundry Debtors', 100);
  const r = await search.find(asRole(f, {}, 'q=Acme'), f.co.tally_guid);
  assert.equal(r.total, 0);
});

test('search cannot reach another business', async () => {
  const a = await fixture();
  const b = await fixture();
  await party(a, 'Theirs', 'Sundry Debtors', 5000);

  await assert.rejects(
    () => search.find(ownerCtx(b, 'q=Theirs'), a.co.tally_guid), (e) => e.status === 404);
  const mine = await search.find(ownerCtx(b, 'q=Theirs'), b.co.tally_guid);
  assert.equal(mine.total, 0);
});

test('a search term full of SQL is just a search term', async () => {
  const f = await fixture();
  await party(f, 'Acme', 'Sundry Debtors', 100);
  const nasty = "'; DROP TABLE vouchers; --";
  const r = await search.find(
    ownerCtx(f, `q=${encodeURIComponent(nasty)}&party=${encodeURIComponent(nasty)}`),
    f.co.tally_guid);
  assert.equal(r.total, 0);

  const { rows } = await query('SELECT count(*)::int AS n FROM ledgers WHERE company_id = $1',
    [f.co.id]);
  assert.equal(rows[0].n, 1, 'the tables are still there');
});

test('the filter options come from the books, not a fixed list', async () => {
  const f = await fixture();
  await voucher(f, { no: '1', type: 'Counter Sale', partyName: 'A', amount: 100 });
  const o = await search.options(ownerCtx(f, ''), f.co.tally_guid);
  // A shop with its own voucher type should be able to filter by it.
  assert.ok(o.voucherTypes.includes('Counter Sale'));
  assert.ok(o.kinds.length > 5);
});
