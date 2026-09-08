const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const insights = require('../src/routes/insights');
const reports = require('../src/routes/reports');
const books = require('../src/routes/books');

/**
 * A bill is one thing; Tally stores it as several rows.
 *
 * An invoice writes a "New Ref" row and every receipt against it writes an
 * "Agst Ref" row — posted to Cash, not to the customer. Reports that filtered
 * on a positive amount, or grouped by (party, ref), counted the invoice and
 * threw away the settlement: ₹27,60,900 outstanding on books whose ledgers
 * said ₹14,24,700.
 *
 * These tests pin the shape so it cannot come back.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['ob-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `ob-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'OB Co') RETURNING *`,
    [o[0].id, `ob-${o[0].id}`]);
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group, closing_paise)
     VALUES ($1,'l1','Acme','Sundry Debtors',0), ($1,'l2','Cash','Cash-in-Hand',0)`, [c[0].id]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, qs = '') => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  url: new URL(`http://x/${qs}`),
});

/** An invoice, then a receipt against it — exactly as the connector stores them. */
async function invoiceAndSettle(f, ref, amount, settled) {
  const { rows: inv } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,$3,'Sales','2026-01-10','Acme',$4) RETURNING id`,
    [f.co.id, `v-${ref}`, ref, amount]);
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date,
                        amount_paise, bill_type)
     VALUES ($1,$2,$3,'Acme','2026-01-10','2026-02-10',$4,'New Ref')`,
    [f.co.id, inv[0].id, ref, amount]);

  if (settled) {
    const { rows: rec } = await query(
      `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
       VALUES ($1,$2,'R','Receipt','2026-01-20','Acme',$3) RETURNING id`,
      [f.co.id, `r-${ref}`, settled]);
    // The settlement posts to Cash, which is what broke grouping by party.
    await query(
      `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date,
                          amount_paise, bill_type)
       VALUES ($1,$2,$3,'Cash','2026-01-20','2026-02-10',$4,'Agst Ref')`,
      [f.co.id, rec[0].id, ref, -settled]);
  }
}

test('a fully settled bill is not outstanding', async () => {
  const f = await fixture();
  await invoiceAndSettle(f, 'INV-1', 100000, 100000);
  const { rows } = await query(
    'SELECT * FROM open_bills WHERE company_id = $1', [f.co.id]);
  assert.equal(rows.length, 0);
});

test('a partly settled bill is outstanding for the remainder only', async () => {
  const f = await fixture();
  await invoiceAndSettle(f, 'INV-1', 100000, 40000);
  const { rows } = await query(
    'SELECT * FROM open_bills WHERE company_id = $1', [f.co.id]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount_paise), 60000);
  // The invoice's party, not the receipt's — otherwise half a shop's debts
  // get filed under "Cash".
  assert.equal(rows[0].party, 'Acme');
});

test('the ageing report agrees with the ledger, not with the row count', async () => {
  const f = await fixture();
  await invoiceAndSettle(f, 'INV-1', 100000, 100000);   // settled
  await invoiceAndSettle(f, 'INV-2', 50000, 0);         // open
  await query(
    `UPDATE ledgers SET closing_paise = 50000 WHERE company_id = $1 AND name = 'Acme'`,
    [f.co.id]);

  const a = await insights.ageing(ctxFor(f), f.co.tally_guid);
  // Counting positive rows would give 150000 here.
  assert.equal(a.totalPaise, 50000);
});

test('the outstanding report agrees too', async () => {
  const f = await fixture();
  await invoiceAndSettle(f, 'INV-1', 100000, 100000);
  await invoiceAndSettle(f, 'INV-2', 50000, 0);
  // Real books carry the matching ledger balance; the party list is driven
  // from there, with the bills hung off it.
  await query(
    `UPDATE ledgers SET closing_paise = 50000 WHERE company_id = $1 AND name = 'Acme'`,
    [f.co.id]);

  const o = await reports.outstanding(ctxFor(f), f.co.tally_guid);
  // Grouped by party, each carrying its own bills.
  assert.equal(o.totals.total, 50000);
  const bills = o.items.flatMap((p) => p.bills);
  assert.equal(bills.length, 1);
  assert.equal(bills[0].pendingPaise, 50000);
});

test('due-soon lists a bill once, for what is left on it', async () => {
  const f = await fixture();
  await invoiceAndSettle(f, 'INV-1', 100000, 30000);
  const d = await books.dueSoon(ctxFor(f), f.co.tally_guid);
  const all = Object.values(d.groups).flat();
  assert.equal(all.length, 1);
  assert.equal(all[0].amountPaise, 70000);
});

test('several receipts against one bill still net to one figure', async () => {
  const f = await fixture();
  await invoiceAndSettle(f, 'INV-1', 100000, 0);
  // Three part payments, as a customer paying in instalments produces.
  for (const [i, amt] of [[1, 20000], [2, 30000], [3, 10000]]) {
    const { rows: rec } = await query(
      `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
       VALUES ($1,$2,$3,'Receipt',$4::date,'Acme',$5) RETURNING id`,
      [f.co.id, `r${i}`, String(i), `2026-01-2${i}`, amt]);
    await query(
      `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date,
                          amount_paise, bill_type)
       VALUES ($1,$2,'INV-1','Cash','2026-01-20','2026-02-10',$3,'Agst Ref')`,
      [f.co.id, rec[0].id, -amt]);
  }

  const { rows } = await query(
    'SELECT * FROM open_bills WHERE company_id = $1', [f.co.id]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount_paise), 40000);
  assert.equal(rows[0].allocations, 4, 'the invoice plus three receipts');
});

test('an over-settled bill does not become a negative debt', async () => {
  const f = await fixture();
  await invoiceAndSettle(f, 'INV-1', 100000, 120000);
  const { rows } = await query(
    'SELECT * FROM open_bills WHERE company_id = $1', [f.co.id]);
  // An advance is not a receivable, and showing it as minus ₹200 owed would
  // subtract from what the shop is actually owed.
  assert.equal(rows.length, 0);
});
