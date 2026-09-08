const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const masters = require('../src/routes/masters');

/**
 * The masters are read from Tally and never written back, so what is worth
 * testing is the classification: which group a ledger really belongs to, and
 * which items a shop has to act on.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['mast-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `m-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Mast Co') RETURNING *`,
    [o[0].id, `g-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, qs = '', body = {}) => ({
  session: {
    org: { id: f.orgId, name: 'Mast Co' },
    user: { id: f.userId, role: 'owner', roleId: null },
  },
  url: new URL(`http://x/${qs}`), body,
});

const ledger = (f, name, group, closing = 0, extra = {}) => query(
  `INSERT INTO ledgers (company_id, guid, name, parent_group, closing_paise,
                        gstin, phone, credit_limit_paise, credit_days)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [f.co.id, `l-${name}`, name, group, closing,
   extra.gstin ?? '', extra.phone ?? '', extra.creditLimit ?? 0, extra.creditDays ?? 0]);

const grp = (f, name, parent) => query(
  `INSERT INTO groups (company_id, guid, name, parent, primary_group)
   VALUES ($1,$2,$3,$4,'')`, [f.co.id, `g-${name}`, name, parent]);

const item = (f, name, qty, value, extra = {}) => query(
  `INSERT INTO stock_items (company_id, guid, name, unit, closing_qty, closing_value_paise,
                            parent_group, category, hsn, gst_rate_bp, reorder_level)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [f.co.id, `i-${name}`, name, extra.unit ?? 'Nos', qty, value,
   extra.group ?? '', extra.category ?? '', extra.hsn ?? '',
   extra.gstBp ?? 0, extra.reorder ?? 0]);

// --- the group tree ---------------------------------------------------------

test('a ledger in a shop\'s own group is still classified correctly', async () => {
  const f = await fixture();
  // The bug this exists to prevent: a business that files buyers under a group
  // it invented had those ledgers drop out of the balance sheet in silence.
  await grp(f, 'Local Customers', 'Regional Buyers');
  await grp(f, 'Regional Buyers', 'Sundry Debtors');
  await ledger(f, 'Corner Shop', 'Local Customers', 5000);

  const r = await masters.parties(ctxFor(f), f.co.tally_guid);
  const p = r.parties.find((x) => x.name === 'Corner Shop');
  assert.equal(p.nature, 'asset');
});

test('a group tree that loops terminates instead of hanging', async () => {
  const f = await fixture();
  // Tally allows this after a bad import, and an unguarded walk would hang the
  // report rather than merely get it wrong.
  await grp(f, 'Loop A', 'Loop B');
  await grp(f, 'Loop B', 'Loop A');
  await ledger(f, 'Odd One', 'Loop A', 100);

  const r = await masters.parties(ctxFor(f), f.co.tally_guid);
  assert.equal(r.parties.find((x) => x.name === 'Odd One').nature, 'other');
});

test('an unresolvable group reports other rather than guessing', async () => {
  const f = await fixture();
  await ledger(f, 'Mystery', 'Nowhere', 100);
  const r = await masters.parties(ctxFor(f), f.co.tally_guid);
  // A ledger in the wrong half of a balance sheet is worse than one visibly
  // unclassified.
  assert.equal(r.parties.find((x) => x.name === 'Mystery').nature, 'other');
});

// --- parties ----------------------------------------------------------------

test('customers and suppliers are told apart', async () => {
  const f = await fixture();
  await ledger(f, 'Buyer', 'Sundry Debtors', 5000);
  await ledger(f, 'Seller', 'Sundry Creditors', -3000);

  const cust = await masters.parties(ctxFor(f, '?kind=customer'), f.co.tally_guid);
  const supp = await masters.parties(ctxFor(f, '?kind=supplier'), f.co.tally_guid);
  assert.equal(cust.parties.length, 1);
  assert.equal(cust.parties[0].kind, 'customer');
  assert.equal(supp.parties[0].kind, 'supplier');
});

test('totals split what you are owed from what you owe', async () => {
  const f = await fixture();
  await ledger(f, 'Buyer', 'Sundry Debtors', 5000);
  await ledger(f, 'Seller', 'Sundry Creditors', -3000);
  const r = await masters.parties(ctxFor(f), f.co.tally_guid);
  assert.equal(r.totals.owedToYouPaise, 5000);
  assert.equal(r.totals.youOwePaise, 3000);
});

test('search covers name, GSTIN and phone', async () => {
  const f = await fixture();
  await ledger(f, 'Acme Traders', 'Sundry Debtors', 100,
    { gstin: '33AAAAA0000A1Z5', phone: '9876543210' });
  await ledger(f, 'Other', 'Sundry Debtors', 100);

  // An owner remembers whichever of the three they last used; making them pick
  // a field first is a barrier.
  for (const q of ['acme', '33AAAAA', '98765']) {
    const r = await masters.parties(ctxFor(f, `?q=${encodeURIComponent(q)}`), f.co.tally_guid);
    assert.equal(r.parties.length, 1, `searching ${q}`);
    assert.equal(r.parties[0].name, 'Acme Traders');
  }
});

test('a party over its credit limit is flagged', async () => {
  const f = await fixture();
  await ledger(f, 'Stretched', 'Sundry Debtors', 60000, { creditLimit: 50000 });
  await ledger(f, 'Within', 'Sundry Debtors', 10000, { creditLimit: 50000 });
  await ledger(f, 'NoLimit', 'Sundry Debtors', 99999, { creditLimit: 0 });

  const r = await masters.parties(ctxFor(f), f.co.tally_guid);
  const by = Object.fromEntries(r.parties.map((p) => [p.name, p]));
  // The single fact that decides whether to sell to somebody today.
  assert.equal(by.Stretched.overLimit, true);
  assert.equal(by.Within.overLimit, false);
  // No limit set is not the same as a limit of zero.
  assert.equal(by.NoLimit.overLimit, false);
});

test('a party detail carries every history a screen needs', async () => {
  const f = await fixture();
  await ledger(f, 'Acme', 'Sundry Debtors', 5000);
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'v1','1','Sales','2026-05-01','Acme',3000),
            ($1,'v2','2','Receipt','2026-05-10','Acme',1000),
            ($1,'v3','3','Purchase','2026-05-05','Acme',500)`, [f.co.id]);

  const d = await masters.party(ctxFor(f), f.co.tally_guid, 'Acme');
  assert.equal(d.salesHistory.length, 1);
  assert.equal(d.receiptHistory.length, 1);
  assert.equal(d.purchaseHistory.length, 1);
  assert.equal(d.monthly.length, 1);
});

test('a party is found however it is capitalised', async () => {
  const f = await fixture();
  await ledger(f, 'Acme Traders', 'Sundry Debtors', 100);
  const d = await masters.party(ctxFor(f), f.co.tally_guid, 'acme traders');
  assert.equal(d.party.name, 'Acme Traders');
});

test('an unknown party is a 404, not an empty screen', async () => {
  const f = await fixture();
  await assert.rejects(
    () => masters.party(ctxFor(f), f.co.tally_guid, 'Nobody'), (e) => e.status === 404);
});

// --- tags -------------------------------------------------------------------

test('tags are Munim\'s own and survive a sync from Tally', async () => {
  const f = await fixture();
  await ledger(f, 'Acme', 'Sundry Debtors', 100);
  await masters.setTags(ctxFor(f, '', { tags: ['wholesale', 'pays late'] }),
    f.co.tally_guid, 'Acme');

  // Exactly what ingest does when Tally reports this ledger again.
  await query(
    `UPDATE ledgers SET closing_paise = 999 WHERE company_id = $1 AND name = 'Acme'`, [f.co.id]);

  const r = await masters.parties(ctxFor(f), f.co.tally_guid);
  assert.deepEqual(r.parties[0].tags, ['wholesale', 'pays late']);
});

test('tags are de-duplicated, trimmed and capped', async () => {
  const f = await fixture();
  await ledger(f, 'Acme', 'Sundry Debtors', 100);
  const r = await masters.setTags(
    ctxFor(f, '', { tags: ['  a  ', 'a', 'b', '', ...Array(20).fill('x').map((_, i) => `t${i}`)] }),
    f.co.tally_guid, 'Acme');
  assert.ok(r.tags.length <= 12);
  assert.equal(new Set(r.tags).size, r.tags.length);
  assert.ok(!r.tags.includes(''));
});

test('parties can be filtered by tag', async () => {
  const f = await fixture();
  await ledger(f, 'Acme', 'Sundry Debtors', 100);
  await ledger(f, 'Other', 'Sundry Debtors', 100);
  await masters.setTags(ctxFor(f, '', { tags: ['wholesale'] }), f.co.tally_guid, 'Acme');

  const r = await masters.parties(ctxFor(f, '?tag=wholesale'), f.co.tally_guid);
  assert.equal(r.parties.length, 1);
  assert.equal(r.parties[0].name, 'Acme');
});

// --- items ------------------------------------------------------------------

test('items are classified into the states a shop acts on', async () => {
  const f = await fixture();
  await item(f, 'Healthy', 50, 500000);
  await item(f, 'Empty', 0, 0);
  await item(f, 'Oversold', -5, -50000);
  await item(f, 'Low', 3, 30000, { reorder: 10 });

  const r = await masters.items(ctxFor(f), f.co.tally_guid);
  const by = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.equal(by.Healthy.status, 'ok');
  assert.equal(by.Empty.status, 'out');
  assert.equal(by.Oversold.status, 'negative');
  assert.equal(by.Low.status, 'reorder');

  assert.equal(r.totals.negative, 1);
  assert.equal(r.totals.outOfStock, 1);
  assert.equal(r.totals.belowReorder, 1);
});

test('negative stock outranks a reorder warning', async () => {
  const f = await fixture();
  // Negative stock is a bookkeeping fault; below-reorder is a purchasing
  // decision. The fault has to win, or it hides behind routine noise.
  await item(f, 'Both', -2, -1000, { reorder: 10 });
  const r = await masters.items(ctxFor(f), f.co.tally_guid);
  assert.equal(r.items[0].status, 'negative');
});

test('items can be filtered by status, group and category', async () => {
  const f = await fixture();
  await item(f, 'A', 10, 1000, { group: 'Cement', category: 'Building' });
  await item(f, 'B', -1, -100, { group: 'Wires', category: 'Electrical' });

  assert.equal((await masters.items(ctxFor(f, '?status=negative'), f.co.tally_guid)).items.length, 1);
  assert.equal((await masters.items(ctxFor(f, '?group=Cement'), f.co.tally_guid)).items.length, 1);
  assert.equal(
    (await masters.items(ctxFor(f, '?category=Electrical'), f.co.tally_guid)).items[0].name, 'B');
});

test('the rate per unit is derived, and never divides by zero', async () => {
  const f = await fixture();
  await item(f, 'Priced', 4, 40000);
  await item(f, 'Empty', 0, 0);
  const r = await masters.items(ctxFor(f), f.co.tally_guid);
  const by = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.equal(by.Priced.ratePaise, 10000);
  assert.equal(by.Empty.ratePaise, 0);
});

test('a GST rate is carried as basis points and shown as a percentage', async () => {
  const f = await fixture();
  // 18% as 1800, never 17.999999 through a float - a rate that lands wrong is
  // a rejected return.
  await item(f, 'Taxed', 1, 100, { gstBp: 1800 });
  const r = await masters.items(ctxFor(f), f.co.tally_guid);
  assert.equal(r.items[0].gstRatePct, 18);
});

test('items search covers HSN as well as name', async () => {
  const f = await fixture();
  await item(f, 'Cement OPC', 1, 100, { hsn: '25232910' });
  await item(f, 'Other', 1, 100);
  const r = await masters.items(ctxFor(f, '?q=252329'), f.co.tally_guid);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].name, 'Cement OPC');
});

test('an item detail reports movement direction from the voucher type', async () => {
  const f = await fixture();
  await item(f, 'Widget', 5, 5000);
  const { rows: v } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'vv1','1','Sales','2026-05-01','Buyer',1000),
            ($1,'vv2','2','Purchase','2026-04-01','Seller',800) RETURNING id, vch_type`,
    [f.co.id]);
  for (const row of v) {
    await query(
      `INSERT INTO voucher_items (voucher_id, item_name, qty, rate_paise, amount_paise)
       VALUES ($1,'Widget',1,100,100)`, [row.id]);
  }

  const d = await masters.item(ctxFor(f), f.co.tally_guid, 'Widget');
  const dirs = d.movement.map((m) => m.direction);
  // Tally's sign is inconsistent across voucher types, so the type decides.
  assert.ok(dirs.includes('in'));
  assert.ok(dirs.includes('out'));
});

test('an unknown item is a 404', async () => {
  const f = await fixture();
  await assert.rejects(
    () => masters.item(ctxFor(f), f.co.tally_guid, 'Nothing'), (e) => e.status === 404);
});

test('an empty group tree says why rather than looking broken', async () => {
  const f = await fixture();
  const r = await masters.groups(ctxFor(f), f.co.tally_guid);
  assert.equal(r.groups.length, 0);
  assert.match(r.note, /connector/i);
});

test('masters never cross company boundaries', async () => {
  const a = await fixture();
  const b = await fixture();
  await ledger(a, 'Theirs', 'Sundry Debtors', 100);
  await assert.rejects(
    () => masters.party(ctxFor(b), a.co.tally_guid, 'Theirs'), (e) => e.status === 404);
  const mine = await masters.parties(ctxFor(b), b.co.tally_guid);
  assert.equal(mine.parties.length, 0);
});

test('a search string with SQL in it is harmless', async () => {
  const f = await fixture();
  await ledger(f, 'Acme', 'Sundry Debtors', 100);
  const r = await masters.parties(
    ctxFor(f, `?q=${encodeURIComponent("'; DROP TABLE ledgers;--")}`), f.co.tally_guid);
  assert.equal(r.parties.length, 0);
  const { rows } = await query('SELECT count(*)::int AS n FROM ledgers WHERE company_id = $1',
    [f.co.id]);
  assert.equal(rows[0].n, 1, 'the table is still there');
});

// --- the detail a party screen is opened for --------------------------------

test('a party carries how they pay and how overdue they are', async () => {
  /*
   * The two questions somebody has in mind when they open a customer at all:
   * can I trust them to pay, and how exposed am I right now. A balance alone
   * answers neither.
   */
  const f = await fixture();
  const inv = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,'1','Sales','2026-01-01','Slow Payer',100000) RETURNING id`,
    [f.co.id, `mb-${f.co.id}-1`]);
  const rec = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,'2','Receipt','2026-02-20','Slow Payer',-100000) RETURNING id`,
    [f.co.id, `mb-${f.co.id}-2`]);
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group, credit_days)
     VALUES ($1,$2,'Slow Payer','Sundry Debtors',15)`, [f.co.id, `ml-${f.co.id}`]);
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, amount_paise, bill_type)
     VALUES ($1,$2,'B-1','Slow Payer','2026-01-01',100000,'New Ref'),
            ($1,$3,'B-1','Slow Payer','2026-02-20',-100000,'Agst Ref')`,
    [f.co.id, inv.rows[0].id, rec.rows[0].id]);

  const d = await masters.party(ctxFor(f), f.co.tally_guid, 'Slow Payer');

  assert.ok(d.behaviour, 'a settled bill gives a track record');
  assert.equal(d.behaviour.bills, 1);
  assert.equal(d.behaviour.averageDays, 50);
  /*
   * Judged against the party's own credit period, because Tally recorded no
   * due date. Requiring an explicit one made every customer read as
   * unjudgeable while the ageing panel beside it called them overdue.
   */
  assert.equal(d.behaviour.daysAgainstTerms, 35, '50 days taken against 15 allowed');
  assert.equal(d.behaviour.verdict, 'Consistently late');
});

test('one settled bill is reported as not yet a pattern', async () => {
  // A single data point is a fact, not a track record, and the screen has to
  // say which it is showing.
  const f = await fixture();
  // The screen resolves the party through its ledger, so it has to exist.
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group, credit_days)
     VALUES ($1,$2,'One Bill','Sundry Debtors',30)`, [f.co.id, `mcl-${f.co.id}`]);
  const inv = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,'1','Sales','2026-01-01','One Bill',50000) RETURNING id`,
    [f.co.id, `mc-${f.co.id}-1`]);
  const rec = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,'2','Receipt','2026-01-05','One Bill',-50000) RETURNING id`,
    [f.co.id, `mc-${f.co.id}-2`]);
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, amount_paise, bill_type)
     VALUES ($1,$2,'C-1','One Bill','2026-01-01',50000,'New Ref'),
            ($1,$3,'C-1','One Bill','2026-01-05',-50000,'Agst Ref')`,
    [f.co.id, inv.rows[0].id, rec.rows[0].id]);

  const d = await masters.party(ctxFor(f), f.co.tally_guid, 'One Bill');
  assert.equal(d.behaviour.confident, false);
});

test('a customer with nothing settled has no verdict invented for them', async () => {
  const f = await fixture();
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group)
     VALUES ($1,$2,'Brand New','Sundry Debtors')`, [f.co.id, `mn-${f.co.id}`]);

  const d = await masters.party(ctxFor(f), f.co.tally_guid, 'Brand New');
  assert.equal(d.behaviour, null, 'no track record means no claim about them');
});

test('the ageing buckets add up to what is outstanding', async () => {
  /*
   * "₹2,00,000 outstanding" and "₹2,00,000, all of it past ninety days" are
   * different situations, and only the second gets acted on.
   */
  const f = await fixture();
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group, credit_days)
     VALUES ($1,$2,'Owes Us','Sundry Debtors',0)`, [f.co.id, `mo-${f.co.id}`]);

  for (const [n, daysAgo, amount] of [[1, 5, 10000], [2, 45, 20000], [3, 200, 30000]]) {
    const v = await query(
      `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
       VALUES ($1,$2,$3,'Sales',(now() - ($4 || ' days')::interval)::date,'Owes Us',$5)
       RETURNING id`, [f.co.id, `mo-${f.co.id}-${n}`, String(n), String(daysAgo), amount]);
    await query(
      `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, amount_paise, bill_type)
       VALUES ($1,$2,$3,'Owes Us',(now() - ($4 || ' days')::interval)::date,$5,'New Ref')`,
      [f.co.id, v.rows[0].id, `O-${n}`, String(daysAgo), amount]);
  }

  const d = await masters.party(ctxFor(f), f.co.tally_guid, 'Owes Us');
  const bucketSum = d.ageing.buckets.reduce((a, b) => a + b.paise, 0);

  assert.equal(d.ageing.notDuePaise + bucketSum, d.ageing.totalPaise,
    'every rupee lands in exactly one bucket');
  assert.equal(d.ageing.totalPaise, 60000);
  assert.equal(d.ageing.overduePercent, 100, 'zero credit days makes all of it due');
});
