const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const doc = require('../src/lib/doctemplate');
const company = require('../src/routes/company');
const invoices = require('../src/routes/invoices');

/**
 * How a shop's documents look.
 *
 * The defaults are a complete, correct tax invoice — a shop that never opens
 * the settings screen must still print something an auditor accepts.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture(fields = {}) {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['dt-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `dt-${o[0].id.slice(0, 8)}@example.com`]);
  const cols = Object.keys(fields);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name${cols.length ? ', ' + cols.join(', ') : ''})
     VALUES ($1,$2,'DT Co'${cols.map((_, i) => `, $${i + 3}`).join('')}) RETURNING *`,
    [o[0].id, `dt-${o[0].id}`, ...cols.map((k) => fields[k])]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, body = {}) => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  url: new URL('http://x/'), body,
});

// --- defaults ---------------------------------------------------------------

test('a company that changes nothing gets a complete tax invoice', async () => {
  const f = await fixture();
  const t = doc.templateOf(f.co);
  // Every block a compliant document needs is on by default.
  for (const k of ['sellerGstin', 'buyerGstin', 'hsn', 'taxBreakup', 'inWords']) {
    assert.equal(t.show[k], true, `${k} defaults on`);
  }
  assert.equal(t.page.label, 'A4');
  assert.equal(t.page.widthMm, 210);
});

test('landscape swaps the page dimensions once, here', async () => {
  const f = await fixture({ doc_orientation: 'landscape' });
  const t = doc.templateOf(f.co);
  // Swapped in one place so no consumer has to remember to.
  assert.equal(t.page.widthMm, 297);
  assert.equal(t.page.heightMm, 210);
});

test('a thermal roll is always dense, whatever was chosen', async () => {
  const f = await fixture({ doc_page_size: 'thermal', doc_dense: false });
  const t = doc.templateOf(f.co);
  // 80mm of paper cannot hold a spaced-out A4 layout.
  assert.equal(t.type.dense, true);
  assert.equal(t.page.widthMm, 80);
});

test('a custom size is honoured', async () => {
  const f = await fixture({ doc_page_size: 'custom', doc_width_mm: 120, doc_height_mm: 180 });
  const t = doc.templateOf(f.co);
  assert.equal(t.page.widthMm, 120);
  assert.equal(t.page.heightMm, 180);
});

test('turning one block off leaves the rest on', async () => {
  const f = await fixture({ doc_show: JSON.stringify({ hsnSummary: false }) });
  const t = doc.templateOf(f.co);
  assert.equal(t.show.hsnSummary, false);
  assert.equal(t.show.inWords, true, 'not mentioned means unchanged');
});

// --- validation -------------------------------------------------------------

test('a colour must be hex, because it goes into a style attribute', () => {
  assert.throws(() => doc.validate({ accent: 'red' }), (e) => e.status === 400);
  assert.throws(() => doc.validate({ accent: '#fff' }), (e) => e.status === 400);
  // Anything else is either a mistake or an attempt to smuggle CSS in.
  assert.throws(() => doc.validate({ accent: 'red;position:fixed' }), (e) => e.status === 400);
  assert.deepEqual(doc.validate({ accent: '#1F2937' }), { doc_accent: '#1F2937' });
});

test('sizes and margins are bounded', () => {
  for (const bad of [{ fontSize: 40 }, { fontSize: 2 }, { marginMm: 90 }, { widthMm: 5 }]) {
    assert.throws(() => doc.validate(bad), (e) => e.status === 400);
  }
});

test('an unknown block is refused rather than silently stored', () => {
  assert.throws(() => doc.validate({ show: { wibble: true } }),
    (e) => e.status === 400 && /wibble/.test(e.message));
});

test('an unknown page size or font is refused', () => {
  assert.throws(() => doc.validate({ pageSize: 'scroll' }), (e) => e.status === 400);
  assert.throws(() => doc.validate({ font: 'comic' }), (e) => e.status === 400);
});

// --- UPI --------------------------------------------------------------------

test('a UPI id is checked, because a bad QR fails at the counter', () => {
  for (const good of ['shop@okhdfcbank', '9876543210@paytm', 'a.b-c_1@ybl']) {
    assert.ok(doc.UPI_SHAPE.test(good), good);
  }
  for (const bad of ['nonsense', 'a@b', '@bank', 'shop@', 'shop bank@x']) {
    assert.ok(!doc.UPI_SHAPE.test(bad), bad);
  }
  assert.throws(() => doc.validate({ upiId: 'nonsense' }),
    (e) => e.status === 400 && /name@bank/.test(e.message));
});

test('a UPI QR carries the amount, so nobody types it wrong', async () => {
  const qr = await doc.upiQr({
    upiId: 'shop@okhdfcbank', payeeName: 'Shop', amountPaise: 150075, note: 'INV-1' });
  assert.ok(qr.dataUri.startsWith('data:image/png;base64,'));
  // Rupees with two decimals, not paise.
  assert.equal(qr.amount, '1500.75');
});

test('no UPI id means no QR, not a broken one', async () => {
  assert.equal(await doc.upiQr({ upiId: '', amountPaise: 100 }), null);
  assert.equal(await doc.upiQr({ upiId: 'rubbish', amountPaise: 100 }), null);
});

test('clearing the UPI id is allowed', () => {
  assert.deepEqual(doc.validate({ upiId: '' }), { upi_id: '' });
});

// --- through the API --------------------------------------------------------

test('settings round-trip through the endpoint', async () => {
  const f = await fixture();
  const r = await company.updateDocTemplate(ctxFor(f, {
    pageSize: 'a5', font: 'serif', fontSize: 11, accent: '#0E7A47',
    upiId: 'shop@okhdfcbank', terms: 'Payment within 30 days.',
    show: { hsnSummary: false },
  }), f.co.tally_guid);

  assert.equal(r.template.page.label, 'A5');
  assert.equal(r.template.type.font, 'serif');
  assert.equal(r.template.upiId, 'shop@okhdfcbank');
  assert.equal(r.template.show.hsnSummary, false);
  assert.equal(r.template.text.terms, 'Payment within 30 days.');
});

test('an empty update is refused rather than doing nothing quietly', async () => {
  const f = await fixture();
  await assert.rejects(
    () => company.updateDocTemplate(ctxFor(f, {}), f.co.tally_guid),
    (e) => e.status === 400);
});

test('the invoice carries the template and a QR when there is a UPI id', async () => {
  const f = await fixture({ upi_id: 'shop@okhdfcbank', bank_name: 'HDFC' });
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'v1','1','Sales','2026-05-01','Acme',150000) RETURNING id`, [f.co.id]);

  const d = await invoices.document(ctxFor(f), f.co.tally_guid, rows[0].id);
  assert.equal(d.template.page.label, 'A4');
  assert.equal(d.seller.bank.name, 'HDFC');
  assert.ok(d.upiQr.dataUri.startsWith('data:image/png'));
  assert.equal(d.upiQr.amount, '1500.00');
});

test('turning the QR block off removes it from the invoice', async () => {
  const f = await fixture({
    upi_id: 'shop@okhdfcbank', doc_show: JSON.stringify({ upiQr: false }) });
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'v1','1','Sales','2026-05-01','Acme',150000) RETURNING id`, [f.co.id]);
  const d = await invoices.document(ctxFor(f), f.co.tally_guid, rows[0].id);
  assert.equal(d.upiQr, null);
});

// --- discount ---------------------------------------------------------------

test('a discount is derived from quantity times rate less the line amount', async () => {
  const f = await fixture();
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'v1','1','Sales','2026-05-01','Acme',90000) RETURNING id`, [f.co.id]);
  await query(
    `INSERT INTO voucher_items (voucher_id, item_name, qty, rate_paise, amount_paise)
     VALUES ($1,'Widget',10,10000,90000)`, [rows[0].id]);

  const d = await invoices.document(ctxFor(f), f.co.tally_guid, rows[0].id);
  assert.equal(d.lines[0].grossPaise, 100000);
  assert.equal(d.lines[0].discountPaise, 10000);
  assert.equal(d.totals.discountPaise, 10000);
});

test('a paisa of floating-point noise is not shown as a discount', async () => {
  const f = await fixture();
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'v1','1','Sales','2026-05-01','Acme',33333) RETURNING id`, [f.co.id]);
  // 3 x 111.11 leaves a rounding remainder on almost every real invoice.
  await query(
    `INSERT INTO voucher_items (voucher_id, item_name, qty, rate_paise, amount_paise)
     VALUES ($1,'Widget',3,11111,33333)`, [rows[0].id]);

  const d = await invoices.document(ctxFor(f), f.co.tally_guid, rows[0].id);
  assert.equal(d.lines[0].discountPaise, 0);
});
