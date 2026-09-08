const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const vouchers = require('../src/routes/vouchers');

/**
 * "Is this paid?" is the first question asked of any invoice, so every screen
 * has to answer it the same way - which means the server answers it once.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['vs-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `vs-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'VS Co') RETURNING *`,
    [o[0].id, `vs-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f) => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  url: new URL('http://x/'), body: {},
});

async function invoice(f, { ref, amount, type = 'Sales', settled = 0 }) {
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,'1',$3,'2026-05-01','Acme',$4) RETURNING id`,
    [f.co.id, `v-${ref}`, type, amount]);
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, amount_paise, bill_type)
     VALUES ($1,$2,$3,'Acme','2026-05-01',$4,'New Ref')`,
    [f.co.id, rows[0].id, ref, amount]);

  if (settled) {
    // A receipt settles a bill by writing a NEGATIVE row against the same ref.
    const { rows: r } = await query(
      `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
       VALUES ($1,$2,'R1','Receipt','2026-05-10','Acme',$3) RETURNING id`,
      [f.co.id, `r-${ref}`, settled]);
    await query(
      `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, amount_paise, bill_type)
       VALUES ($1,$2,$3,'Acme','2026-05-10',$4,'Agst Ref')`,
      [f.co.id, r.rows ? r.rows[0].id : r[0].id, ref, -settled]);
  }
  return rows[0].id;
}

test('an unpaid invoice reads as unpaid', async () => {
  const f = await fixture();
  const id = await invoice(f, { ref: 'INV-1', amount: 100000 });
  const d = await vouchers.detail(ctxFor(f), f.co.tally_guid, id);
  assert.equal(d.paymentStatus, 'unpaid');
  assert.equal(d.outstandingPaise, 100000);
  assert.equal(d.paidPaise, 0);
});

test('a fully settled invoice reads as paid', async () => {
  const f = await fixture();
  const id = await invoice(f, { ref: 'INV-2', amount: 100000, settled: 100000 });
  const d = await vouchers.detail(ctxFor(f), f.co.tally_guid, id);
  assert.equal(d.paymentStatus, 'paid');
  assert.equal(d.outstandingPaise, 0);
  assert.equal(d.paidPaise, 100000);
});

test('a partly settled invoice reads as part paid', async () => {
  const f = await fixture();
  const id = await invoice(f, { ref: 'INV-3', amount: 100000, settled: 40000 });
  const d = await vouchers.detail(ctxFor(f), f.co.tally_guid, id);
  assert.equal(d.paymentStatus, 'part-paid');
  assert.equal(d.outstandingPaise, 60000);
  assert.equal(d.paidPaise, 40000);
});

test('a voucher that raises no bill has no payment status at all', async () => {
  const f = await fixture();
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'c1','1','Contra','2026-05-01','',50000) RETURNING id`, [f.co.id]);
  const d = await vouchers.detail(ctxFor(f), f.co.tally_guid, rows[0].id);
  // Inventing "unpaid" would put a red mark against an entry that can never
  // be paid.
  assert.equal(d.paymentStatus, null);
  assert.equal(d.outstandingPaise, null);
});

test('a receipt against an invoice names the invoice', async () => {
  const f = await fixture();
  await invoice(f, { ref: 'INV-4', amount: 100000, settled: 100000 });
  const { rows } = await query(
    `SELECT id FROM vouchers WHERE company_id = $1 AND vch_type = 'Receipt'`, [f.co.id]);
  const d = await vouchers.detail(ctxFor(f), f.co.tally_guid, rows[0].id);
  assert.equal(d.against.kind, 'against-invoice');
  assert.deepEqual(d.against.invoices, ['INV-4']);
  assert.equal(d.against.multiple, false);
});

test('a receipt with no bill reference is an advance', async () => {
  const f = await fixture();
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'adv','1','Receipt','2026-05-01','Acme',25000) RETURNING id`, [f.co.id]);
  const d = await vouchers.detail(ctxFor(f), f.co.tally_guid, rows[0].id);
  // An advance is not a debt being cleared, and a shop owner chasing a balance
  // needs to tell them apart.
  assert.equal(d.against.kind, 'advance');
});

test('a contra names which way the money went', async () => {
  const f = await fixture();
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'ct','1','Contra','2026-05-01','',50000) RETURNING id`, [f.co.id]);
  // Bank is credited (money leaves it), Cash is debited (money arrives).
  await query(
    `INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise)
     VALUES ($1,'Cash',50000), ($1,'HDFC Bank',-50000)`, [rows[0].id]);

  const d = await vouchers.detail(ctxFor(f), f.co.tally_guid, rows[0].id);
  // The direction is the only thing anyone reads a contra to find out, and it
  // follows the sign: out of the credited account, into the debited one.
  assert.equal(d.contra.label, 'HDFC Bank → Cash');
});

test('an order is marked as a commitment, not trade', async () => {
  const f = await fixture();
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'so','1','Sales Order','2026-05-01','Acme',500000) RETURNING id`, [f.co.id]);
  const d = await vouchers.detail(ctxFor(f), f.co.tally_guid, rows[0].id);
  assert.equal(d.isCommitment, true);

  const inv = await invoice(f, { ref: 'INV-9', amount: 100 });
  assert.equal((await vouchers.detail(ctxFor(f), f.co.tally_guid, inv)).isCommitment, false);
});

test('orders and quotations have their own sections', () => {
  const keys = vouchers.sectionList().map((s) => s.key);
  for (const k of ['quotation', 'sales-order', 'purchase-order',
                   'delivery-note', 'receipt-note']) {
    assert.ok(keys.includes(k), `${k} has a section`);
  }
  const commitments = vouchers.sectionList().filter((s) => s.commitment).map((s) => s.key);
  assert.equal(commitments.length, 5);
  // A screen that mixes them with sales tells an owner they have earned
  // something they have not.
  assert.ok(!commitments.includes('sales'));
});

test('debit and credit are the right way round', async () => {
  const f = await fixture();
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'rc','1','Receipt','2026-05-01','Acme',50000) RETURNING id`, [f.co.id]);
  // Exactly what the connector stores for a receipt: cash in, debtor down.
  await query(
    `INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise)
     VALUES ($1,'Cash',50000), ($1,'Acme',-50000)`, [rows[0].id]);

  const d = await vouchers.detail(ctxFor(f), f.co.tally_guid, rows[0].id);
  const by = Object.fromEntries(d.entries.map((e) => [e.ledger, e.side]));
  /*
   * Money arriving in cash is a debit. This read backwards for as long as the
   * screen existed, because the comment beside it assumed Tally's own sign -
   * which the connector has already flipped by this point.
   */
  assert.equal(by.Cash, 'debit');
  assert.equal(by.Acme, 'credit');
});
