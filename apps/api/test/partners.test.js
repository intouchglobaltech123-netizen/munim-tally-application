const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const partners = require('../src/routes/partners');
const subscription = require('../src/routes/subscription');

/**
 * The channel.
 *
 * Money owed to somebody outside the company, so the tests care about the ways
 * it could pay twice, pay on tax, or let two partners claim one customer.
 */

const orgs = [];
const partnerIds = [];
after(async () => {
  for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]);
  for (const id of partnerIds) await query('DELETE FROM partners WHERE id = $1', [id]);
});

async function account(name = 'cust', plan = 'trial') {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ($1,$2) RETURNING *`, [name, plan]);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role, name) VALUES ($1,$2,'owner','Owner') RETURNING id`,
    [o[0].id, `pt-${o[0].id.slice(0, 8)}@example.com`]);
  return { orgId: o[0].id, userId: u[0].id };
}

const ctxFor = (f, body = {}) => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null,
                                           name: 'Owner', email: `x-${f.userId}@e.com` } },
  req: { headers: {}, socket: {} }, url: new URL('http://x/'), body,
});

const staffCtx = (body = {}) => ({
  session: { org: { id: null }, user: { id: null, role: 'platform_admin' } },
  req: { headers: {}, socket: {} }, url: new URL('http://x/'), body,
});

async function activePartner(name = 'Dealer Co') {
  const f = await account('dealer');
  const made = await partners.apply(ctxFor(f, {
    name, email: `d-${f.orgId.slice(0, 8)}@example.com`, phone: '9876543210' }));
  partnerIds.push(made.id);
  await partners.update(staffCtx({ status: 'active' }), made.id);
  return { ...made, owner: f };
}

// --- applying ---------------------------------------------------------------

test('a referral code is generated, not chosen', async () => {
  // A partner picking their own would take "TALLY" or "MUNIM", and the link
  // would look like it came from us rather than from them.
  const p = await activePartner('Shree Traders');
  assert.match(p.code, /^[A-Z0-9]+-[A-Z0-9]{4}$/);
  assert.ok(p.code.startsWith('SHREETRA'));
});

test('a referral code avoids characters that are misread aloud', () => {
  // These get read down a phone line and written on paper.
  for (let i = 0; i < 40; i++) {
    const tail = partners.codeFrom('Test').split('-')[1];
    assert.ok(!/[01OI]/.test(tail), `"${tail}" contains an ambiguous character`);
  }
});

test('applying twice is refused with where the first one stands', async () => {
  const f = await account('twice');
  const made = await partners.apply(ctxFor(f, {
    name: 'First Try', email: `t-${f.orgId.slice(0, 8)}@example.com` }));
  partnerIds.push(made.id);
  await assert.rejects(
    () => partners.apply(ctxFor(f, { name: 'Second Try', email: 'other@example.com' })),
    /already applied/);
});

test('a pending partner gets a screen, not an error', async () => {
  // An error page for somebody who just applied reads as a rejection.
  const f = await account('pending');
  const made = await partners.apply(ctxFor(f, {
    name: 'Waiting Co', email: `w-${f.orgId.slice(0, 8)}@example.com` }));
  partnerIds.push(made.id);

  const d = await partners.dashboard(ctxFor(f));
  assert.equal(d.partner.status, 'pending');
  assert.match(d.message, /being reviewed/);
});

test('somebody who is not a partner is offered the chance to apply', async () => {
  const f = await account('nobody');
  const d = await partners.dashboard(ctxFor(f));
  assert.equal(d.partner, null);
  assert.equal(d.canApply, true);
});

// --- attribution ------------------------------------------------------------

test('a referral code attributes a new account', async () => {
  const p = await activePartner();
  const cust = await account('referred');
  const out = await partners.attribute(cust.orgId, p.code);
  assert.equal(out.attributed, true);

  const { rows } = await query('SELECT partner_id, partner_at FROM orgs WHERE id = $1',
    [cust.orgId]);
  assert.equal(rows[0].partner_id, p.id);
  assert.ok(rows[0].partner_at);
});

test('a second partner cannot claim a customer already introduced', async () => {
  /*
   * Two partners claiming one customer is a dispute the schema should make
   * impossible rather than a report somebody reconciles by hand.
   */
  const a = await activePartner('First Dealer');
  const b = await activePartner('Second Dealer');
  const cust = await account('contested');

  await partners.attribute(cust.orgId, a.code);
  const second = await partners.attribute(cust.orgId, b.code);
  assert.equal(second.attributed, false);

  const { rows } = await query('SELECT partner_id FROM orgs WHERE id = $1', [cust.orgId]);
  assert.equal(rows[0].partner_id, a.id);
});

test('an unknown code does nothing rather than failing the sign-up', async () => {
  // A customer must never be blocked from creating an account because a
  // partner's status changed while they read the landing page.
  const cust = await account('unknown-ref');
  const out = await partners.attribute(cust.orgId, 'NOSUCH-CODE');
  assert.equal(out.attributed, false);
  assert.match(out.reason, /unknown/);
});

test('a paused partner does not collect new referrals', async () => {
  const p = await activePartner('Paused Co');
  await partners.update(staffCtx({ status: 'paused' }), p.id);
  const cust = await account('after-pause');
  assert.equal((await partners.attribute(cust.orgId, p.code)).attributed, false);
});

// --- earning ----------------------------------------------------------------

async function paidPayment(orgId, { subtotal = 149900, discount = 0, tax = 26982 } = {}) {
  const { rows } = await query(
    `INSERT INTO payments (org_id, status, subtotal_paise, discount_paise, tax_paise,
                           total_paise, gateway, gateway_ref)
     VALUES ($1,'paid',$2,$3,$4,$5,'test',$6) RETURNING *`,
    [orgId, subtotal, discount, tax, subtotal - discount + tax,
     `pay-${crypto.randomUUID()}`]);
  return rows[0];
}
const crypto = require('crypto');

test('commission is computed on the money before tax', async () => {
  /*
   * GST collected is passed to the government, not kept. Paying a share of it
   * would mean paying commission out of tax.
   */
  const p = await activePartner();
  const cust = await account('earner');
  await partners.attribute(cust.orgId, p.code);

  const payment = await paidPayment(cust.orgId, { subtotal: 149900, tax: 26982 });
  const out = await partners.earnOn(payment);

  assert.equal(out.earned, true);
  assert.equal(out.amountPaise, 29980, '20% of ₹1,499, not of ₹1,768.82');
});

test('a discount reduces the commission base', async () => {
  const p = await activePartner();
  const cust = await account('discounted');
  await partners.attribute(cust.orgId, p.code);

  const payment = await paidPayment(cust.orgId, { subtotal: 100000, discount: 50000 });
  const out = await partners.earnOn(payment);
  assert.equal(out.amountPaise, 10000, '20% of the ₹500 actually paid');
});

test('the same payment never earns twice', async () => {
  // A webhook replay or a re-run of the earning job must not pay twice.
  const p = await activePartner();
  const cust = await account('replay');
  await partners.attribute(cust.orgId, p.code);

  const payment = await paidPayment(cust.orgId);
  const first = await partners.earnOn(payment);
  const second = await partners.earnOn(payment);

  assert.equal(first.earned, true);
  assert.equal(second.earned, false);
  assert.match(second.reason, /already earned/);

  const { rows } = await query(
    'SELECT count(*)::int n FROM commissions WHERE partner_id = $1', [p.id]);
  assert.equal(rows[0].n, 1);
});

test('an account with no partner earns nobody anything', async () => {
  const cust = await account('organic');
  const payment = await paidPayment(cust.orgId);
  assert.equal((await partners.earnOn(payment)).earned, false);
});

test('a commission window that has run out earns nothing more', async () => {
  /*
   * Measured from when the customer was introduced, not from each payment -
   * otherwise the window never closes.
   */
  const p = await activePartner();
  await partners.update(staffCtx({ commissionMonths: 3 }), p.id);
  const cust = await account('lapsed');
  await partners.attribute(cust.orgId, p.code);
  await query(`UPDATE orgs SET partner_at = now() - interval '6 months' WHERE id = $1`,
    [cust.orgId]);

  const payment = await paidPayment(cust.orgId);
  const out = await partners.earnOn(payment);
  assert.equal(out.earned, false);
  assert.match(out.reason, /period ended/);
});

test('a refund reverses the commission rather than deleting it', async () => {
  // A number that quietly shrinks is the fastest way to lose a channel's trust.
  const p = await activePartner();
  const cust = await account('refunded');
  await partners.attribute(cust.orgId, p.code);
  const payment = await paidPayment(cust.orgId);
  await partners.earnOn(payment);

  const out = await partners.reverseFor(payment.id);
  assert.equal(out.reversed, 1);

  const { rows } = await query(
    'SELECT status, note FROM commissions WHERE payment_id = $1', [payment.id]);
  assert.equal(rows[0].status, 'reversed');
  assert.match(rows[0].note, /refunded/);
});

test('a rate change applies to new commissions, not old ones', async () => {
  // The rate is stored on each line, so history does not rewrite itself when
  // terms are renegotiated.
  const p = await activePartner();
  const cust = await account('renegotiated');
  await partners.attribute(cust.orgId, p.code);

  await partners.earnOn(await paidPayment(cust.orgId, { subtotal: 100000 }));
  await partners.update(staffCtx({ commissionPercent: 30 }), p.id);
  await partners.earnOn(await paidPayment(cust.orgId, { subtotal: 100000 }));

  const { rows } = await query(
    'SELECT rate_bps, amount_paise FROM commissions WHERE partner_id = $1 ORDER BY earned_at',
    [p.id]);
  assert.equal(rows[0].rate_bps, 2000);
  assert.equal(rows[1].rate_bps, 3000);
  assert.equal(Number(rows[1].amount_paise), 30000);
});

test('a fractional rate survives being stored', async () => {
  // 12.5% is a real negotiated number and integer percent would lose it.
  const p = await activePartner();
  await partners.update(staffCtx({ commissionPercent: 12.5 }), p.id);
  const { rows } = await query('SELECT commission_bps FROM partners WHERE id = $1', [p.id]);
  assert.equal(rows[0].commission_bps, 1250);
});

test('an absurd rate is clamped rather than stored', async () => {
  const p = await activePartner();
  await partners.update(staffCtx({ commissionPercent: 500 }), p.id);
  const { rows } = await query('SELECT commission_bps FROM partners WHERE id = $1', [p.id]);
  assert.equal(rows[0].commission_bps, 10000);
});

// --- paying out -------------------------------------------------------------

test('a payout covers exactly the approved lines and marks them paid', async () => {
  const p = await activePartner();
  const cust = await account('payout-cust');
  await partners.attribute(cust.orgId, p.code);
  await partners.earnOn(await paidPayment(cust.orgId, { subtotal: 100000 }));
  await partners.earnOn(await paidPayment(cust.orgId, { subtotal: 200000 }));

  await partners.approveCommissions(staffCtx(), p.id);
  const out = await partners.payout(staffCtx({ reference: 'NEFT-123' }), p.id);

  assert.equal(Number(out.payout.amount_paise), 60000);
  assert.equal(out.payout.lines, 2);

  const { rows } = await query(
    `SELECT count(*)::int n FROM commissions
      WHERE partner_id = $1 AND status = 'paid' AND payout_id = $2`,
    [p.id, out.payout.id]);
  assert.equal(rows[0].n, 2);
});

test('a pending commission is not paid out until approved', async () => {
  const p = await activePartner();
  const cust = await account('unapproved');
  await partners.attribute(cust.orgId, p.code);
  await partners.earnOn(await paidPayment(cust.orgId));

  await assert.rejects(() => partners.payout(staffCtx(), p.id), /nothing approved/i);
});

test('paying out twice pays the second time nothing', async () => {
  const p = await activePartner();
  const cust = await account('double-payout');
  await partners.attribute(cust.orgId, p.code);
  await partners.earnOn(await paidPayment(cust.orgId));
  await partners.approveCommissions(staffCtx(), p.id);
  await partners.payout(staffCtx(), p.id);

  await assert.rejects(() => partners.payout(staffCtx(), p.id), /nothing approved/i);
});

// --- the dashboard ----------------------------------------------------------

test('the dashboard separates owed, agreed and arrived', async () => {
  /*
   * They mean different things to somebody deciding whether to keep selling.
   * One "earnings" figure hides which.
   */
  const p = await activePartner();
  const cust = await account('dash');
  await partners.attribute(cust.orgId, p.code);
  await partners.earnOn(await paidPayment(cust.orgId, { subtotal: 100000 }));

  const d = await partners.dashboard(ctxFor(p.owner));
  assert.equal(d.summary.pendingPaise, 20000);
  assert.equal(d.summary.approvedPaise, 0);
  assert.equal(d.summary.paidPaise, 0);
  assert.equal(d.summary.customers, 1);
});

test('a partner sees only their own customers', async () => {
  const a = await activePartner('Dealer A');
  const b = await activePartner('Dealer B');
  const mine = await account('mine');
  const theirs = await account('theirs');
  await partners.attribute(mine.orgId, a.code);
  await partners.attribute(theirs.orgId, b.code);

  const d = await partners.dashboard(ctxFor(a.owner));
  assert.equal(d.customers.length, 1);
  assert.equal(d.customers[0].id, mine.orgId);
});

test('a bank account is never shown back in full, even to staff', async () => {
  // The last four is enough to confirm a payout went to the right place.
  const p = await activePartner();
  await partners.update(staffCtx({
    bankName: 'HDFC', bankAccount: '12345678901234', bankIfsc: 'HDFC0001234' }), p.id);

  const list = await partners.list(staffCtx());
  const row = list.partners.find((x) => x.id === p.id);
  assert.ok(!row.bank.includes('12345678901234'));
  assert.match(row.bank, /1234$/);
});

test('leads belong to the partner who created them', async () => {
  const a = await activePartner('Lead A');
  const b = await activePartner('Lead B');
  const made = await partners.saveLead(ctxFor(a.owner, { business: 'Prospect Ltd' }));

  await assert.rejects(
    () => partners.saveLead(ctxFor(b.owner, { status: 'won' }), made.lead.id),
    (e) => e.status === 404);
});

test('a customer cannot read the partner admin list', async () => {
  const f = await account('nosy');
  await assert.rejects(() => partners.list(ctxFor(f)),
    (e) => e.status === 401 || e.status === 403);
});
