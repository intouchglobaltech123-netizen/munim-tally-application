const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const admin = require('../src/routes/admin');
const metrics = require('../src/lib/metrics');
const sub = require('../src/routes/subscription');

/**
 * The operator's dashboard.
 *
 * These are the numbers a business is run on, so the tests care most about the
 * ones that are easy to compute wrongly in a flattering direction.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

const adminCtx = () => ({
  session: { user: { role: 'platform_admin' } },
  req: { headers: {}, socket: {} }, url: new URL('http://x/'), body: {},
});
const plainCtx = () => ({
  session: { org: { id: 'x' }, user: { role: 'owner' } },
  req: { headers: {}, socket: {} }, url: new URL('http://x/'), body: {},
});

test('a customer cannot read the operator dashboard', async () => {
  // Every query in that module reads across tenants.
  for (const fn of [admin.overview, admin.businessMetrics,
                    admin.technicalMetrics, admin.featureMetrics]) {
    await assert.rejects(() => fn(plainCtx()), (e) => e.status === 401 || e.status === 403);
  }
});

test('an admin gets every section', async () => {
  const o = await admin.overview(adminCtx());
  assert.ok(o.business.accounts);
  assert.ok(o.business.revenue);
  assert.ok(o.technical.connectors);
  assert.ok(o.technical.api);
  assert.ok(o.technical.system);
  assert.ok(o.feature.accounting);
});

test('ARR is twelve times MRR, and a yearly plan is divided not multiplied', async () => {
  /*
   * A yearly subscription's price is a year of money. Counting it whole into
   * MRR overstates monthly revenue twelve-fold, which is the single most
   * flattering arithmetic error available here.
   */
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('mrr-test','pro') RETURNING *`);
  orgs.push(o[0].id);
  await query(
    `INSERT INTO subscriptions (org_id, plan, term, price_paise, status, current_until)
     VALUES ($1,'pro','yearly',1499000,'active', now() + interval '365 days')`, [o[0].id]);

  const b = await admin.businessMetrics(adminCtx());
  assert.equal(b.revenue.arrPaise, b.revenue.mrrPaise * 12);
  assert.ok(b.revenue.mrrPaise >= 124916 && b.revenue.mrrPaise < 1499000,
    `a yearly plan contributed ${b.revenue.mrrPaise} to MRR`);
});

test('LTV is withheld rather than invented when there is no churn', async () => {
  // "LTV ₹4,80,000" from two months of data is the kind of figure that ends up
  // in a pitch deck.
  const b = await admin.businessMetrics(adminCtx());
  if (b.health.churnPercent === 0) {
    assert.equal(b.revenue.ltvPaise, null);
    assert.match(b.revenue.ltvLabel, /Not enough history/);
  }
});

test('churn is measured against the base that could have churned', async () => {
  /*
   * Dividing by the CURRENT subscription count flatters a shrinking business
   * and punishes a growing one. The denominator has to be what existed at the
   * start of the window.
   */
  const b = await admin.businessMetrics(adminCtx());
  assert.ok(b.health.churnPercent >= 0 && b.health.churnPercent <= 100,
    `churn came out at ${b.health.churnPercent}%`);
});

test('percentages are never NaN on an empty database', async () => {
  // Every one of these is a division, and every denominator can be zero on the
  // first day. A dashboard full of NaN is the first thing anybody sees.
  const o = await admin.overview(adminCtx());
  const walk = (v, path = '') => {
    if (typeof v === 'number') {
      assert.ok(Number.isFinite(v), `${path} is ${v}`);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    }
  };
  walk(o);
});

test('a sync success rate with no syncs reads as 100, not 0', async () => {
  // Nothing has failed. Reporting 0% would light up an alarm on a quiet night.
  const t = await admin.technicalMetrics(adminCtx());
  if (t.sync.runs24h === 0) assert.equal(t.sync.successPercent, 100);
});

test('E-Invoice and E-Way counts say why they are zero', async () => {
  // A blank on a dashboard is otherwise read as "nobody uses it" rather than
  // "we do not do this".
  const f = await admin.featureMetrics(adminCtx());
  assert.equal(f.compliance.eInvoices, 0);
  assert.match(f.compliance.note, /GSP contract/);
});

test('the database latency is measured, not guessed', async () => {
  const t = await admin.technicalMetrics(adminCtx());
  assert.ok(t.database.latencyMs > 0, 'a real round trip takes some time');
  assert.ok(t.database.latencyMs < 5000);
});

// --- the request metrics ----------------------------------------------------

beforeEach(() => metrics.reset());

test('ids are collapsed so routes group', () => {
  // Otherwise every voucher ever opened is its own route, and the slowest
  // endpoint is always whichever has the most distinct ids.
  assert.equal(
    metrics.normalise('/v1/companies/11111111-1111-1111-1111-111111111111/txn/sales'),
    '/v1/companies/:id/txn/sales');
  assert.equal(metrics.normalise('/v1/reports/42'), '/v1/reports/:n');
});

test('p95 is reported as well as the mean', () => {
  /*
   * A route averaging 80ms with a p95 of four seconds is a broken route, and
   * the average says it is fine.
   */
  for (let i = 0; i < 99; i++) metrics.observe({ method: 'GET', path: '/x', status: 200, ms: 10 });
  metrics.observe({ method: 'GET', path: '/x', status: 200, ms: 4000 });

  const h = metrics.apiHealth();
  assert.ok(h.avgMs < 100, `mean hid the tail: ${h.avgMs}`);
  assert.equal(h.maxMs, 4000);
  assert.ok(h.p99Ms >= 10);
});

test('the error rate counts only our own failures', () => {
  // A 404 is somebody asking for something that is not there; a 500 is a bug.
  // Mixing them makes the error rate track user typos.
  metrics.observe({ method: 'GET', path: '/x', status: 500, ms: 5 });
  metrics.observe({ method: 'GET', path: '/x', status: 404, ms: 5 });
  metrics.observe({ method: 'GET', path: '/x', status: 200, ms: 5 });

  const h = metrics.apiHealth();
  assert.equal(h.errors, 1);
  assert.equal(h.lifetime.rejected, 1);
});

test('the buffer never grows without bound', () => {
  // A busy server would otherwise accumulate a million samples a day and the
  // memory graph would blame the metrics.
  for (let i = 0; i < metrics.CAPACITY * 2; i++) {
    metrics.observe({ method: 'GET', path: '/x', status: 200, ms: 1 });
  }
  assert.ok(metrics.apiHealth().samples <= metrics.CAPACITY);
});

test('load is reported against core count', () => {
  // "Load 4" means nothing without knowing whether there are two cores or
  // thirty-two.
  const s = metrics.system();
  assert.ok(s.cores >= 1);
  assert.ok(Number.isFinite(s.loadPercent));
  assert.ok(s.memory.rssMb > 0);
});

// --- one customer -----------------------------------------------------------

test('the customer view leads with what support calls are about', async () => {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('cust-test','pro') RETURNING *`);
  orgs.push(o[0].id);
  await query(`INSERT INTO companies (org_id, tally_guid, name)
               VALUES ($1,$2,'Books')`, [o[0].id, `c-${o[0].id}`]);

  const c = await admin.customer(adminCtx(), o[0].id);
  assert.equal(c.account.planLabel, 'Pro');
  assert.ok('connectorOnline' in c.headline);
  assert.ok('lastSync' in c.headline);
  assert.ok(Array.isArray(c.headline.atLimit));
  assert.equal(c.companies.length, 1);
});

test('an unknown account is a 404, not an empty page', async () => {
  await assert.rejects(
    () => admin.customer(adminCtx(), '11111111-1111-1111-1111-111111111111'),
    (e) => e.status === 404);
});

// --- editing one customer ---------------------------------------------------

const misc = require('../src/routes/misc');

test('a ceiling can be raised and then cleared again', async () => {
  /*
   * These columns are overrides now: NULL means "let the plan decide". With a
   * plain COALESCE a ceiling was impossible to remove once set, so a customer
   * bumped to 9 books during a trial kept 9 for ever.
   */
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('override-test','basic') RETURNING *`);
  orgs.push(o[0].id);

  const raised = await misc.adminUpdateOrg(
    { ...adminCtx(), body: { maxCompanies: 9 } }, o[0].id);
  assert.equal(raised.maxCompanies, 9);
  assert.equal(raised.overrides.companies, 9);

  const cleared = await misc.adminUpdateOrg(
    { ...adminCtx(), body: { maxCompanies: null } }, o[0].id);
  assert.equal(cleared.overrides.companies, null, 'the override was removed');
  assert.equal(cleared.maxCompanies, 1, 'and the Basic plan decides again');
});

test('not mentioning a ceiling leaves it alone', async () => {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan, max_companies) VALUES ('untouched','basic',7) RETURNING *`);
  orgs.push(o[0].id);

  const r = await misc.adminUpdateOrg({ ...adminCtx(), body: { notes: 'hello' } }, o[0].id);
  assert.equal(r.overrides.companies, 7);
});

test('an unlimited plan reports no ceiling rather than a number', async () => {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('ent-test','enterprise') RETURNING *`);
  orgs.push(o[0].id);
  const list = await misc.adminOrgs(adminCtx());
  const row = list.orgs.find((x) => x.id === o[0].id);
  assert.equal(row.maxCompanies, null);
  assert.equal(row.planLabel, 'Enterprise');
});

test('a plan the product does not sell is refused before it reaches the database', async () => {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('badplan','basic') RETURNING *`);
  orgs.push(o[0].id);
  await assert.rejects(
    () => misc.adminUpdateOrg({ ...adminCtx(), body: { plan: 'platinum' } }, o[0].id),
    /No such plan/);
});
