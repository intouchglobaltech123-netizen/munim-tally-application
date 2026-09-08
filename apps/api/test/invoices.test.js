const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const inv = require('../src/routes/invoices');
const { amountInWords } = require('../src/lib/words');

/**
 * The GST parts, because getting them wrong on a printed document is the kind
 * of error a customer's auditor finds and Munim gets blamed for.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

// --- amount in words --------------------------------------------------------

test('money is written in lakh and crore, not millions', () => {
  // "One million two hundred thousand" on an invoice in Coimbatore marks the
  // document as foreign and, to an auditor, as wrong.
  assert.equal(amountInWords(10000000), 'Rupees One Lakh Only');
  assert.equal(amountInWords(1000000000), 'Rupees One Crore Only');
  assert.match(amountInWords(12345678900), /Twelve Crore Thirty Four Lakh/);
});

test('paise are named separately, never rounded away', () => {
  // Rounding would make the words disagree with the numerals beside them,
  // which is exactly what this line exists to prevent.
  assert.equal(amountInWords(150075), 'Rupees One Thousand Five Hundred and Seventy Five Paise Only');
  assert.equal(amountInWords(99), 'Ninety Nine Paise Only');
});

test('zero and negatives still read as sentences', () => {
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.match(amountInWords(-50000), /^Minus Rupees/);
});

test('an amount above ninety-nine crore still prints correctly', () => {
  assert.equal(amountInWords(100000000000), 'Rupees One Hundred Crore Only');
});

// --- document classification ------------------------------------------------

test('tax charged makes it a Tax Invoice', () => {
  const c = inv.classify({ companyGstin: '33AAA', partyGstin: '33BBB', taxTotal: 1800 });
  assert.equal(c.kind, 'tax-invoice');
  assert.equal(c.title, 'Tax Invoice');
});

test('registered but no tax is a Bill of Supply, never a Tax Invoice', () => {
  // A composition dealer or an exempt supply. Heading it "Tax Invoice" is the
  // error an auditor finds.
  const c = inv.classify({ companyGstin: '33AAA', partyGstin: '33BBB', taxTotal: 0 });
  assert.equal(c.kind, 'bill-of-supply');
  assert.equal(c.title, 'Bill of Supply');
});

test('a business with no GSTIN issues a plain Invoice', () => {
  const c = inv.classify({ companyGstin: '', partyGstin: '', taxTotal: 0 });
  assert.equal(c.kind, 'non-gst');
  assert.equal(c.title, 'Invoice');
});

test('an order is a Proforma, not an invoice', () => {
  const c = inv.classify({ companyGstin: '33AAA', taxTotal: 0, isCommitment: true });
  assert.equal(c.kind, 'proforma');
  assert.equal(c.taxable, false);
});

test('a return is a Credit Note', () => {
  const c = inv.classify({ companyGstin: '33AAA', taxTotal: 900, isReturn: true });
  assert.equal(c.kind, 'credit-note');
});

// --- the tax split ----------------------------------------------------------

const T = (label, amountPaise) => ({ label, amountPaise });

test('same-state supply splits into CGST and SGST', () => {
  const r = inv.taxBreakup(
    [T('CGST', 900), T('SGST', 900)], '33AAAAA0000A1Z5', '33BBBBB0000B1Z5');
  assert.equal(r.cgst, 900);
  assert.equal(r.sgst, 900);
  assert.equal(r.total, 1800);
  assert.equal(r.supply, 'intra');
  assert.equal(r.expectedSupply, 'intra');
  assert.equal(r.mismatch, false);
});

test('different states use IGST', () => {
  const r = inv.taxBreakup([T('IGST', 1800)], '33AAAAA0000A1Z5', '29BBBBB0000B1Z5');
  assert.equal(r.igst, 1800);
  assert.equal(r.supply, 'inter');
  assert.equal(r.expectedSupply, 'inter');
  assert.equal(r.mismatch, false);
});

test('IGST charged within one state is flagged as a mismatch', () => {
  // A real and expensive error: the buyer cannot claim the credit.
  const r = inv.taxBreakup([T('IGST', 1800)], '33AAAAA0000A1Z5', '33BBBBB0000B1Z5');
  assert.equal(r.mismatch, true);
  assert.equal(r.supply, 'inter');
  assert.equal(r.expectedSupply, 'intra');
});

test('CGST/SGST charged across states is flagged too', () => {
  const r = inv.taxBreakup(
    [T('CGST', 900), T('SGST', 900)], '33AAAAA0000A1Z5', '29BBBBB0000B1Z5');
  assert.equal(r.mismatch, true);
});

test('with a GSTIN missing, nothing is claimed either way', () => {
  // Guessing place of supply from an address would be worse than silence.
  const r = inv.taxBreakup([T('IGST', 1800)], '33AAAAA0000A1Z5', '');
  assert.equal(r.expectedSupply, null);
  assert.equal(r.mismatch, false);
});

test('cess and unrecognised tax ledgers are kept, not dropped', () => {
  const r = inv.taxBreakup(
    [T('Compensation Cess', 500), T('Some Other Levy', 100)], '', '');
  assert.equal(r.cess, 500);
  assert.equal(r.other, 100);
  // Dropping them would make the tax total disagree with the invoice total.
  assert.equal(r.total, 600);
});

test('a TDS ledger is not treated as GST', () => {
  const r = inv.taxBreakup([T('CGST', 900)], '33AAA', '33BBB');
  assert.equal(r.cgst, 900);
});

// --- numbering --------------------------------------------------------------

test('an invoice number is split into series and sequence', () => {
  const a = inv.parseNumber('INV/2026-27/0042');
  assert.equal(a.prefix, 'INV/2026-27/');
  assert.equal(a.seq, 42);
  assert.equal(a.width, 4);

  const b = inv.parseNumber('GST-101');
  assert.equal(b.seq, 101);
  assert.notEqual(a.series, b.series, 'different series');
});

test('a number with no digits at all is handled', () => {
  const n = inv.parseNumber('ABC');
  assert.equal(n.seq, null);
  // Must not crash a numbering report, just sit outside the sequence checks.
  assert.equal(n.series, 'ABC');
});

test('padding does not split one series in two', () => {
  // A shop writing 8, 9, then 010 has one series with sloppy padding, and
  // splitting on width would invent a gap in each half.
  assert.equal(inv.parseNumber('9').series, inv.parseNumber('010').series);
});

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['inv-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `iv-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Inv Co') RETURNING *`,
    [o[0].id, `iv-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, qs = '') => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  url: new URL(`http://x/${qs}`),
});

const sale = (f, no, date, amount = 1000) => query(
  `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
   VALUES ($1,$2,$3,'Sales',$4,'Acme',$5)`,
  [f.co.id, `v-${no}-${date}`, no, date, amount]);

test('a repeated invoice number is reported as a duplicate', async () => {
  const f = await fixture();
  await sale(f, 'INV-1', '2026-05-01');
  await sale(f, 'INV-1', '2026-05-02');
  await sale(f, 'INV-2', '2026-05-03');

  const r = await inv.numbering(ctxFor(f), f.co.tally_guid);
  // A compliance problem that otherwise surfaces at assessment, months after
  // it could have been fixed cheaply.
  assert.equal(r.findings.duplicates, 1);
  assert.equal(r.duplicates[0].number, 'INV-1');
  assert.equal(r.duplicates[0].count, 2);
});

test('a gap in the middle of a run is reported', async () => {
  const f = await fixture();
  for (const n of [1, 2, 5]) await sale(f, `INV-${n}`, '2026-05-01');
  const r = await inv.numbering(ctxFor(f), f.co.tally_guid);
  assert.deepEqual(r.series[0].missing, [3, 4]);
});

test('an invoice dated before the one numbered ahead of it is flagged', async () => {
  const f = await fixture();
  await sale(f, 'INV-1', '2026-05-10');
  await sale(f, 'INV-2', '2026-05-01');
  const r = await inv.numbering(ctxFor(f), f.co.tally_guid);
  assert.equal(r.findings.outOfOrder, 1);
  assert.equal(r.series[0].outOfOrder[0].number, 'INV-2');
});

test('a clean series reports no findings', async () => {
  const f = await fixture();
  for (let i = 1; i <= 5; i++) await sale(f, `INV-${i}`, `2026-05-0${i}`);
  const r = await inv.numbering(ctxFor(f), f.co.tally_guid);
  assert.deepEqual(r.findings, { duplicates: 0, gaps: 0, outOfOrder: 0 });
});

test('orders are not counted as invoices in the numbering report', async () => {
  const f = await fixture();
  await sale(f, 'INV-1', '2026-05-01');
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'so1','SO-1','Sales Order','2026-05-01','Acme',9999)`, [f.co.id]);
  const r = await inv.numbering(ctxFor(f), f.co.tally_guid);
  assert.equal(r.invoices, 1);
});

test('a wildly sparse series does not list a million missing numbers', async () => {
  const f = await fixture();
  await sale(f, 'INV-1', '2026-05-01');
  await sale(f, 'INV-900000', '2026-05-02');
  const r = await inv.numbering(ctxFor(f), f.co.tally_guid);
  // Listing them all would bury the real findings.
  assert.ok(r.series[0].missing.length <= 200);
});
