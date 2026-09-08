const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const entry = require('../src/routes/entry');

/**
 * Writing into a customer's books.
 *
 * The only part of Munim that changes somebody's accounts, so these tests are
 * mostly about refusing: refusing to send twice, refusing to send something
 * that does not balance, refusing to invent a ledger, refusing to edit what is
 * already in Tally.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function shop({ writes = true, connectorSeen = true } = {}) {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan, writes_enabled) VALUES ('entry-test','internal',$1)
     RETURNING *`, [writes]);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role, name) VALUES ($1,$2,'owner','Owner') RETURNING id`,
    [o[0].id, `en-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Entry Books') RETURNING *`,
    [o[0].id, `en-${o[0].id}`]);
  const { rows: k } = await query(
    `INSERT INTO connectors (org_id, machine_name, token_hash, last_seen_at)
     VALUES ($1,'SHOP-PC',$2,$3) RETURNING id`,
    [o[0].id, `kt-${o[0].id}`, connectorSeen ? new Date() : null]);

  for (const [name, group] of [
    ['Ravi Traders', 'Sundry Debtors'], ['Sales', 'Sales Accounts'],
    ['Cash', 'Cash-in-Hand'], ['Purchases', 'Purchase Accounts'],
  ]) {
    await query(
      `INSERT INTO ledgers (company_id, guid, name, parent_group)
       VALUES ($1,$2,$3,$4)`, [c[0].id, `lg-${c[0].id}-${name}`, name, group]);
  }
  await query(
    `INSERT INTO stock_items (company_id, guid, name, unit, closing_qty)
     VALUES ($1,$2,'Cement Bag','Nos',100)`, [c[0].id, `si-${c[0].id}`]);

  return { orgId: o[0].id, userId: u[0].id, co: c[0], connId: k[0].id };
}

const ctxFor = (f, body = {}, qs = '') => ({
  session: {
    org: { id: f.orgId },
    user: { id: f.userId, role: 'owner', roleId: null, name: 'Owner', email: 'o@x.com' },
  },
  req: { headers: {}, socket: {} },
  url: new URL(`http://x/${qs}`), body,
});

const connCtx = (f, body = {}) => ({
  connector: { id: f.connId, orgId: f.orgId },
  req: { headers: {}, socket: {} }, url: new URL('http://x/'), body,
});

const salesBody = (over = {}) => ({
  kind: 'sales',
  date: '2026-05-01',
  party: 'Ravi Traders',
  narration: 'Two bags',
  entries: [
    { ledger: 'Ravi Traders', amountPaise: 100000 },   // debit the customer
    { ledger: 'Sales', amountPaise: -100000 },         // credit income
  ],
  ...over,
});

// --- validation -------------------------------------------------------------

test('a voucher that does not balance is refused, with the difference', async () => {
  /*
   * Tally would refuse it too - minutes later, on a machine in the shop, with a
   * message nobody sees. Checking here means the person who typed it is still
   * looking at it.
   */
  const f = await shop();
  const out = await entry.create(ctxFor(f, salesBody({
    entries: [
      { ledger: 'Ravi Traders', amountPaise: 100000 },
      { ledger: 'Sales', amountPaise: -90000 },
    ],
  })), f.co.tally_guid);

  assert.ok(out.problems.some((p) => /does not balance/.test(p)));
  assert.ok(out.problems.some((p) => /100/.test(p) && /900/.test(p)));
});

test('a ledger that does not exist is refused rather than created', async () => {
  /*
   * A misspelt customer would otherwise silently become a second account, and
   * merging those afterwards is a job for an accountant and an evening.
   */
  const f = await shop();
  const out = await entry.create(ctxFor(f, salesBody({
    entries: [
      { ledger: 'Ravi Traderz', amountPaise: 100000 },
      { ledger: 'Sales', amountPaise: -100000 },
    ],
  })), f.co.tally_guid);

  assert.ok(out.problems.some((p) => /not a ledger/.test(p)));
  assert.ok(out.problems.some((p) => /will not add ledgers/.test(p)));
});

test('a single-sided voucher is refused', async () => {
  const f = await shop();
  const out = await entry.create(ctxFor(f, salesBody({
    entries: [{ ledger: 'Sales', amountPaise: -100000 }],
  })), f.co.tally_guid);
  assert.ok(out.problems.some((p) => /at least two/.test(p)));
});

test('a year typed wrong is caught', async () => {
  // 2025 typed as 2052 lands in a period nobody looks at, and Tally accepts it.
  const f = await shop();
  const out = await entry.create(ctxFor(f, salesBody({ date: '2052-05-01' })),
    f.co.tally_guid);
  assert.ok(out.problems.some((p) => /years away/.test(p)));
});

test('an unknown stock item is refused', async () => {
  const f = await shop();
  const out = await entry.create(ctxFor(f, salesBody({
    items: [{ item: 'Steel Rod', qty: 2, ratePaise: 50000, amountPaise: 100000 }],
  })), f.co.tally_guid);
  assert.ok(out.problems.some((p) => /not a stock item/.test(p)));
});

test('stock lines on a receipt are refused', async () => {
  const f = await shop();
  const out = await entry.create(ctxFor(f, {
    kind: 'receipt', date: '2026-05-01', party: 'Ravi Traders',
    entries: [
      { ledger: 'Cash', amountPaise: 100000 },
      { ledger: 'Ravi Traders', amountPaise: -100000 },
    ],
    items: [{ item: 'Cement Bag', qty: 1, ratePaise: 1, amountPaise: 1 }],
  }), f.co.tally_guid);
  assert.ok(out.problems.some((p) => /does not carry stock/.test(p)));
});

test('a half-finished draft is still saved', async () => {
  // Refusing to save is how somebody loses ten minutes of typing to a typo.
  const f = await shop();
  const out = await entry.create(ctxFor(f, salesBody({
    entries: [{ ledger: 'Sales', amountPaise: -100000 }],
  })), f.co.tally_guid);
  assert.ok(out.draft.id);
  assert.equal(out.draft.status, 'draft');
});

// --- nothing reaches Tally by accident --------------------------------------

test('creating a voucher does not send it', async () => {
  const f = await shop();
  const out = await entry.create(ctxFor(f, salesBody()), f.co.tally_guid);
  assert.equal(out.draft.status, 'draft');

  const box = await entry.outbox(connCtx(f));
  assert.equal(box.vouchers.length, 0, 'a draft must never appear in the outbox');
});

test('a voucher with problems cannot be sent', async () => {
  const f = await shop();
  const made = await entry.create(ctxFor(f, salesBody({
    entries: [
      { ledger: 'Ravi Traders', amountPaise: 100000 },
      { ledger: 'Sales', amountPaise: -90000 },
    ],
  })), f.co.tally_guid);

  await assert.rejects(() => entry.send(ctxFor(f), made.draft.id), /cannot go to Tally/);
});

test('writing is off until a business turns it on', async () => {
  /*
   * Every customer who signed up before this existed agreed to a product that
   * only read. Shipping a release must not start writing into their books.
   */
  const f = await shop({ writes: false });
  const made = await entry.create(ctxFor(f, salesBody()), f.co.tally_guid);
  await assert.rejects(() => entry.send(ctxFor(f), made.draft.id), /switched off/);
});

test('a business with no live connector is told, not left waiting', async () => {
  // Queueing into a company whose PC has been off for a week leaves somebody
  // believing they invoiced a customer.
  const f = await shop({ connectorSeen: false });
  const made = await entry.create(ctxFor(f, salesBody()), f.co.tally_guid);
  await assert.rejects(() => entry.send(ctxFor(f), made.draft.id), /No Tally computer/);

  const { rows } = await query('SELECT status FROM voucher_drafts WHERE id = $1',
    [made.draft.id]);
  assert.equal(rows[0].status, 'draft', 'it stays a draft rather than queueing');
});

// --- sending ----------------------------------------------------------------

async function queued(f) {
  const made = await entry.create(ctxFor(f, salesBody()), f.co.tally_guid);
  await entry.send(ctxFor(f), made.draft.id);
  return made.draft.id;
}

test('a sent voucher reaches the outbox exactly once', async () => {
  const f = await shop();
  const id = await queued(f);

  const first = await entry.outbox(connCtx(f));
  assert.equal(first.vouchers.length, 1);
  assert.equal(first.vouchers[0].id, id);

  // A second connector, or the same one asking again, must not get it while
  // the lease holds - two machines both posting is a duplicate invoice.
  const second = await entry.outbox(connCtx(f));
  assert.equal(second.vouchers.length, 0);
});

test('the outbox carries the identity that makes a retry safe', async () => {
  const f = await shop();
  await queued(f);
  const box = await entry.outbox(connCtx(f));
  assert.match(box.vouchers[0].remoteId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('an expired lease lets another attempt happen', async () => {
  // A connector that dies mid-post must not strand the voucher for ever.
  const f = await shop();
  const id = await queued(f);
  await entry.outbox(connCtx(f));
  await query(`UPDATE voucher_drafts SET leased_until = now() - interval '1 minute'
                WHERE id = $1`, [id]);

  const again = await entry.outbox(connCtx(f));
  assert.equal(again.vouchers.length, 1);
});

test('a voucher stops being retried after the attempt ceiling', async () => {
  // One Tally has refused three times will be refused a fourth, and retrying
  // for ever hides the problem from everybody.
  const f = await shop();
  const id = await queued(f);
  for (let i = 0; i < entry.MAX_ATTEMPTS; i++) {
    await entry.outbox(connCtx(f));
    await entry.result(connCtx(f, { ok: false, error: 'Ledger is closed' }), id);
    await query(`UPDATE voucher_drafts SET leased_until = now() - interval '1 minute'
                  WHERE id = $1`, [id]);
  }
  const { rows } = await query('SELECT status, error FROM voucher_drafts WHERE id = $1',
    [id]);
  assert.equal(rows[0].status, 'rejected');
  assert.match(rows[0].error, /Ledger is closed/);

  const box = await entry.outbox(connCtx(f));
  assert.equal(box.vouchers.length, 0, 'a rejected voucher is not retried');
});

test('a successful post is recorded with what Tally called it', async () => {
  const f = await shop();
  const id = await queued(f);
  await entry.outbox(connCtx(f));
  await entry.result(connCtx(f, {
    ok: true, tallyGuid: 'abc-123', voucherNumber: '42',
    response: '<IMPORTRESULT><CREATED>1</CREATED></IMPORTRESULT>' }), id);

  const out = await entry.one(ctxFor(f), id);
  assert.equal(out.draft.status, 'posted');
  assert.equal(out.draft.tallyNumber, '42');
  assert.equal(out.draft.tallyGuid, 'abc-123');
});

test('reporting success twice does not undo it', async () => {
  // A connector that lost our reply retries; that must be harmless.
  const f = await shop();
  const id = await queued(f);
  await entry.outbox(connCtx(f));
  await entry.result(connCtx(f, { ok: true, tallyGuid: 'g1', voucherNumber: '7' }), id);
  const again = await entry.result(connCtx(f, { ok: true, tallyGuid: 'g1' }), id);

  assert.equal(again.alreadyPosted, true);
  const out = await entry.one(ctxFor(f), id);
  assert.equal(out.draft.status, 'posted');
});

test('a posted voucher is never handed out again', async () => {
  const f = await shop();
  const id = await queued(f);
  await entry.outbox(connCtx(f));
  await entry.result(connCtx(f, { ok: true, tallyGuid: 'g' }), id);
  await query(`UPDATE voucher_drafts SET leased_until = now() - interval '1 hour'
                WHERE id = $1`, [id]);

  const box = await entry.outbox(connCtx(f));
  assert.equal(box.vouchers.length, 0);
});

test('sending the same draft twice is refused', async () => {
  const f = await shop();
  const id = await queued(f);
  await assert.rejects(() => entry.send(ctxFor(f), id), /already on its way/);
});

test('a posted voucher cannot be sent again', async () => {
  const f = await shop();
  const id = await queued(f);
  await entry.outbox(connCtx(f));
  await entry.result(connCtx(f, { ok: true, tallyGuid: 'g' }), id);
  await assert.rejects(() => entry.send(ctxFor(f), id), /already in Tally/);
});

// --- editing ----------------------------------------------------------------

test('a posted voucher cannot be edited, and says what to do instead', async () => {
  /*
   * Editing it here would show something in Munim that differs from Tally, and
   * both look authoritative.
   */
  const f = await shop();
  const id = await queued(f);
  await entry.outbox(connCtx(f));
  await entry.result(connCtx(f, { ok: true, tallyGuid: 'g' }), id);

  await assert.rejects(
    () => entry.update(ctxFor(f, { narration: 'changed' }), id),
    /credit note/);
});

test('a queued voucher cannot be edited under the sender', async () => {
  const f = await shop();
  const id = await queued(f);
  await assert.rejects(() => entry.update(ctxFor(f, { narration: 'x' }), id),
    /has been sent/);
});

test('editing a rejected voucher makes it a draft again', async () => {
  // Its old error is no longer about what it now says.
  const f = await shop();
  const id = await queued(f);
  for (let i = 0; i < entry.MAX_ATTEMPTS; i++) {
    await entry.outbox(connCtx(f));
    await entry.result(connCtx(f, { ok: false, error: 'nope' }), id);
    await query(`UPDATE voucher_drafts SET leased_until = now() - interval '1 minute'
                  WHERE id = $1`, [id]);
  }
  const out = await entry.update(ctxFor(f, { narration: 'fixed' }), id);
  assert.equal(out.draft.status, 'draft');
  assert.equal(out.draft.error, '');
});

test('a draft can be withdrawn but a posted one cannot', async () => {
  const f = await shop();
  const a = await entry.create(ctxFor(f, salesBody()), f.co.tally_guid);
  const cancelled = await entry.cancel(ctxFor(f), a.draft.id);
  assert.equal(cancelled.draft.status, 'cancelled');

  const id = await queued(f);
  await entry.outbox(connCtx(f));
  await entry.result(connCtx(f, { ok: true, tallyGuid: 'g' }), id);
  await assert.rejects(() => entry.cancel(ctxFor(f), id), /already in Tally/);
});

// --- isolation and permissions ----------------------------------------------

test('one business cannot see or send another\'s drafts', async () => {
  const a = await shop();
  const b = await shop();
  const made = await entry.create(ctxFor(a, salesBody()), a.co.tally_guid);

  await assert.rejects(() => entry.one(ctxFor(b), made.draft.id), (e) => e.status === 404);
  await assert.rejects(() => entry.send(ctxFor(b), made.draft.id), (e) => e.status === 404);

  const box = await entry.outbox(connCtx(b));
  assert.equal(box.vouchers.length, 0);
});

test('a connector only ever sees its own org\'s outbox', async () => {
  const a = await shop();
  const b = await shop();
  await queued(a);
  const box = await entry.outbox(connCtx(b));
  assert.equal(box.vouchers.length, 0);
});

test('creating needs permission on that kind of voucher', async () => {
  // One screen creates sales, receipts and journals - three different modules.
  const f = await shop();
  const ctx = ctxFor(f, salesBody());
  ctx.session.user = { id: f.userId, role: 'member', roleId: 'r',
                       permissions: { cashbank: ['create'] } };
  await assert.rejects(() => entry.create(ctx, f.co.tally_guid), (e) => e.status === 403);
});

test('only an owner can turn writing on', async () => {
  const f = await shop({ writes: false });
  const ctx = ctxFor(f, { enabled: true });
  ctx.session.user = { id: f.userId, role: 'member', roleId: 'r',
                       permissions: { settings: ['read', 'update'] } };
  await assert.rejects(() => entry.setWrites(ctx), /Only an owner/);
});

test('turning writing off leaves queued vouchers alone and says so', async () => {
  const f = await shop();
  const id = await queued(f);
  const out = await entry.setWrites(ctxFor(f, { enabled: false }));
  assert.match(out.message, /queued vouchers stay queued/);

  const { rows } = await query('SELECT status FROM voucher_drafts WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'queued');
});

test('every kind Munim offers knows which way the party leg goes', () => {
  /*
   * A sale debits the customer; a purchase credits the supplier. Getting this
   * backwards produces books that balance and are entirely wrong, which is the
   * hardest kind of error to notice.
   */
  assert.equal(entry.KINDS.sales.partySide, 'debit');
  assert.equal(entry.KINDS.purchase.partySide, 'credit');
  assert.equal(entry.KINDS.receipt.partySide, 'credit');
  assert.equal(entry.KINDS.payment.partySide, 'debit');
  for (const [key, def] of Object.entries(entry.KINDS)) {
    assert.ok(def.tallyType, `${key} has no Tally voucher type`);
    assert.ok(def.module, `${key} is not gated on a module`);
  }
});
