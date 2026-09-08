const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const books = require('../src/routes/books');

/**
 * The books an accountant asks for by name.
 *
 * The rule these all have to obey: a Cash Book that does not tie to the ledger
 * balance is worse than no Cash Book, because somebody will trust it.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['bk-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `bk-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Bk Co') RETURNING *`,
    [o[0].id, `bk-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, qs = '?period=custom&from=2026-05-01&to=2026-05-31') => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  url: new URL(`http://x/${qs}`),
});

const ledger = (f, name, group, opening = 0, closing = 0) => query(
  `INSERT INTO ledgers (company_id, guid, name, parent_group, opening_paise, closing_paise)
   VALUES ($1,$2,$3,$4,$5,$6)`, [f.co.id, `l-${name}`, name, group, opening, closing]);

async function entry(f, { no, type, date, party, legs }) {
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [f.co.id, `v-${no}-${date}`, no, type, date, party ?? '',
     Math.abs(legs[0][1])]);
  for (const [name, amt] of legs) {
    await query(
      `INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise) VALUES ($1,$2,$3)`,
      [rows[0].id, name, amt]);
  }
  return rows[0].id;
}

// --- cash book --------------------------------------------------------------

test('a debit to cash is money IN', async () => {
  const f = await fixture();
  await ledger(f, 'Cash', 'Cash-in-Hand');
  // Exactly what the connector stores for a receipt.
  await entry(f, { no: 'R1', type: 'Receipt', date: '2026-05-05', party: 'Acme',
    legs: [['Cash', 50000], ['Acme', -50000]] });

  const b = await books.cashBook(ctxFor(f), f.co.tally_guid);
  assert.equal(b.rows[0].inPaise, 50000);
  assert.equal(b.rows[0].outPaise, 0);
  // Reading the sign the other way labelled every receipt as a payment.
  assert.equal(b.totals.inPaise, 50000);
});

test('a credit to cash is money OUT', async () => {
  const f = await fixture();
  await ledger(f, 'Cash', 'Cash-in-Hand');
  await entry(f, { no: 'P1', type: 'Payment', date: '2026-05-06', party: 'Supplier',
    legs: [['Cash', -20000], ['Supplier', 20000]] });

  const b = await books.cashBook(ctxFor(f), f.co.tally_guid);
  assert.equal(b.rows[0].outPaise, 20000);
  assert.equal(b.rows[0].inPaise, 0);
});

test('the running balance is cumulative and lands on the closing figure', async () => {
  const f = await fixture();
  await ledger(f, 'Cash', 'Cash-in-Hand');
  await entry(f, { no: 'R1', type: 'Receipt', date: '2026-05-01',
    legs: [['Cash', 100000], ['A', -100000]] });
  await entry(f, { no: 'P1', type: 'Payment', date: '2026-05-02',
    legs: [['Cash', -30000], ['B', 30000]] });
  await entry(f, { no: 'R2', type: 'Receipt', date: '2026-05-03',
    legs: [['Cash', 5000], ['C', -5000]] });

  const b = await books.cashBook(ctxFor(f), f.co.tally_guid);
  // The balance after each line is what lets somebody find the day it went
  // wrong.
  assert.deepEqual(b.rows.map((r) => r.balancePaise), [100000, 70000, 75000]);
  assert.equal(b.closingPaise, 75000);
});

test('an opening balance carries in from before the period', async () => {
  const f = await fixture();
  await ledger(f, 'Cash', 'Cash-in-Hand', 40000);
  await entry(f, { no: 'R0', type: 'Receipt', date: '2026-04-10',
    legs: [['Cash', 10000], ['A', -10000]] });
  await entry(f, { no: 'R1', type: 'Receipt', date: '2026-05-05',
    legs: [['Cash', 5000], ['A', -5000]] });

  const b = await books.cashBook(ctxFor(f), f.co.tally_guid);
  // Ledger opening 400 plus 100 moved before May.
  assert.equal(b.openingPaise, 50000);
  assert.equal(b.rows.length, 1, 'April is outside the window');
  assert.equal(b.closingPaise, 55000);
});

test('the contra account is named, so a line can be read', async () => {
  const f = await fixture();
  await ledger(f, 'Cash', 'Cash-in-Hand');
  await entry(f, { no: 'R1', type: 'Receipt', date: '2026-05-05', party: 'Acme',
    legs: [['Cash', 50000], ['Acme Traders', -50000]] });

  const b = await books.cashBook(ctxFor(f), f.co.tally_guid);
  // "50,000 from Acme Traders" beats "50,000".
  assert.equal(b.rows[0].contra, 'Acme Traders');
});

test('the bank book covers bank groups, not cash', async () => {
  const f = await fixture();
  await ledger(f, 'Cash', 'Cash-in-Hand');
  await ledger(f, 'HDFC', 'Bank Accounts');
  await entry(f, { no: 'R1', type: 'Receipt', date: '2026-05-05',
    legs: [['HDFC', 90000], ['A', -90000]] });
  await entry(f, { no: 'R2', type: 'Receipt', date: '2026-05-05',
    legs: [['Cash', 10000], ['A', -10000]] });

  const bank = await books.cashBook(ctxFor(f, '?kind=bank&period=custom&from=2026-05-01&to=2026-05-31'),
    f.co.tally_guid);
  assert.deepEqual(bank.accounts.map((a) => a.name), ['HDFC']);
  assert.equal(bank.totals.inPaise, 90000);
});

test('no cash account says so instead of showing an empty page', async () => {
  const f = await fixture();
  const b = await books.cashBook(ctxFor(f), f.co.tally_guid);
  assert.equal(b.rows.length, 0);
  assert.match(b.note, /Cash-in-Hand/);
});

// --- group summary ----------------------------------------------------------

test('balances roll up through the group tree', async () => {
  const f = await fixture();
  await query(
    `INSERT INTO groups (company_id, guid, name, parent, primary_group) VALUES
       ($1,'g1','Current Assets','',''),
       ($1,'g2','Sundry Debtors','Current Assets',''),
       ($1,'g3','Local Buyers','Sundry Debtors','')`, [f.co.id]);
  await ledger(f, 'A', 'Local Buyers', 0, 30000);
  await ledger(f, 'B', 'Sundry Debtors', 0, 20000);

  const r = await books.groupSummary(ctxFor(f), f.co.tally_guid);
  const ca = r.groups.find((g) => g.name === 'Current Assets');
  // The question a balance sheet is built from: what are ALL my current
  // assets worth.
  assert.equal(ca.totalBalancePaise, 50000);
  assert.equal(ca.totalLedgers, 2);
  assert.equal(ca.ownBalancePaise, 0, 'nothing posted directly to it');
});

test('a cyclic group tree terminates instead of hanging', async () => {
  const f = await fixture();
  await query(
    `INSERT INTO groups (company_id, guid, name, parent, primary_group) VALUES
       ($1,'g1','Loop A','Loop B',''), ($1,'g2','Loop B','Loop A','')`, [f.co.id]);
  await ledger(f, 'X', 'Loop A', 0, 1000);
  const r = await books.groupSummary(ctxFor(f), f.co.tally_guid);
  assert.ok(Array.isArray(r.groups));
});

test('a ledger in a group Tally never sent still appears', async () => {
  const f = await fixture();
  await ledger(f, 'Orphan', 'Vanished Group', 0, 7000);
  const r = await books.groupSummary(ctxFor(f), f.co.tally_guid);
  const node = r.groups.find((g) => g.name === 'Vanished Group');
  // Its money is real and has to appear somewhere.
  assert.ok(node);
  assert.equal(node.totalBalancePaise, 7000);
});

// --- registers --------------------------------------------------------------

test('a register splits tax into its columns', async () => {
  const f = await fixture();
  const id = await entry(f, { no: 'S1', type: 'Sales', date: '2026-05-10', party: 'Acme',
    legs: [['Sales Account', -100000]] });
  await query(
    `UPDATE vouchers SET amount_paise = 118000 WHERE id = $1`, [id]);
  await query(
    `INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise)
     VALUES ($1,'Output CGST',-9000), ($1,'Output SGST',-9000)`, [id]);

  const r = await books.register(ctxFor(f), f.co.tally_guid, 'sales');
  assert.equal(r.rows[0].cgstPaise, 9000);
  assert.equal(r.rows[0].sgstPaise, 9000);
  // Derived by subtraction: books posting through a control account carry no
  // separate taxable leg to read.
  assert.equal(r.rows[0].taxablePaise, 100000);
  assert.equal(r.totals.grossPaise, 118000);
});

test('returns subtract from the register total', async () => {
  const f = await fixture();
  await entry(f, { no: 'S1', type: 'Sales', date: '2026-05-10', party: 'A',
    legs: [['Sales Account', -100000]] });
  await entry(f, { no: 'C1', type: 'Credit Note', date: '2026-05-11', party: 'A',
    legs: [['Sales Account', 30000]] });

  const without = await books.register(ctxFor(f), f.co.tally_guid, 'sales');
  const withReturns = await books.register(
    ctxFor(f, '?returns=1&period=custom&from=2026-05-01&to=2026-05-31'),
    f.co.tally_guid, 'sales');

  assert.equal(without.totals.count, 1);
  assert.equal(withReturns.totals.count, 2);
  // The total is what the period actually traded.
  assert.equal(withReturns.totals.grossPaise, 70000);
});

// --- due soon ---------------------------------------------------------------

test('bills are bucketed by how soon they fall due', async () => {
  const f = await fixture();
  await ledger(f, 'Acme', 'Sundry Debtors');
  await entry(f, { no: 'S1', type: 'Sales', date: '2026-05-20', party: 'Acme',
    legs: [['Sales Account', -1000]] });
  const { rows: v } = await query(
    'SELECT id FROM vouchers WHERE company_id = $1 LIMIT 1', [f.co.id]);

  // The books run to 20 May, which is the "today" every period measures from.
  const bill = (ref, due, amt) => query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date, amount_paise)
     VALUES ($1,$2,$3,'Acme','2026-05-01',$4,$5)`, [f.co.id, v[0].id, ref, due, amt]);

  await bill('OVERDUE', '2026-05-10', 1000);
  await bill('TODAY', '2026-05-20', 2000);
  await bill('WEEK', '2026-05-25', 3000);
  await bill('MONTH', '2026-06-15', 4000);
  await bill('LATER', '2026-09-01', 5000);

  const r = await books.dueSoon(ctxFor(f), f.co.tally_guid);
  // "Who do I ring this morning" is a different question from "how old is
  // this money".
  assert.equal(r.groups.today[0].ref, 'TODAY');
  assert.equal(r.groups.week[0].ref, 'WEEK');
  assert.equal(r.groups.month[0].ref, 'MONTH');
  assert.equal(r.groups.later[0].ref, 'LATER');
  assert.equal(r.totals.overdue.count, 1);
});

test('due-soon carries the phone number, since the point is to ring them', async () => {
  const f = await fixture();
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group, phone)
     VALUES ($1,'l1','Acme','Sundry Debtors','9876543210')`, [f.co.id]);
  const id = await entry(f, { no: 'S1', type: 'Sales', date: '2026-05-20', party: 'Acme',
    legs: [['Sales Account', -1000]] });
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date, amount_paise)
     VALUES ($1,$2,'B1','Acme','2026-05-01','2026-05-20',1000)`, [f.co.id, id]);

  const r = await books.dueSoon(ctxFor(f), f.co.tally_guid);
  assert.equal(r.groups.today[0].phone, '9876543210');
});

// --- expiry -----------------------------------------------------------------

test('a business with no batches is told so, not shown an empty table', async () => {
  const f = await fixture();
  const r = await books.expiry(ctxFor(f), f.co.tally_guid);
  assert.equal(r.rows.length, 0);
  assert.match(r.note, /does not track batches/i);
});

test('expiring batches are graded by how soon', async () => {
  const f = await fixture();
  await entry(f, { no: 'S1', type: 'Sales', date: '2026-05-20',
    legs: [['Sales Account', -1000]] });
  const batch = (name, expiry) => query(
    `INSERT INTO stock_batches (company_id, item_name, batch_name, qty, value_paise, expiry_date)
     VALUES ($1,'Milk',$2,10,1000,$3)`, [f.co.id, name, expiry]);

  await batch('GONE', '2026-05-01');
  await batch('SOON', '2026-06-05');
  await batch('WATCH', '2026-07-20');
  await batch('FINE', '2027-01-01');

  const r = await books.expiry(ctxFor(f), f.co.tally_guid);
  const by = Object.fromEntries(r.rows.map((x) => [x.batch, x.status]));
  assert.equal(by.GONE, 'expired');
  assert.equal(by.SOON, 'soon');
  assert.equal(by.WATCH, 'watch');
  assert.equal(by.FINE, 'ok');
  assert.equal(r.totals.expired, 1);
});

test('reports never cross company boundaries', async () => {
  const a = await fixture();
  const b = await fixture();
  await assert.rejects(
    () => books.cashBook(ctxFor(b), a.co.tally_guid), (e) => e.status === 404);
});
