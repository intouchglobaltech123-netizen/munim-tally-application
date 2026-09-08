const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const share = require('../src/routes/share');

/**
 * Turning anything into a message somebody can send.
 *
 * Munim never sends: the transport is always the owner's own WhatsApp, from
 * their own number. What is worth testing is the words, and the honesty of the
 * record kept afterwards.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['sh-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role, name) VALUES ($1,$2,'owner','Owner') RETURNING id`,
    [o[0].id, `sh-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name, formal_name)
     VALUES ($1,$2,'Sh Co','Sh Co Traders') RETURNING *`,
    [o[0].id, `sh-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, qs = '', body = {}) => ({
  session: {
    org: { id: f.orgId, name: 'Sh Co' },
    user: { id: f.userId, role: 'owner', roleId: null },
  },
  url: new URL(`http://x/${qs}`), body,
});

const party = (f, name, phone = '9876543210', closing = 0, credit = 30) => query(
  `INSERT INTO ledgers (company_id, guid, name, parent_group, phone, closing_paise, credit_days)
   VALUES ($1,$2,$3,'Sundry Debtors',$4,$5,$6)`,
  [f.co.id, `l-${name}`, name, phone, closing, credit]);

async function sale(f, { ref, partyName, amount, date = '2026-05-01', due = '2026-05-31' }) {
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,$3,'Sales',$4,$5,$6) RETURNING id`,
    [f.co.id, `v-${ref}`, ref, date, partyName, amount]);
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date,
                        amount_paise, bill_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'New Ref')`,
    [f.co.id, rows[0].id, ref, partyName, date, due, amount]);
  return rows[0].id;
}

// --- rendering --------------------------------------------------------------

test('placeholders fill, and an unknown one stays visible', () => {
  assert.equal(share.render('Hi {{party}}, {{oops}}', { party: 'Acme' }),
    'Hi Acme, {{oops}}');
});

test('a line left dangling by a missing value is removed', () => {
  // "Please contact us on ." was going to real customers before this.
  const out = share.tidy('Hello\n\nPlease contact us on \n\nRegards');
  assert.ok(!/contact us on/.test(out));
  assert.match(out, /Hello/);
  assert.match(out, /Regards/);
});

test('every default template uses only placeholders that exist', async () => {
  const f = await fixture();
  const t = await share.templates(ctxFor(f));
  for (const tpl of t.templates) {
    const allowed = new Set(t.placeholders[tpl.kind] ?? []);
    for (const m of tpl.body.matchAll(/\{\{(\w+)\}\}/g)) {
      assert.ok(allowed.has(m[1]),
        `${tpl.kind}/${tpl.name} uses {{${m[1]}}}, which is not offered`);
    }
  }
});

// --- statements -------------------------------------------------------------

test('a statement carries the balance and the recent entries', async () => {
  const f = await fixture();
  await party(f, 'Acme', '9876543210', 50000);
  await sale(f, { ref: 'INV-1', partyName: 'Acme', amount: 30000 });
  await sale(f, { ref: 'INV-2', partyName: 'Acme', amount: 20000 });

  const p = await share.preview(ctxFor(f, '?kind=statement&subject=Acme'), f.co.tally_guid);
  assert.equal(p.recipient, '9876543210');
  assert.match(p.message, /₹500/);
  assert.match(p.message, /INV-1/);
  assert.match(p.message, /Sh Co Traders/, 'the formal name, as on a document');
});

test('a statement is capped, so it stays readable on a phone', async () => {
  const f = await fixture();
  await party(f, 'Acme');
  for (let n = 1; n <= 30; n++) {
    await sale(f, { ref: `INV-${n}`, partyName: 'Acme', amount: 1000 });
  }
  const p = await share.preview(
    ctxFor(f, '?kind=statement&subject=Acme&limit=10'), f.co.tally_guid);
  // A WhatsApp nobody scrolls to the end of communicates nothing.
  assert.equal(p.variables.count, '10');
});

// --- outstanding ------------------------------------------------------------

test('an outstanding message lists each bill with how late it is', async () => {
  const f = await fixture();
  await party(f, 'Acme', '9876543210', 30000);
  await sale(f, { ref: 'INV-1', partyName: 'Acme', amount: 30000,
    date: '2026-01-01', due: '2026-02-01' });
  // An anchor so "today" is well past the due date.
  await sale(f, { ref: 'INV-9', partyName: 'Other', amount: 100, date: '2026-06-01' });

  const p = await share.preview(ctxFor(f, '?kind=outstanding&subject=Acme'), f.co.tally_guid);
  assert.match(p.message, /INV-1/);
  assert.match(p.message, /days overdue/);
  assert.match(p.message, /past their due date/);
});

test('a settled bill never appears in an outstanding message', async () => {
  const f = await fixture();
  await party(f, 'Acme', '9876543210', 0);
  const id = await sale(f, { ref: 'INV-1', partyName: 'Acme', amount: 30000 });
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'r1','R','Receipt','2026-06-01','Acme',30000) RETURNING id`, [f.co.id]);
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date,
                        amount_paise, bill_type)
     VALUES ($1,$2,'INV-1','Cash','2026-06-01','2026-05-31',-30000,'Agst Ref')`,
    [f.co.id, rows[0].id]);

  const p = await share.preview(ctxFor(f, '?kind=outstanding&subject=Acme'), f.co.tally_guid);
  // Telling a customer they still owe money they have paid is the worst
  // thing this could do.
  assert.match(p.message, /Nothing outstanding/);
});

test('nothing overdue produces no complaint about being overdue', async () => {
  const f = await fixture();
  await party(f, 'Acme', '9876543210', 30000);
  await sale(f, { ref: 'INV-1', partyName: 'Acme', amount: 30000,
    date: '2026-05-01', due: '2027-05-01' });

  const p = await share.preview(ctxFor(f, '?kind=outstanding&subject=Acme'), f.co.tally_guid);
  // "0 of these are past their due date" reads as an accusation where none
  // is meant, so the line is omitted entirely.
  assert.equal(p.variables.overdueNote, '');
  assert.ok(!/past their due date/.test(p.message));
});

// --- invoices and items -----------------------------------------------------

test('an invoice message carries the total in words', async () => {
  const f = await fixture();
  await party(f, 'Acme');
  const id = await sale(f, { ref: 'INV-1', partyName: 'Acme', amount: 150000 });
  const p = await share.preview(
    ctxFor(f, `?kind=invoice&subject=${id}`), f.co.tally_guid);
  assert.match(p.message, /₹1,500/);
  assert.match(p.message, /Rupees One Thousand Five Hundred Only/);
});

test('an entry with no item lines says so rather than looking empty', async () => {
  const f = await fixture();
  await party(f, 'Acme');
  const id = await sale(f, { ref: 'INV-1', partyName: 'Acme', amount: 1000 });
  const p = await share.preview(ctxFor(f, `?kind=invoice&subject=${id}`), f.co.tally_guid);
  assert.match(p.message, /no item lines/);
});

test('an item message answers "have you got it"', async () => {
  const f = await fixture();
  await query(
    `INSERT INTO stock_items (company_id, guid, name, unit, closing_qty, hsn, gst_rate_bp)
     VALUES ($1,'i1','Cement','Bag',40,'25232910',2800)`, [f.co.id]);
  const p = await share.preview(ctxFor(f, '?kind=item&subject=Cement'), f.co.tally_guid);
  assert.match(p.message, /In stock: 40 Bag/);
  assert.match(p.message, /25232910/);
  assert.match(p.message, /28%/);
});

// --- guards -----------------------------------------------------------------

test('an unknown kind is refused, and says what is available', async () => {
  const f = await fixture();
  await assert.rejects(
    () => share.preview(ctxFor(f, '?kind=nonsense'), f.co.tally_guid),
    (e) => e.status === 400 && /statement/.test(e.message));
});

test('an unknown subject is a 404, not an empty message', async () => {
  const f = await fixture();
  await assert.rejects(
    () => share.preview(ctxFor(f, '?kind=statement&subject=Nobody'), f.co.tally_guid),
    (e) => e.status === 404);
});

test('sharing needs permission to see the thing being shared', async () => {
  const f = await fixture();
  await party(f, 'Acme');
  const limited = {
    ...ctxFor(f, '?kind=statement&subject=Acme'),
    session: {
      org: { id: f.orgId },
      // Can see ledgers, but has not been given share.
      user: { id: f.userId, role: 'member', roleId: 'r', permissions: { ledgers: ['read'] } },
    },
  };
  await assert.rejects(() => share.preview(limited, f.co.tally_guid), (e) => e.status === 403);
});

test('a share cannot reach another company', async () => {
  const a = await fixture();
  const b = await fixture();
  await party(a, 'Acme');
  await assert.rejects(
    () => share.preview(ctxFor(b, '?kind=statement&subject=Acme'), a.co.tally_guid),
    (e) => e.status === 404);
});

// --- the log ----------------------------------------------------------------

test('a share is recorded as handed off, never as delivered', async () => {
  const f = await fixture();
  const r = await share.record(
    ctxFor(f, '', { kind: 'statement', subject: 'Acme', status: 'delivered' }),
    f.co.tally_guid);
  // Handing a message to WhatsApp says nothing about whether it arrived.
  assert.equal(r.status, 'handed-off');
  assert.match(r.note, /did not send it/);
});

test('the log answers "did we send Verma his statement"', async () => {
  const f = await fixture();
  await share.record(ctxFor(f, '', {
    kind: 'statement', subject: 'Verma', recipient: '99', status: 'sent' }), f.co.tally_guid);
  await share.record(ctxFor(f, '', {
    kind: 'outstanding', subject: 'Acme', status: 'handed-off' }), f.co.tally_guid);

  const all = await share.log(ctxFor(f));
  assert.equal(all.shares.length, 2);
  const one = await share.log(ctxFor(f, '?subject=Verma'));
  assert.equal(one.shares.length, 1);
  assert.equal(one.shares[0].status, 'sent');
  assert.equal(one.shares[0].by, 'Owner');
});

test('a template can be edited and is used', async () => {
  const f = await fixture();
  await party(f, 'Acme', '9876543210', 50000);
  const t = await share.templates(ctxFor(f));
  const stmt = t.templates.find((x) => x.kind === 'statement');

  await share.saveTemplate(
    ctxFor(f, '', { body: 'Namaste {{party}}. Balance {{balance}}.' }), stmt.id);
  const p = await share.preview(ctxFor(f, '?kind=statement&subject=Acme'), f.co.tally_guid);
  assert.match(p.message, /^Namaste Acme\. Balance ₹500\.$/);
});

test('an empty template is refused', async () => {
  const f = await fixture();
  const t = await share.templates(ctxFor(f));
  await assert.rejects(
    () => share.saveTemplate(ctxFor(f, '', { body: 'x' }), t.templates[0].id),
    (e) => e.status === 400);
});

test('a report is shared as whatever the person had on screen', async () => {
  const f = await fixture();
  const p = await share.preview(
    ctxFor(f, '?kind=report&subject=Trial%20Balance&period=FY%202026-27'
             + '&line=Sundry%20Debtors%20%E2%82%B95%2C000&line=Cash%20%E2%82%B92%2C000'),
    f.co.tally_guid);
  assert.match(p.message, /Trial Balance/);
  assert.match(p.message, /FY 2026-27/);
  assert.match(p.message, /Sundry Debtors/);
});

test('a huge report is trimmed rather than sent whole', async () => {
  const f = await fixture();
  const many = Array.from({ length: 200 }, (_, i) => `line=Row${i}`).join('&');
  const p = await share.preview(
    ctxFor(f, `?kind=report&subject=Big&${many}`), f.co.tally_guid);
  // 200 rows in a WhatsApp is not a report, it is a wall.
  assert.ok(p.message.split('\n').filter((l) => /^Row/.test(l)).length <= 40);
});
