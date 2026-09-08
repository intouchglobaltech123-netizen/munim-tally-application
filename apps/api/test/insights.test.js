const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const insights = require('../src/routes/insights');

/**
 * The insight endpoints, against a company built for the purpose.
 *
 * Fixed dates rather than offsets from today, so a bucket boundary cannot
 * start failing six months from now because the fixture drifted across it.
 */

const orgs = [];

/** A company whose latest voucher is 2025-06-30 - every "as on" derives from it. */
async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['insight-test']);
  orgs.push(o[0].id);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1, $2, $3) RETURNING *`,
    [o[0].id, `guid-${o[0].id}`, 'Insight Test Co']);

  const co = c[0];
  const led = (name, group, closing, phone = '', creditDays = 0) => query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group, closing_paise, phone, credit_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [co.id, `${co.id}-${name}`, name, group, closing, phone, creditDays]);

  await led('Active Buyer', 'Sundry Debtors', 500000, '9000000001');
  await led('Quiet Buyer', 'Sundry Debtors', 300000, '9000000002');
  // Owes money and has no phone: the case a reminder feature cannot serve.
  await led('No Phone Ltd', 'Sundry Debtors', 200000, '');

  const vch = async (party, date, paise, type = 'Sales') => {
    const { rows } = await query(
      `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [co.id, `${co.id}-${party}-${date}-${paise}`, '1', type, date, party, paise]);
    return rows[0].id;
  };

  const vActive = await vch('Active Buyer', '2025-06-20', 100000);
  await vch('Active Buyer', '2025-04-10', 400000);
  // Last bought well over a year before the as-on date.
  const vQuiet = await vch('Quiet Buyer', '2024-01-15', 300000);
  const vNoPhone = await vch('No Phone Ltd', '2025-06-30', 200000);

  // Every bill hangs off a voucher, as it does in Tally.
  const bill = (voucherId, party, billDate, dueDate, paise) => query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date, amount_paise)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [co.id, voucherId, `ref-${party}-${billDate}`, party, billDate, dueDate, paise]);

  // Due 10 days after the as-on date: not overdue, inside the 15-day window.
  await bill(vActive, 'Active Buyer', '2025-06-01', '2025-07-10', 100000);
  // 20 days overdue -> the 0-45 bucket.
  await bill(vQuiet, 'Quiet Buyer', '2025-05-01', '2025-06-10', 300000);
  // 120 days overdue -> the 90-135 bucket.
  await bill(vNoPhone, 'No Phone Ltd', '2025-02-01', '2025-03-02', 200000);

  return { orgId: o[0].id, co };
}

const ctxFor = (orgId, q = '') => ({
  session: { org: { id: orgId, name: 'Insight Test Co' }, user: { role: 'owner' } },
  url: new URL(`http://x/${q}`),
});

after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

test('"as on" is the last voucher date, not today', async () => {
  const { orgId, co } = await fixture();
  const r = await insights.ageing(ctxFor(orgId), co.tally_guid);
  // Reports must not drift forward past the books. A company that stopped
  // syncing in June should still read as June, not silently age its own bills.
  assert.equal(new Date(r.asOf).toISOString().slice(0, 10), '2025-06-30');
});

test('bills land in the right ageing bucket', async () => {
  const { orgId, co } = await fixture();
  const r = await insights.ageing(ctxFor(orgId), co.tally_guid);
  const at = (label) => r.buckets.find((b) => b.label === label).amountPaise;

  assert.equal(at('0-45'), 300000, '20 days overdue belongs in 0-45');
  assert.equal(at('90-135'), 200000, '120 days overdue belongs in 90-135');
  assert.equal(at('45-90'), 0);

  // A bill not yet due is outstanding but not overdue - it must count toward
  // the total and not toward the overdue figure.
  assert.equal(r.totalPaise, 600000);
  assert.equal(r.overduePaise, 500000);
});

test('projections separate overdue from what is still coming', async () => {
  const { orgId, co } = await fixture();
  const r = await insights.projections(ctxFor(orgId), co.tally_guid);
  assert.equal(r.overduePaise, 500000);
  assert.equal(r.next15Paise, 100000, 'due 10 days out');
  // The 60-day figure includes the 15-day one rather than excluding it.
  assert.equal(r.next60Paise, 100000);
});

test('attention finds the quiet customer and the one with no phone', async () => {
  const { orgId, co } = await fixture();
  const r = await insights.attention(ctxFor(orgId, '?days=90'), co.tally_guid);
  const by = Object.fromEntries(r.items.map((i) => [i.key, i]));

  assert.equal(by.quiet.count, 1, 'Quiet Buyer last bought in Jan 2024');
  assert.equal(by['no-contact'].count, 1);
  assert.equal(by['no-contact'].amountPaise, 200000);
  assert.equal(by.overdue.count, 2);
  assert.equal(by.overdue.tone, 'bad');
  // Nothing wrong reads as ok, so the UI can stay quiet about it.
  assert.equal(by['negative-stock'].tone, 'ok');
});

test('the quiet window is a parameter, and a wider one forgives more', async () => {
  const { orgId, co } = await fixture();
  const narrow = await insights.attention(ctxFor(orgId, '?days=7'), co.tally_guid);
  const wide = await insights.attention(ctxFor(orgId, '?days=365'), co.tally_guid);
  const quiet = (r) => r.items.find((i) => i.key === 'quiet').count;
  // Active Buyer bought 10 days before the as-on date: quiet at 7 days, not at 365.
  assert.equal(quiet(narrow), 2);
  assert.equal(quiet(wide), 1);
});

test('an out-of-range window is clamped rather than trusted', async () => {
  const { orgId, co } = await fixture();
  const r = await insights.attention(ctxFor(orgId, '?days=99999'), co.tally_guid);
  assert.equal(r.quietDays, 365);
  const junk = await insights.attention(ctxFor(orgId, '?days=notanumber'), co.tally_guid);
  assert.equal(junk.quietDays, 90, 'falls back to the default');
});

test('rankings sum to the total and carry a share', async () => {
  const { orgId, co } = await fixture();
  const r = await insights.top(ctxFor(orgId, '?by=customer&days=3650&limit=10'), co.tally_guid);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].label, 'Active Buyer');
  assert.equal(r.rows[0].amountPaise, 500000);
  assert.equal(r.totalPaise, r.rows.reduce((n, x) => n + x.amountPaise, 0));
  assert.equal(r.rows.reduce((n, x) => n + x.sharePct, 0), 100);
});

test('an unknown ranking dimension falls back instead of failing', async () => {
  const { orgId, co } = await fixture();
  const r = await insights.top(ctxFor(orgId, '?by=nonsense'), co.tally_guid);
  assert.equal(r.by, 'nonsense');
  assert.ok(Array.isArray(r.rows), 'still answers with a shape the UI can render');
});

test('every ranking dimension runs - the SQL is generated, so it must be executed', async () => {
  const { orgId, co } = await fixture();
  // The integer window was once passed uncast and Postgres rejected
  // "date > integer" at run time, not at load time. Only executing each
  // variant catches that.
  for (const by of ['customer', 'supplier', 'item', 'group', 'voucher-type', 'debtor']) {
    const r = await insights.top(ctxFor(orgId, `?by=${by}&days=365`), co.tally_guid);
    assert.ok(Array.isArray(r.rows), `${by} returned rows`);
  }
});

test('a period with no prior sales reports no percentage, not Infinity', async () => {
  const { orgId, co } = await fixture();
  const r = await insights.trends(ctxFor(orgId), co.tally_guid);
  const at = (d) => r.windows.find((w) => w.days === d);

  // The week has something to compare against: 200000 sold in the last 7 days
  // against 100000 in the 7 before it.
  assert.equal(at(7).amountPaise, 200000);
  assert.equal(at(7).prevPaise, 100000);
  assert.equal(at(7).changePct, 100);

  // The month does not - nothing was sold in May. The change from zero is
  // undefined, and must read as null rather than Infinity, which is what a
  // plain division would produce and what a dashboard would then print.
  assert.equal(at(30).amountPaise, 300000);
  assert.equal(at(30).prevPaise, 0);
  assert.equal(at(30).changePct, null);
});

test('a company in another org is never reachable', async () => {
  const a = await fixture();
  const b = await fixture();
  // Asking for A's company with B's session must not answer with A's figures.
  await assert.rejects(
    () => insights.ageing(ctxFor(b.orgId), a.co.tally_guid),
    (e) => e.status === 404);
});
