const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const sub = require('../src/routes/subscription');
const money = require('../src/lib/money');
const plans = require('../src/lib/plans');

/**
 * Selling the thing.
 *
 * Every number here is one a customer can check with a calculator, and the ones
 * that decide when a change takes effect are the ones that generate refunds
 * when they are wrong.
 */

const orgs = [];
after(async () => {
  for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]);
  await query("DELETE FROM coupons WHERE code LIKE 'TEST%'");
});

async function fixture(plan = 'trial', state = 'Tamil Nadu') {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan, billing_state, billing_name)
     VALUES ('Sub Test',$1,$2,'Sub Test Pvt Ltd') RETURNING *`, [plan, state]);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role, name) VALUES ($1,$2,'owner','Owner') RETURNING id`,
    [o[0].id, `sub-${o[0].id.slice(0, 8)}@example.com`]);
  return { orgId: o[0].id, userId: u[0].id };
}

const ctxFor = (f, body = {}, qs = '') => ({
  session: {
    org: { id: f.orgId, plan: 'trial' },
    user: { id: f.userId, role: 'owner', roleId: null, name: 'Owner', email: 'o@x.com' },
  },
  req: { headers: {}, socket: {} },
  url: new URL(`http://x/${qs}`), body,
});

// --- the arithmetic ---------------------------------------------------------

test('GST within the home state is CGST plus SGST, and they add up exactly', () => {
  const q = money.quote({ pricePaise: 149900, buyerState: 'Tamil Nadu' });
  assert.equal(q.taxKind, 'CGST+SGST');
  assert.equal(q.cgstPaise + q.sgstPaise, q.taxPaise);
  assert.equal(q.igstPaise, 0);
  assert.equal(q.totalPaise, 176882, '₹1,499 + 18% is ₹1,768.82');
});

test('GST to another state is IGST', () => {
  const q = money.quote({ pricePaise: 149900, buyerState: 'Karnataka' });
  assert.equal(q.taxKind, 'IGST');
  assert.equal(q.igstPaise, 26982);
  assert.equal(q.cgstPaise + q.sgstPaise, 0);
});

test('an odd paisa goes to SGST rather than disappearing', () => {
  // Half of an odd number is not an integer, and the two halves must still add
  // back to the total or the invoice does not foot.
  const g = money.gstFor(101, 'Tamil Nadu');
  assert.equal(g.cgst + g.sgst, g.total);
});

test('tax is charged on the discounted amount, not the list price', () => {
  // Nobody accepts paying tax on money they did not pay.
  const q = money.quote({ pricePaise: 100000, coupon: { percent_off: 50 } });
  assert.equal(q.taxablePaise, 50000);
  assert.equal(q.taxPaise, 9000);
});

test('a coupon bigger than the bill makes it zero, never negative', () => {
  const q = money.quote({ pricePaise: 49900, coupon: { amount_off_paise: 99900 } });
  assert.equal(q.discountPaise, 49900);
  assert.equal(q.totalPaise, 0);
});

test('proration charges for the days left, not the whole month', () => {
  const from = new Date('2026-01-01');
  const until = new Date('2026-01-31');
  const at = new Date('2026-01-16');                // roughly half way
  const p = money.prorate({ fromPaise: 49900, toPaise: 149900,
    periodFrom: from, periodUntil: until, at });

  assert.ok(p.chargePaise > 70000 && p.chargePaise < 80000, `charged ${p.chargePaise}`);
  assert.ok(p.creditPaise > 23000 && p.creditPaise < 27000, `credited ${p.creditPaise}`);
  assert.equal(p.duePaise, p.chargePaise - p.creditPaise);
});

test('proration never pays money back', () => {
  // A refund is a deliberate human decision, not an arithmetic side effect.
  const p = money.prorate({ fromPaise: 149900, toPaise: 49900,
    periodFrom: new Date('2026-01-01'), periodUntil: new Date('2026-01-31'),
    at: new Date('2026-01-05') });
  assert.equal(p.duePaise, 0);
});

test('a change after the period ended prorates nothing', () => {
  const p = money.prorate({ fromPaise: 49900, toPaise: 149900,
    periodFrom: new Date('2026-01-01'), periodUntil: new Date('2026-01-31'),
    at: new Date('2026-03-01') });
  assert.equal(p.chargePaise, 0);
  assert.equal(p.daysLeft, 0);
});

test('a subscription starting on the 31st does not drift', () => {
  // JavaScript rolls 31 February into 3 March, and the renewal date walks
  // forward a few days every year.
  const next = sub.periodEnd(new Date('2026-01-31'), 'monthly');
  assert.equal(next.getMonth(), 1, 'lands in February');
  assert.equal(next.getDate(), 28, 'clamped to the last day');
});

test('a year costs ten months, not twelve', () => {
  assert.equal(sub.priceFor('standard', 'yearly'), sub.priceFor('standard', 'monthly') * 10);
});

test('the financial year runs April to March', () => {
  assert.equal(money.financialYear(new Date('2026-03-31')), '2025-26');
  assert.equal(money.financialYear(new Date('2026-04-01')), '2026-27');
});

// --- subscribing ------------------------------------------------------------

test('subscribing sets the plan on the org, so quotas follow', async () => {
  // If the two disagree, the customer pays and is still refused a second
  // company.
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  const { rows } = await query('SELECT plan FROM orgs WHERE id = $1', [f.orgId]);
  assert.equal(rows[0].plan, 'standard');
});

test('only one live subscription can exist', async () => {
  // Two would double-bill and disagree about which limits apply.
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  await assert.rejects(() => query(
    `INSERT INTO subscriptions (org_id, plan, current_until)
     VALUES ($1,'standard', now() + interval '30 days')`, [f.orgId]),
    /subscriptions_one_live|duplicate key/);
});

test('a member cannot change the plan', async () => {
  const f = await fixture();
  const ctx = ctxFor(f, { plan: 'standard' });
  ctx.session.user = { id: f.userId, role: 'member', roleId: 'r1',
                       permissions: { settings: ['read', 'update'] } };
  await assert.rejects(() => sub.subscribe(ctx), /Only an owner/);
});

// --- cancelling -------------------------------------------------------------

test('cancelling keeps everything working until the period ends', async () => {
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  const r = await sub.cancel(ctxFor(f));
  assert.ok(r.endsAt);
  const { rows } = await query('SELECT plan FROM orgs WHERE id = $1', [f.orgId]);
  assert.equal(rows[0].plan, 'standard');
});

test('a cancellation can be undone before it takes effect', async () => {
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  await sub.cancel(ctxFor(f));
  await sub.resume(ctxFor(f));
  const s = await sub.current(f.orgId);
  assert.equal(s.cancel_at_end, false);
});

test('a lapsed customer keeps their data and their sign-in', async () => {
  /*
   * Locking somebody out of their own books over a lapsed subscription turns a
   * billing system into a hostage situation. They lose the paid features and
   * nothing else.
   */
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  await sub.cancel(ctxFor(f));
  await query(`UPDATE subscriptions SET current_until = now() - interval '1 day'
                WHERE org_id = $1`, [f.orgId]);
  await sub.runBilling();

  const { rows } = await query('SELECT plan FROM orgs WHERE id = $1', [f.orgId]);
  assert.equal(rows[0].plan, 'trial');
  const { rows: people } = await query(
    'SELECT count(*)::int n FROM users WHERE org_id = $1', [f.orgId]);
  assert.equal(people[0].n, 1, 'the people are still there');
});

// --- payments ---------------------------------------------------------------

test('a failed payment starts a grace period rather than cutting service', async () => {
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  const s = await sub.current(f.orgId);

  await sub.recordPayment(f.orgId, {
    subscriptionId: s.id, status: 'failed', gateway: 'test', gatewayRef: `f-${s.id}`,
    failureReason: 'card declined', totalPaise: 176882,
  });

  const after = await sub.current(f.orgId);
  assert.equal(after.status, 'grace');
  assert.ok(after.grace_until, 'and it has an end date');
});

test('a grace period that runs out expires the subscription', async () => {
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  const s = await sub.current(f.orgId);
  await sub.recordPayment(f.orgId, {
    subscriptionId: s.id, status: 'failed', gateway: 'test', gatewayRef: `g-${s.id}`,
  });
  await query(`UPDATE subscriptions SET grace_until = now() - interval '1 day'
                WHERE id = $1`, [s.id]);

  await sub.runBilling();
  const { rows } = await query('SELECT status FROM subscriptions WHERE id = $1', [s.id]);
  assert.equal(rows[0].status, 'expired');
});

test('a successful payment issues a numbered GST invoice', async () => {
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  const s = await sub.current(f.orgId);

  const out = await sub.recordPayment(f.orgId, {
    subscriptionId: s.id, status: 'paid', gateway: 'test', gatewayRef: `p-${s.id}`,
    subtotalPaise: 149900, taxPaise: 26982, totalPaise: 176882,
  });

  assert.match(out.invoice.number, /^MUN\/\d{4}-\d{2}\/\d{5}$/);
  assert.equal(out.invoice.cgstPaise + out.invoice.sgstPaise, 26982,
    'a Tamil Nadu customer gets CGST + SGST');
  assert.equal(out.invoice.billTo.name, 'Sub Test Pvt Ltd');
});

test('a failed payment never consumes an invoice number', async () => {
  // The gap a declined card would leave is the thing an auditor asks about.
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  const s = await sub.current(f.orgId);

  const before = await query('SELECT count(*)::int n FROM billing_invoices');
  await sub.recordPayment(f.orgId, {
    subscriptionId: s.id, status: 'failed', gateway: 'test', gatewayRef: `x-${s.id}` });
  const after = await query('SELECT count(*)::int n FROM billing_invoices');
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test('a replayed webhook does not charge twice', async () => {
  /*
   * A gateway retries, sometimes concurrently. Check-then-insert loses that
   * race; the unique index does not.
   */
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  const s = await sub.current(f.orgId);
  const ref = `dup-${s.id}`;

  const first = await sub.recordPayment(f.orgId, {
    subscriptionId: s.id, status: 'paid', gateway: 'razorpay', gatewayRef: ref,
    subtotalPaise: 149900, taxPaise: 26982, totalPaise: 176882 });
  const second = await sub.recordPayment(f.orgId, {
    subscriptionId: s.id, status: 'paid', gateway: 'razorpay', gatewayRef: ref,
    subtotalPaise: 149900, taxPaise: 26982, totalPaise: 176882 });

  assert.equal(second.replayed, true);
  assert.equal(second.payment.id, first.payment.id);

  const { rows } = await query(
    'SELECT count(*)::int n FROM payments WHERE org_id = $1', [f.orgId]);
  assert.equal(rows[0].n, 1);
});

test('invoice numbers are unique and gap-free within a year', async () => {
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  const s = await sub.current(f.orgId);

  for (let i = 0; i < 5; i++) {
    await sub.recordPayment(f.orgId, {
      subscriptionId: s.id, status: 'paid', gateway: 'test', gatewayRef: `seq-${s.id}-${i}`,
      subtotalPaise: 149900, taxPaise: 26982, totalPaise: 176882 });
  }

  const { rows } = await query(
    `SELECT fy, seq FROM billing_invoices WHERE org_id = $1 ORDER BY seq`, [f.orgId]);
  assert.equal(rows.length, 5);
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].seq - rows[i - 1].seq, 1, 'a gap appeared in the sequence');
  }
});

test('concurrent payments do not collide on the invoice number', async () => {
  // Exactly what a gateway retrying a batch looks like.
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  const s = await sub.current(f.orgId);

  const results = await Promise.all([0, 1, 2, 3, 4, 5].map((i) =>
    sub.recordPayment(f.orgId, {
      subscriptionId: s.id, status: 'paid', gateway: 'test',
      gatewayRef: `race-${s.id}-${i}`,
      subtotalPaise: 149900, taxPaise: 26982, totalPaise: 176882 })));

  const numbers = results.map((r) => r.invoice.number);
  assert.equal(new Set(numbers).size, numbers.length, 'two invoices got the same number');
});

// --- coupons ----------------------------------------------------------------

async function coupon(code, fields) {
  await query('DELETE FROM coupons WHERE code = $1', [code]);
  const cols = Object.keys(fields);
  await query(
    `INSERT INTO coupons (code, ${cols.join(', ')})
     VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
    [code, ...cols.map((c) => fields[c])]);
}

test('an expired coupon is refused', async () => {
  await coupon('TESTEXP', { percent_off: 20, expires_at: new Date(Date.now() - 86400000) });
  await assert.rejects(() => sub.couponFor('TESTEXP', 'standard'), /expired/);
});

test('a used-up coupon is refused', async () => {
  await coupon('TESTMAX', { percent_off: 20, max_redemptions: 1, redeemed: 1 });
  await assert.rejects(() => sub.couponFor('TESTMAX', 'standard'), /used up/);
});

test('a coupon restricted to one plan is refused on another', async () => {
  // Restricted to the trial, then offered against the paid plan. There is one
  // sellable plan now, so the trial is the only other key a coupon can name -
  // the restriction machinery is what is being tested, not the ladder.
  await coupon('TESTPRO', { percent_off: 20, plans: ['trial'] });
  await assert.rejects(() => sub.couponFor('TESTPRO', 'standard'), /works on Free trial/);
  assert.ok(await sub.couponFor('TESTPRO', 'trial'));
});

test('a coupon cannot be both a percentage and an amount', async () => {
  // "20% AND ₹200 off" is a support ticket about which one applied.
  await assert.rejects(() => query(
    `INSERT INTO coupons (code, percent_off, amount_off_paise) VALUES ('TESTBOTH', 20, 20000)`),
    /coupons_one_kind|check constraint/);
});

test('a coupon over 100% is refused by the database', async () => {
  await assert.rejects(() => query(
    `INSERT INTO coupons (code, percent_off) VALUES ('TESTMAD', 150)`),
    /coupons_sane_percent|check constraint/);
});

test('redeeming a coupon counts it', async () => {
  await coupon('TESTCOUNT', { percent_off: 10 });
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard', coupon: 'TESTCOUNT' }));
  const { rows } = await query('SELECT redeemed FROM coupons WHERE code = $1', ['TESTCOUNT']);
  assert.equal(rows[0].redeemed, 1);
});

// --- the screen -------------------------------------------------------------

test('the overview explains the status in words', async () => {
  const f = await fixture();
  await sub.subscribe(ctxFor(f, { plan: 'standard' }));
  const o = await sub.overview(ctxFor(f));
  assert.match(o.subscription.message, /Renews on/);
  assert.equal(o.subscription.planLabel, 'Munim');
});

