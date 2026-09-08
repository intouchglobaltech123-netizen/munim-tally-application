const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const kpi = require('../src/routes/kpi');

/**
 * The numbers a business is run on.
 *
 * The tests care about two things above accuracy: that a figure is never
 * invented when the data cannot support it, and that an approximation is
 * labelled as one. A wrong KPI is worse than a missing one, because somebody
 * prices their stock on it.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function shop() {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('kpi-test','internal') RETURNING *`);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `kpi-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'KPI Books') RETURNING *`,
    [o[0].id, `kpi-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, qs = '') => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  req: { headers: {}, socket: {} },
  url: new URL(`http://x/${qs}`), body: {},
});

let seq = 0;
async function voucher(f, { type = 'Sales', date, party = 'A', amount = 100000 }) {
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,$3,$4,$5::date,$6,$7) RETURNING id`,
    [f.co.id, `kv-${f.co.id}-${seq}`, String(++seq), type, date, party, amount]);
  return rows[0].id;
}

const FY = '?from=2026-04-01&to=2027-03-31';

// --- sales ------------------------------------------------------------------

test('revenue, invoice count and average invoice agree with each other', async () => {
  const f = await shop();
  await voucher(f, { date: '2026-05-01', amount: 100000 });
  await voucher(f, { date: '2026-06-01', amount: 300000 });

  const s = await kpi.sales(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(s.revenuePaise, 400000);
  assert.equal(s.invoices, 2);
  assert.equal(s.averageInvoicePaise, 200000);
});

test('an order is not revenue', async () => {
  // "Sales Order" matches '%sale%'. Counting commitments as revenue is the bug
  // that made the dashboard overstate a whole year.
  const f = await shop();
  await voucher(f, { date: '2026-05-01', type: 'Sales Order', amount: 900000 });
  const s = await kpi.sales(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(s.revenuePaise, 0);
});

test('a credit note is not revenue either', async () => {
  const f = await shop();
  await voucher(f, { date: '2026-05-01', type: 'Sales Return', amount: 500000 });
  assert.equal((await kpi.sales(ctxFor(f, FY), f.co.tally_guid)).revenuePaise, 0);
});

test('growth is withheld when there is no prior year to compare with', async () => {
  /*
   * A percentage against a base of zero is either Infinity or a made-up
   * number, and "+100% growth" on a first-year business is a lie either way.
   */
  const f = await shop();
  await voucher(f, { date: '2026-05-01', amount: 100000 });
  const s = await kpi.sales(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(s.growthPercent, null);
});

test('growth is computed against the same window a year earlier', async () => {
  const f = await shop();
  await voucher(f, { date: '2025-05-01', amount: 100000 });   // prior year
  await voucher(f, { date: '2026-05-01', amount: 150000 });   // this year
  const s = await kpi.sales(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(s.growthPercent, 50);
});

test('customer concentration is reported, because a lender asks for it', async () => {
  const f = await shop();
  await voucher(f, { date: '2026-05-01', party: 'Big Co', amount: 800000 });
  await voucher(f, { date: '2026-05-02', party: 'Small Co', amount: 200000 });

  const s = await kpi.sales(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(s.topCustomers[0].party, 'Big Co');
  assert.equal(s.concentration.topCustomerPercent, 80);
});

test('salesperson performance says it is unavailable rather than showing nothing', async () => {
  // A missing section reads as "we have no sales staff", which is a different
  // and wrong answer.
  const f = await shop();
  const s = await kpi.sales(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(s.salespeople.available, false);
  assert.match(s.salespeople.note, /cost centres/);
});

// --- collection -------------------------------------------------------------

test('receivables come from the netted view, not from raw allocations', async () => {
  /*
   * `bills` holds one row per allocation - the invoice and every receipt
   * against it. Summing it directly overstated receivables by 94%.
   */
  const f = await shop();
  const inv = await voucher(f, { date: '2026-05-01', amount: 100000 });
  const rec = await voucher(f, { date: '2026-05-20', type: 'Receipt', amount: -60000 });
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date,
                        amount_paise, bill_type)
     VALUES ($1,$2,'INV-1','A','2026-05-01','2026-06-01',100000,'New Ref'),
            ($1,$3,'INV-1','A','2026-05-20',NULL,-60000,'Agst Ref')`,
    [f.co.id, inv, rec]);

  const c = await kpi.collection(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(c.receivablePaise, 40000, 'the receipt was netted off');
});

test('average payment days is measured only on bills that were settled', async () => {
  /*
   * Including unsettled bills flatters the number early in their life and
   * ruins it later, and it would move every day without anything happening.
   */
  const f = await shop();
  const inv = await voucher(f, { date: '2026-05-01', amount: 100000 });
  const rec = await voucher(f, { date: '2026-05-11', type: 'Receipt', amount: -100000 });
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, amount_paise, bill_type)
     VALUES ($1,$2,'INV-2','A','2026-05-01',100000,'New Ref'),
            ($1,$3,'INV-2','A','2026-05-11',-100000,'Agst Ref')`,
    [f.co.id, inv, rec]);

  const c = await kpi.collection(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(c.averagePaymentDays, 10);
  assert.match(c.averagePaymentBasis, /1 settled bill/);
});

test('average payment days is withheld when nothing has been settled', async () => {
  const f = await shop();
  const c = await kpi.collection(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(c.averagePaymentDays, null);
  assert.match(c.averagePaymentBasis, /No bills/);
});

test('the collection rate says what it actually measures', async () => {
  // Receipts land against older invoices too, so it can exceed 100% and that
  // is not a bug.
  const f = await shop();
  await voucher(f, { date: '2026-05-01', amount: 100000 });
  const c = await kpi.collection(ctxFor(f, FY), f.co.tally_guid);
  assert.match(c.collectionRateNote, /can exceed 100%/);
});

test('DSO is null rather than infinite when nothing was sold', async () => {
  const f = await shop();
  const c = await kpi.collection(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(c.dsoDays, null);
});

// --- purchases --------------------------------------------------------------

test('supplier concentration warns when one supplier dominates', async () => {
  const f = await shop();
  await voucher(f, { date: '2026-05-01', type: 'Purchase', party: 'Only Supplier',
                     amount: 900000 });
  await voucher(f, { date: '2026-05-02', type: 'Purchase', party: 'Other',
                     amount: 100000 });

  const p = await kpi.purchases(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(p.amountPaise, 1000000);
  assert.equal(p.concentration.topSupplierPercent, 90);
  assert.match(p.concentration.warning, /Only Supplier/);
});

test('a purchase order is not a purchase', async () => {
  const f = await shop();
  await voucher(f, { date: '2026-05-01', type: 'Purchase Order', amount: 500000 });
  assert.equal((await kpi.purchases(ctxFor(f, FY), f.co.tally_guid)).amountPaise, 0);
});

// --- inventory --------------------------------------------------------------

test('dead stock is what is held and did not sell in the window', async () => {
  const f = await shop();
  await query(
    `INSERT INTO stock_items (company_id, guid, name, closing_qty, closing_value_paise)
     VALUES ($1,$2,'Moved',10,50000), ($1,$3,'Stuck',5,25000)`,
    [f.co.id, `si-${f.co.id}-1`, `si-${f.co.id}-2`]);

  const v = await voucher(f, { date: '2026-05-01', amount: 60000 });
  await query(
    `INSERT INTO voucher_items (voucher_id, item_name, qty, rate_paise, amount_paise)
     VALUES ($1,'Moved',2,30000,60000)`, [v]);

  const i = await kpi.inventory(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(i.deadStock.count, 1);
  assert.equal(i.deadStock.items[0].item, 'Stuck');
  assert.equal(i.deadStock.valuePaise, 25000);
});

test('negative stock is explained as a data problem, not a shelf problem', async () => {
  /*
   * Something was sold that was never entered as bought. Sending the owner to
   * look for goods that are physically there wastes their afternoon.
   */
  const f = await shop();
  await query(
    `INSERT INTO stock_items (company_id, guid, name, closing_qty, closing_value_paise)
     VALUES ($1,$2,'Oversold',-3,-1500)`, [f.co.id, `sn-${f.co.id}`]);

  const i = await kpi.inventory(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(i.negativeStock.count, 1);
  assert.match(i.negativeStock.note, /never entered as purchased/);
});

test('stock turnover is labelled as sales-based, not cost-based', async () => {
  // Munim has no item cost, so the figure is optimistic by the whole margin.
  // Presenting it as true turnover would be a pricing decision made on fiction.
  const f = await shop();
  const i = await kpi.inventory(ctxFor(f, FY), f.co.tally_guid);
  assert.match(i.turnoverNote, /does not hold.*cost/i);
});

test('low stock uses the reorder level Tally already holds', async () => {
  const f = await shop();
  await query(
    `INSERT INTO stock_items (company_id, guid, name, closing_qty,
                              closing_value_paise, reorder_level)
     VALUES ($1,$2,'Running out',2,1000,10), ($1,$3,'Plenty',100,50000,10)`,
    [f.co.id, `lo-${f.co.id}-1`, `lo-${f.co.id}-2`]);

  const i = await kpi.inventory(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(i.lowStock, 1);
});

// --- profitability ----------------------------------------------------------

test('gross profit is named as trading margin, with the caveat attached', async () => {
  /*
   * A true gross profit needs opening and closing stock. Presenting trading
   * margin as gross profit is how somebody prices their stock on a number that
   * was never real.
   */
  const f = await shop();
  await voucher(f, { date: '2026-05-01', amount: 500000 });
  await voucher(f, { date: '2026-05-02', type: 'Purchase', amount: 300000 });

  const p = await kpi.profitability(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(p.grossProfitPaise, 200000);
  assert.equal(p.grossMarginPercent, 40);
  assert.equal(p.reliable, false);
  assert.match(p.basis, /opening and closing stock/);
});

test('expenses are classified by the ledger group, not by guessing at names', async () => {
  const f = await shop();
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group)
     VALUES ($1,$2,'Shop Rent','Indirect Expenses')`, [f.co.id, `lg-${f.co.id}`]);

  await voucher(f, { date: '2026-05-01', amount: 500000 });
  const pay = await voucher(f, { date: '2026-05-05', type: 'Payment', amount: 50000 });
  await query(
    `INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise)
     VALUES ($1,'Shop Rent',50000)`, [pay]);

  const p = await kpi.profitability(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(p.indirectExpensesPaise, 50000);
  assert.equal(p.netProfitPaise, 450000);
  assert.equal(p.expenseRatioPercent, 10);
});

test('margins are null rather than NaN when nothing was sold', async () => {
  const f = await shop();
  const p = await kpi.profitability(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(p.grossMarginPercent, null);
  assert.equal(p.netMarginPercent, null);
});

// --- the whole set ----------------------------------------------------------

test('every KPI section can be fetched at once', async () => {
  const f = await shop();
  const all = await kpi.all(ctxFor(f, FY), f.co.tally_guid);
  for (const k of ['sales', 'collection', 'purchases', 'inventory', 'profitability']) {
    assert.ok(all[k], `${k} is missing`);
  }
});

test('the default window is the Indian financial year', async () => {
  const f = await shop();
  const s = await kpi.sales(ctxFor(f), f.co.tally_guid);
  assert.match(s.period.label, /^FY \d{4}-\d{2}$/);
  assert.match(s.period.from, /-04-01$/);
  assert.match(s.period.to, /-03-31$/);
});

test('a KPI cannot be read across businesses', async () => {
  const a = await shop();
  const b = await shop();
  await assert.rejects(() => kpi.sales(ctxFor(b, FY), a.co.tally_guid),
    (e) => e.status === 404);
});

test('"Indirect Expenses" is not also counted as a direct expense', async () => {
  /*
   * '%direct exp%' matches "Indirect Expenses" too, so every indirect expense
   * landed in both buckets and net profit came out short by exactly the
   * expense. The pattern has to be anchored.
   */
  const f = await shop();
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group)
     VALUES ($1,$2,'Rent','Indirect Expenses')`, [f.co.id, `dbl-${f.co.id}`]);
  const pay = await voucher(f, { date: '2026-05-05', type: 'Payment', amount: 10000 });
  await query(
    `INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise)
     VALUES ($1,'Rent',10000)`, [pay]);

  const p = await kpi.profitability(ctxFor(f, FY), f.co.tally_guid);
  assert.equal(p.indirectExpensesPaise, 10000);
  assert.equal(p.directExpensesPaise, 0, 'it was counted in both buckets');
});
