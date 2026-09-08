const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const gst = require('../src/routes/gst');
const { parseGstin, checkDigit, placeOfSupply } = require('../src/lib/gstin');

/**
 * GST, where a wrong figure is not just wrong - it is filed, and then it is
 * the customer's problem with the department.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

/** Build a structurally valid GSTIN for a state, so tests use real ones. */
const gstinFor = (state, pan = 'AAPFU0939F') => {
  const first14 = `${state}${pan}1Z`;
  return first14 + checkDigit(first14);
};

const TN = gstinFor('33');
const KA = gstinFor('29', 'AAGCB7383J');

// --- GSTIN ------------------------------------------------------------------

test('a published GSTIN validates', () => {
  const r = parseGstin('27AAPFU0939F1ZV');
  assert.equal(r.valid, true);
  assert.equal(r.stateName, 'Maharashtra');
  assert.equal(r.pan, 'AAPFU0939F');
  assert.equal(r.holderType, 'Firm');
});

test('every single-character typo is caught', () => {
  const good = '27AAPFU0939F1ZV';
  const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let slipped = 0;
  for (let i = 0; i < 15; i++) {
    for (const c of A) {
      if (c === good[i]) continue;
      if (parseGstin(good.slice(0, i) + c + good.slice(i + 1)).valid) slipped += 1;
    }
  }
  // A typo means the buyer cannot claim the credit, and nobody finds out until
  // the return is rejected.
  assert.equal(slipped, 0);
});

test('a wrong check digit says what was expected', () => {
  const r = parseGstin('27AAPFU0939F1ZA');
  assert.equal(r.valid, false);
  assert.equal(r.reason, 'checksum');
  // Naming the expected character makes a transcription error obvious.
  assert.match(r.message, /expected "V"/);
});

test('the wrong length, wrong shape and unknown state are told apart', () => {
  assert.equal(parseGstin('33AAAAA0000A1Z').reason, 'length');
  assert.equal(parseGstin('ABCDEFGHIJKLMNO').reason, 'shape');
  assert.equal(parseGstin(gstinFor('88')).reason, 'state');
  assert.equal(parseGstin('').reason, 'missing');
});

test('lowercase is accepted', () => {
  assert.equal(parseGstin('27aapfu0939f1zv').valid, true);
});

test('place of supply comes from the state codes', () => {
  assert.equal(placeOfSupply(TN, gstinFor('33', 'AAGCB7383J')), 'intra');
  assert.equal(placeOfSupply(TN, KA), 'inter');
  // Guessing from an address would be worse than saying nothing.
  assert.equal(placeOfSupply(TN, ''), null);
});

// --- tax ledger classification ---------------------------------------------

test('Tally tax ledger names map to return buckets', () => {
  assert.equal(gst.bucketOf('Output CGST'), 'cgst');
  assert.equal(gst.bucketOf('SGST Payable'), 'sgst');
  assert.equal(gst.bucketOf('IGST @ 18%'), 'igst');
  assert.equal(gst.bucketOf('Integrated Tax'), 'igst');
  assert.equal(gst.bucketOf('Compensation Cess'), 'cess');
  assert.equal(gst.bucketOf('Sales'), null);
});

test('TDS and TCS are not treated as GST', () => {
  // They are deductions, not output tax, and counting them would overstate
  // what is owed to the department.
  assert.equal(gst.bucketOf('TDS Payable'), null);
  assert.equal(gst.bucketOf('TCS on Sales'), null);
});

// --- the reports ------------------------------------------------------------

async function fixture(companyGstin = TN) {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['gst-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `g-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name, gstin, state)
     VALUES ($1,$2,'GST Co',$3,'Tamil Nadu') RETURNING *`,
    [o[0].id, `g-${o[0].id}`, companyGstin]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, qs = '?period=custom&from=2026-05-01&to=2026-05-31') => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  url: new URL(`http://x/${qs}`),
});

const party = (f, name, gstin, state = 'Tamil Nadu') => query(
  `INSERT INTO ledgers (company_id, guid, name, parent_group, gstin, state)
   VALUES ($1,$2,$3,'Sundry Debtors',$4,$5)`,
  [f.co.id, `l-${name}`, name, gstin, state]);

async function voucher(f, { no, type, partyName, taxable, taxes = {}, date = '2026-05-10' }) {
  const total = taxable + Object.values(taxes).reduce((a, b) => a + b, 0);
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [f.co.id, `v-${no}`, no, type, date, partyName, total]);
  const id = rows[0].id;
  await query(
    `INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise) VALUES ($1,$2,$3)`,
    [id, /purchase/i.test(type) ? 'Purchase Account' : 'Sales Account', taxable]);
  for (const [name, amt] of Object.entries(taxes)) {
    await query(
      `INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise) VALUES ($1,$2,$3)`,
      [id, name, amt]);
  }
  return id;
}

test('output and input tax net out into one position', async () => {
  const f = await fixture();
  await party(f, 'Buyer', gstinFor('33', 'AAGCB7383J'));
  await party(f, 'Seller', gstinFor('33', 'AABCS1429B'));

  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Buyer',
    taxable: 100000, taxes: { 'Output CGST': 9000, 'Output SGST': 9000 } });
  await voucher(f, { no: 'P1', type: 'Purchase', partyName: 'Seller',
    taxable: 50000, taxes: { 'Input CGST': 4500, 'Input SGST': 4500 } });

  const r = await gst.summary(ctxFor(f), f.co.tally_guid);
  assert.equal(r.outward.taxTotal, 18000);
  assert.equal(r.inward.taxTotal, 9000);
  // The only figure a business owner actually wants.
  assert.equal(r.position.outputTaxPaise, 18000);
  assert.equal(r.position.inputTaxPaise, 9000);
  assert.equal(r.position.netPaise, 9000);
  assert.equal(r.position.direction, 'payable');
});

test('more input than output reads as credit, not as a negative payable', async () => {
  const f = await fixture();
  await party(f, 'Seller', gstinFor('33', 'AABCS1429B'));
  await voucher(f, { no: 'P1', type: 'Purchase', partyName: 'Seller',
    taxable: 100000, taxes: { 'Input CGST': 9000, 'Input SGST': 9000 } });

  const r = await gst.summary(ctxFor(f), f.co.tally_guid);
  // Credit carried forward is a completely different conversation from a bill.
  assert.equal(r.position.direction, 'credit');
  assert.equal(r.position.netPaise, -18000);
});

test('a credit note reduces output tax', async () => {
  const f = await fixture();
  await party(f, 'Buyer', gstinFor('33', 'AAGCB7383J'));
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Buyer',
    taxable: 100000, taxes: { 'Output CGST': 9000, 'Output SGST': 9000 } });
  await voucher(f, { no: 'C1', type: 'Credit Note', partyName: 'Buyer',
    taxable: 50000, taxes: { 'Output CGST': 4500, 'Output SGST': 4500 } });

  const r = await gst.summary(ctxFor(f), f.co.tally_guid);
  assert.equal(r.creditNotes.count, 1);
  assert.equal(r.position.outputTaxPaise, 9000, '18000 less 9000');
});

test('B2B and B2C are split by whether the buyer has a GSTIN', async () => {
  const f = await fixture();
  await party(f, 'Registered', gstinFor('33', 'AAGCB7383J'));
  await party(f, 'Walk-in', '');
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Registered', taxable: 100000 });
  await voucher(f, { no: 'S2', type: 'Sales', partyName: 'Walk-in', taxable: 30000 });

  const r = await gst.summary(ctxFor(f), f.co.tally_guid);
  assert.equal(r.b2b.count, 1);
  assert.equal(r.b2c.count, 1);
  assert.equal(r.b2b.taxable, 100000);
});

test('the effective rate is derived from tax over taxable value', async () => {
  const f = await fixture();
  await party(f, 'Buyer', gstinFor('33', 'AAGCB7383J'));
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Buyer',
    taxable: 100000, taxes: { 'Output CGST': 9000, 'Output SGST': 9000 } });

  const r = await gst.summary(ctxFor(f), f.co.tally_guid);
  // Books that post through a control account carry no item and no stored
  // rate, so the rate that was actually applied has to be computed.
  assert.equal(r.byRate[0].ratePct, 18);
});

test('orders are not counted as supplies', async () => {
  const f = await fixture();
  await party(f, 'Buyer', gstinFor('33', 'AAGCB7383J'));
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Buyer', taxable: 100000 });
  await voucher(f, { no: 'O1', type: 'Sales Order', partyName: 'Buyer', taxable: 900000 });

  const r = await gst.summary(ctxFor(f), f.co.tally_guid);
  assert.equal(r.outward.count, 1);
  assert.equal(r.outward.taxable, 100000);
});

// --- health -----------------------------------------------------------------

test('a party GSTIN that fails the check digit is reported', async () => {
  const f = await fixture();
  await party(f, 'Typo Ltd', '33AAAAA0000A1Z5');   // wrong check digit
  const r = await gst.health(ctxFor(f), f.co.tally_guid);
  const finding = r.findings.find((x) => x.key === 'party-gstin');
  assert.equal(finding.count, 1);
  assert.equal(finding.items[0].name, 'Typo Ltd');
});

test('IGST charged within one state is reported', async () => {
  const f = await fixture();
  await party(f, 'Local', gstinFor('33', 'AAGCB7383J'));
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Local',
    taxable: 100000, taxes: { 'Output IGST': 18000 } });

  const r = await gst.health(ctxFor(f), f.co.tally_guid);
  const finding = r.findings.find((x) => x.key === 'wrong-split');
  // The buyer cannot claim the credit against this.
  assert.equal(finding.count, 1);
  assert.equal(finding.items[0].expected, 'intra');
  assert.equal(finding.items[0].actual, 'inter');
});

test('CGST/SGST charged across states is reported', async () => {
  const f = await fixture();
  await party(f, 'Bangalore Co', KA, 'Karnataka');
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Bangalore Co',
    taxable: 100000, taxes: { 'Output CGST': 9000, 'Output SGST': 9000 } });

  const r = await gst.health(ctxFor(f), f.co.tally_guid);
  assert.equal(r.findings.find((x) => x.key === 'wrong-split').count, 1);
});

test('a correct intra-state split raises nothing', async () => {
  const f = await fixture();
  await party(f, 'Local', gstinFor('33', 'AAGCB7383J'));
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Local',
    taxable: 100000, taxes: { 'Output CGST': 9000, 'Output SGST': 9000 } });

  const r = await gst.health(ctxFor(f), f.co.tally_guid);
  assert.equal(r.findings.find((x) => x.key === 'wrong-split').count, 0);
  assert.equal(r.findings.find((x) => x.key === 'uneven-split').count, 0);
});

test('CGST and SGST that do not match are flagged', async () => {
  const f = await fixture();
  await party(f, 'Local', gstinFor('33', 'AAGCB7383J'));
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Local',
    taxable: 100000, taxes: { 'Output CGST': 9000, 'Output SGST': 8000 } });

  const r = await gst.health(ctxFor(f), f.co.tally_guid);
  assert.equal(r.findings.find((x) => x.key === 'uneven-split').count, 1);
});

test('a missing company GSTIN is the first thing reported', async () => {
  const f = await fixture('');
  const r = await gst.health(ctxFor(f), f.co.tally_guid);
  const own = r.findings.find((x) => x.key === 'own-gstin');
  assert.equal(own.count, 1);
  assert.match(own.detail, /Not set in Tally/);
});

test('taxable sales to a party with no GSTIN are surfaced', async () => {
  const f = await fixture();
  await party(f, 'Unregistered', '');
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Unregistered',
    taxable: 100000, taxes: { 'Output CGST': 9000, 'Output SGST': 9000 } });

  const r = await gst.health(ctxFor(f), f.co.tally_guid);
  const finding = r.findings.find((x) => x.key === 'missing-buyer-gstin');
  assert.equal(finding.count, 1);
  assert.equal(finding.items[0].party, 'Unregistered');
});

test('a clean set of books reports only what is genuinely wrong', async () => {
  const f = await fixture();
  await party(f, 'Local', gstinFor('33', 'AAGCB7383J'));
  await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Local',
    taxable: 100000, taxes: { 'Output CGST': 9000, 'Output SGST': 9000 } });

  const r = await gst.health(ctxFor(f), f.co.tally_guid);
  assert.equal(r.total, 0);
});

test('HSN summary reports what has no HSN rather than hiding it', async () => {
  const f = await fixture();
  await party(f, 'Buyer', gstinFor('33', 'AAGCB7383J'));
  const id = await voucher(f, { no: 'S1', type: 'Sales', partyName: 'Buyer', taxable: 100000 });
  await query(
    `INSERT INTO stock_items (company_id, guid, name, unit, hsn, gst_rate_bp)
     VALUES ($1,'i1','Cement','Bag','25232910',1800), ($1,'i2','Odds','Nos','',0)`, [f.co.id]);
  await query(
    `INSERT INTO voucher_items (voucher_id, item_name, qty, rate_paise, amount_paise)
     VALUES ($1,'Cement',10,5000,50000), ($1,'Odds',5,10000,50000)`, [id]);

  const r = await gst.hsn(ctxFor(f), f.co.tally_guid);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].hsn, '25232910');
  // A return needs HSN on every line above the threshold; a missing one is a
  // rejection, so it is counted rather than quietly dropped.
  assert.equal(r.missingHsn.lines, 1);
  assert.equal(r.missingHsn.valuePaise, 50000);
});

test('GST reports never cross company boundaries', async () => {
  const a = await fixture();
  const b = await fixture();
  await assert.rejects(
    () => gst.summary(ctxFor(b), a.co.tally_guid), (e) => e.status === 404);
});
