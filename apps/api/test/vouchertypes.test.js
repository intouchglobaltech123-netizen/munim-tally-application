const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const VT = require('../src/lib/vouchertypes');
const dash = require('../src/routes/dashboard');

/**
 * An order is a commitment to trade, not trade.
 *
 * "Sales Order" contains "sale", so the obvious test for a sale matches it -
 * and counting one as revenue overstates sales, overstates profit, and shows a
 * customer money they have not earned. This is the regression guard.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

test('an order is never a sale or a purchase', () => {
  for (const t of ['Sales Order', 'Purchase Order', 'Quotation',
                   'Delivery Note', 'Receipt Note']) {
    assert.equal(VT.isSale(t), false, `${t} is not a sale`);
    assert.equal(VT.isPurchase(t), false, `${t} is not a purchase`);
    assert.equal(VT.isOrder(t), true, `${t} is an order`);
  }
});

test('real trade is still recognised', () => {
  assert.equal(VT.isSale('Sales'), true);
  assert.equal(VT.isSale('GST Sales'), true);
  assert.equal(VT.isPurchase('Purchase'), true);
  assert.equal(VT.isReceipt('Receipt'), true);
  assert.equal(VT.isPayment('Payment'), true);
});

test('a return is not a sale', () => {
  assert.equal(VT.isSale('Sales Return'), false);
  assert.equal(VT.isPurchase('Purchase Return'), false);
});

test('a receipt note is not a receipt', () => {
  // It records goods arriving, not money.
  assert.equal(VT.isReceipt('Receipt Note'), false);
  assert.equal(VT.isReceipt('Receipt'), true);
});

test('the SQL and the JavaScript agree on every type', async () => {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['vt-test']);
  orgs.push(o[0].id);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'VT') RETURNING *`,
    [o[0].id, `vt-${o[0].id}`]);

  const types = ['Sales', 'Sales Order', 'Sales Return', 'Purchase', 'Purchase Order',
                 'Quotation', 'Delivery Note', 'Receipt', 'Receipt Note', 'Payment'];
  for (const t of types) {
    await query(
      `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
       VALUES ($1,$2,'1',$3,'2026-05-01','P',10000)`, [c[0].id, `v-${t}`, t]);
  }

  const { rows } = await query(
    `SELECT v.vch_type FROM vouchers v WHERE v.company_id = $1 AND ${VT.SALES}`, [c[0].id]);
  const fromSql = rows.map((r) => r.vch_type).sort();
  const fromJs = types.filter(VT.isSale).sort();

  // Two definitions that disagree is exactly the bug nobody finds until a
  // customer does.
  assert.deepEqual(fromSql, fromJs);
  assert.deepEqual(fromSql, ['Sales']);
});

test('the dashboard does not count orders as revenue', async () => {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['vt-dash']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `vt-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'VT Dash') RETURNING *`,
    [o[0].id, `vtd-${o[0].id}`]);

  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'s1','1','Sales','2026-05-01','P',100000),
            ($1,'o1','2','Sales Order','2026-05-02','P',900000),
            ($1,'q1','3','Quotation','2026-05-03','P',500000)`, [c[0].id]);

  const d = await dash.overview({
    session: { org: { id: o[0].id }, user: { id: u[0].id, role: 'owner', roleId: null } },
    url: new URL('http://x/?period=custom&from=2026-05-01&to=2026-05-31'),
  }, c[0].tally_guid);

  // ₹1,000 of actual sales, not ₹15,000 of sales plus wishes.
  assert.equal(d.metrics.sales.paise, 100000);
});
