const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const dash = require('../src/routes/dashboard');

/**
 * The dashboard is the screen people make money decisions from, so the parts
 * worth testing hardest are the ones that decide WHICH figures they see: the
 * period arithmetic, and the guards against a nonsense number.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

const D = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);

// --- the financial year -----------------------------------------------------

test('the financial year runs April to March', () => {
  // Getting this wrong puts a quarter of the year in the wrong book, and every
  // accountant spots it immediately.
  const fy = dash.financialYear(D('2026-09-02'));
  assert.equal(iso(fy.from), '2026-04-01');
  assert.equal(iso(fy.to), '2027-03-31');
  assert.equal(fy.label, 'FY 2026-27');
});

test('a January date belongs to the year that began last April', () => {
  const fy = dash.financialYear(D('2026-01-15'));
  assert.equal(iso(fy.from), '2025-04-01');
  assert.equal(fy.label, 'FY 2025-26');
});

test('the 31st of March and the 1st of April are different years', () => {
  assert.equal(dash.financialYear(D('2026-03-31')).label, 'FY 2025-26');
  assert.equal(dash.financialYear(D('2026-04-01')).label, 'FY 2026-27');
});

// --- periods ----------------------------------------------------------------

const on = D('2026-09-02');   // a Wednesday

test('every period resolves against the books, not against today', () => {
  const cases = {
    today: ['2026-09-02', '2026-09-02'],
    yesterday: ['2026-09-01', '2026-09-01'],
    // Monday, not Sunday: an Indian shop's week is Monday to Saturday, and a
    // Sunday start splits the weekend across two weeks.
    week: ['2026-08-31', '2026-09-02'],
    month: ['2026-09-01', '2026-09-02'],
    'last-month': ['2026-08-01', '2026-08-31'],
    quarter: ['2026-07-01', '2026-09-02'],
    year: ['2026-01-01', '2026-09-02'],
  };
  for (const [key, [from, to]] of Object.entries(cases)) {
    const p = dash.resolvePeriod(key, on);
    assert.equal(iso(p.from), from, `${key} from`);
    assert.equal(iso(p.to), to, `${key} to`);
  }
});

test('last month is the whole month, not a rolling thirty days', () => {
  const p = dash.resolvePeriod('last-month', D('2026-03-15'));
  assert.equal(iso(p.from), '2026-02-01');
  assert.equal(iso(p.to), '2026-02-28', 'ends on the last day of February');
});

test('a custom range is honoured', () => {
  const p = dash.resolvePeriod('custom', on, '2026-06-01', '2026-06-30');
  assert.equal(iso(p.from), '2026-06-01');
  assert.equal(iso(p.to), '2026-06-30');
});

test('a malformed custom range falls back instead of failing', () => {
  // A dashboard that refuses to load because of a bad query string is worse
  // than one showing its default.
  for (const [f, t] of [['garbage', '2026-06-30'], ['2026-06-30', '2026-06-01'], [null, null]]) {
    const p = dash.resolvePeriod('custom', on, f, t);
    assert.ok(p.from instanceof Date);
    assert.match(p.label, /bad range/);
  }
});

test('an unknown period falls back to the financial year', () => {
  const p = dash.resolvePeriod('nonsense', on);
  assert.equal(iso(p.from), '2026-04-01');
});

// --- comparison periods -----------------------------------------------------

test('the previous period is the same length, ending the day before', () => {
  const p = dash.resolvePeriod('month', on);          // 1 Sep - 2 Sep, 2 days
  const prev = dash.previousOf(p);
  assert.equal(prev.days, 2);
  assert.equal(iso(prev.to), '2026-08-31');
  assert.equal(iso(prev.from), '2026-08-30');
});

test('a single day compares against the day before', () => {
  const prev = dash.previousOf(dash.resolvePeriod('today', on));
  assert.equal(prev.days, 1);
  assert.equal(iso(prev.from), '2026-09-01');
  assert.equal(iso(prev.to), '2026-09-01');
});

// --- the figures themselves -------------------------------------------------

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['dash-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `d-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Dash Co') RETURNING *`,
    [o[0].id, `g-${o[0].id}`]);

  const vch = (type, date, paise, party = 'A', extra = {}) => query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party,
                           amount_paise, is_cancelled, is_optional)
     VALUES ($1,$2,'1',$3,$4,$5,$6,$7,$8)`,
    [c[0].id, `v-${Math.random()}`, type, date, party, paise,
     extra.cancelled ?? false, extra.optional ?? false]);

  await vch('Sales', '2026-08-10', 100000, 'Alpha');
  await vch('Sales', '2026-08-20', 300000, 'Beta');
  await vch('Purchase', '2026-08-15', 50000, 'Supplier');
  // Struck out in Tally: kept as a record, must never count.
  await vch('Sales', '2026-08-25', 999999, 'Ghost', { cancelled: true });
  await vch('Sales', '2026-08-26', 888888, 'Ghost', { optional: true });

  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, qs = '') => ({
  session: {
    org: { id: f.orgId, name: 'Dash Co' },
    user: { id: f.userId, role: 'owner', roleId: null },
  },
  url: new URL(`http://x/${qs}`),
});

test('cancelled and optional vouchers never count', async () => {
  const f = await fixture();
  const d = await dash.overview(ctxFor(f, '?period=custom&from=2026-08-01&to=2026-08-31'),
    f.co.tally_guid);
  // Counting them would inflate sales with entries the business struck out.
  assert.equal(d.metrics.sales.paise, 400000);
  assert.equal(d.metrics.purchases.paise, 50000);
});

test('all eighteen metrics are present and numeric', async () => {
  const f = await fixture();
  const d = await dash.overview(ctxFor(f), f.co.tally_guid);
  const expected = [
    'sales', 'purchases', 'grossProfit', 'netProfit', 'receivables', 'payables',
    'cash', 'bank', 'expenses', 'stock', 'gstPayable', 'gstReceivable',
    'outstandingInvoices', 'overdueInvoices', 'todaySales', 'todayPurchases',
    'todayReceipts', 'todayPayments',
  ];
  assert.equal(Object.keys(d.metrics).length, 18);
  for (const k of expected) {
    assert.equal(typeof d.metrics[k].paise, 'number', `${k} is a number`);
  }
});

test('all twelve charts are present', async () => {
  const f = await fixture();
  const d = await dash.overview(ctxFor(f), f.co.tally_guid);
  const expected = [
    'salesTrend', 'purchaseTrend', 'profitTrend', 'expenseTrend',
    'receivableTrend', 'payableTrend', 'cashFlow', 'topCustomers',
    'topSuppliers', 'topProducts', 'salespeople', 'categories',
  ];
  assert.equal(Object.keys(d.charts).length, 12);
  for (const k of expected) assert.ok(Array.isArray(d.charts[k]), `${k} is a list`);
});

test('gross profit is sales less purchases, and says so', async () => {
  const f = await fixture();
  const d = await dash.overview(ctxFor(f, '?period=custom&from=2026-08-01&to=2026-08-31'),
    f.co.tally_guid);
  assert.equal(d.metrics.grossProfit.paise, 400000 - 50000);
  // Honest about what it is: without item-level cost this is trading margin.
  assert.match(d.metrics.grossProfit.note, /less purchases/i);
});

test('a period with no prior trade reports no percentage, not Infinity', async () => {
  const f = await fixture();
  const d = await dash.overview(ctxFor(f, '?period=custom&from=2026-08-01&to=2026-08-31'),
    f.co.tally_guid);
  // Nothing was sold in July, so the change from zero is undefined.
  assert.equal(d.metrics.sales.prev, 0);
  assert.equal(d.metrics.sales.changePct, null);
});

test('filtering to one party narrows every figure and chart together', async () => {
  const f = await fixture();
  const all = await dash.overview(
    ctxFor(f, '?period=custom&from=2026-08-01&to=2026-08-31'), f.co.tally_guid);
  const one = await dash.overview(
    ctxFor(f, '?period=custom&from=2026-08-01&to=2026-08-31&party=Alpha'), f.co.tally_guid);

  assert.equal(all.metrics.sales.paise, 400000);
  assert.equal(one.metrics.sales.paise, 100000);
  // The header total and the chart beneath it must never disagree.
  assert.equal(one.charts.topCustomers.length, 1);
  assert.equal(one.charts.topCustomers[0].label, 'Alpha');
});

test('the landscape carries two keys against one value', async () => {
  const f = await fixture();
  const d = await dash.overview(ctxFor(f), f.co.tally_guid);
  assert.ok(Array.isArray(d.landscape.cells));
  assert.ok(Array.isArray(d.landscape.months));
  assert.ok(Array.isArray(d.landscape.parties));
  for (const c of d.landscape.cells) {
    assert.ok(c.month && c.party && typeof c.value === 'number');
  }
});

test('the whole payload is scoped to the caller\'s own company', async () => {
  const a = await fixture();
  const b = await fixture();
  await assert.rejects(
    () => dash.overview(ctxFor(b), a.co.tally_guid), (e) => e.status === 404);
});

test('a party name with a quote in it cannot break the query', async () => {
  const f = await fixture();
  // Every filter arrives from a query string, so the only safe place for it is
  // a bound parameter.
  const d = await dash.overview(
    ctxFor(f, `?party=${encodeURIComponent("O'Brien'; DROP TABLE vouchers;--")}`),
    f.co.tally_guid);
  assert.equal(d.metrics.sales.paise, 0);
  const { rows } = await query('SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1',
    [f.co.id]);
  assert.equal(rows[0].n, 5, 'the table is still there');
});
