const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const rem = require('../src/routes/reminders');

/**
 * Chasing money without pestering anybody.
 *
 * Munim sends nothing: it decides who to chase, writes the message, and hands
 * it to the owner's own WhatsApp. So what is worth testing is the judgement —
 * who appears, how often, and what the message says.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, features) VALUES ($1, '{"reminders":true}'::jsonb) RETURNING id`,
    ['rem-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `rm-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name, phone)
     VALUES ($1,$2,'Rem Co','9000000000') RETURNING *`,
    [o[0].id, `rm-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, body = {}) => ({
  session: {
    org: { id: f.orgId, name: 'Rem Co',
           features: { reminders: true }, plan: 'pro' },
    user: { id: f.userId, role: 'owner', roleId: null },
  },
  url: new URL('http://x/'), body,
});

const party = (f, name, phone = '9876543210', opts = {}) => query(
  `INSERT INTO ledgers (company_id, guid, name, parent_group, phone, credit_days, no_reminders)
   VALUES ($1,$2,$3,'Sundry Debtors',$4,$5,$6)`,
  [f.co.id, `l-${name}`, name, phone, opts.creditDays ?? 30, opts.noReminders ?? false]);

/** A sale on a date, with a bill due `dueDate`. */
async function bill(f, { ref, partyName, amount, billDate, dueDate }) {
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,$3,'Sales',$4,$5,$6) RETURNING id`,
    [f.co.id, `v-${ref}`, ref, billDate, partyName, amount]);
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date,
                        amount_paise, bill_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'New Ref')`,
    [f.co.id, rows[0].id, ref, partyName, billDate, dueDate, amount]);
}

// The books run to 1 June 2026, which is the "today" every rule measures from.
const TODAY = '2026-06-01';
const anchor = (f) => query(
  `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
   VALUES ($1,'anchor','0','Sales',$2,'Anchor',1)`, [f.co.id, TODAY]);

// --- templates --------------------------------------------------------------

test('placeholders are filled, and unknown ones left visible', () => {
  const out = rem.render('Hello {{party}}, you owe {{amount}}. {{nonsense}}',
    { party: 'Acme', amount: '₹500' });
  assert.equal(out, 'Hello Acme, you owe ₹500. {{nonsense}}');
  // Blanking it would produce a sentence with a hole in it and hide the typo.
});

test('every default template uses only real placeholders', async () => {
  const f = await fixture();
  const cfg = await rem.listConfig(ctxFor(f));
  const known = new Set(cfg.placeholders.map((p) => p.key));
  for (const t of cfg.templates) {
    for (const m of t.body.matchAll(/\{\{(\w+)\}\}/g)) {
      assert.ok(known.has(m[1]), `${t.name} uses {{${m[1]}}}, which is not offered`);
    }
  }
});

test('a business gets working templates and rules without configuring anything', async () => {
  const f = await fixture();
  const cfg = await rem.listConfig(ctxFor(f));
  assert.equal(cfg.templates.length, 4);
  assert.equal(cfg.rules.length, 4);
  assert.ok(cfg.rules.every((r) => r.enabled));
});

// --- the worklist -----------------------------------------------------------

test('a bill due in three days is picked up by the before rule', async () => {
  const f = await fixture();
  await anchor(f);
  await party(f, 'Acme');
  await bill(f, { ref: 'INV-1', partyName: 'Acme', amount: 100000,
    billDate: '2026-05-01', dueDate: '2026-06-04' });

  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  assert.equal(w.worklist.length, 1);
  assert.equal(w.worklist[0].rule.trigger, 'before');
});

test('a long-overdue bill gets the final notice, not four messages', async () => {
  const f = await fixture();
  await anchor(f);
  await party(f, 'Acme');
  await bill(f, { ref: 'INV-1', partyName: 'Acme', amount: 100000,
    billDate: '2026-01-01', dueDate: '2026-04-01' });   // 61 days overdue

  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  // Rules are ordered most-overdue first and the first match wins.
  assert.equal(w.worklist.length, 1);
  assert.equal(w.worklist[0].rule.name, 'A month overdue');
});

test('one message per party, however many bills they have', async () => {
  const f = await fixture();
  await anchor(f);
  await party(f, 'Acme');
  for (const n of [1, 2, 3]) {
    await bill(f, { ref: `INV-${n}`, partyName: 'Acme', amount: 10000,
      billDate: '2026-01-01', dueDate: '2026-04-01' });
  }

  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  // Sending three is how a reminder feature becomes a reason to block the
  // sender.
  assert.equal(w.worklist.length, 1);
  assert.equal(w.worklist[0].bills.length, 3);
  assert.equal(w.worklist[0].amountPaise, 30000);
});

test('a long list of bills is shortened in the message', async () => {
  const f = await fixture();
  await anchor(f);
  await party(f, 'Acme');
  for (let n = 1; n <= 9; n++) {
    await bill(f, { ref: `INV-${n}`, partyName: 'Acme', amount: 10000,
      billDate: '2026-01-01', dueDate: '2026-04-01' });
  }

  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  // Nine references in one WhatsApp makes a polite note look like a dunning
  // letter.
  assert.match(w.worklist[0].message, /and 5 more/);
});

test('a party who has asked not to be chased is left alone', async () => {
  const f = await fixture();
  await anchor(f);
  await party(f, 'Acme', '9876543210', { noReminders: true });
  await bill(f, { ref: 'INV-1', partyName: 'Acme', amount: 100000,
    billDate: '2026-01-01', dueDate: '2026-04-01' });

  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  assert.equal(w.worklist.length, 0);
});

test('a bill chased yesterday is not chased again today', async () => {
  const f = await fixture();
  await anchor(f);
  await party(f, 'Acme');
  await bill(f, { ref: 'INV-1', partyName: 'Acme', amount: 100000,
    billDate: '2026-01-01', dueDate: '2026-04-01' });

  await rem.record(ctxFor(f, { party: 'Acme', amountPaise: 100000, status: 'sent' }),
    f.co.tally_guid);

  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  assert.equal(w.worklist.length, 0, 'inside the repeat window');
});

test('chasing stops after the rule\'s limit', async () => {
  const f = await fixture();
  await anchor(f);
  await party(f, 'Acme');
  await bill(f, { ref: 'INV-1', partyName: 'Acme', amount: 100000,
    billDate: '2026-01-01', dueDate: '2026-04-01' });

  // The "a month overdue" rule allows two, then stops.
  for (let i = 0; i < 2; i++) {
    await rem.record(ctxFor(f, { party: 'Acme', amountPaise: 100000, status: 'sent' }),
      f.co.tally_guid);
  }
  await query(
    `UPDATE reminders SET sent_at = now() - interval '60 days' WHERE org_id = $1`, [f.orgId]);

  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  assert.equal(w.worklist.length, 0, 'the limit is reached even after the wait');
});

test('a party with no phone is listed, not hidden', async () => {
  const f = await fixture();
  await anchor(f);
  await party(f, 'Acme', '');
  await bill(f, { ref: 'INV-1', partyName: 'Acme', amount: 100000,
    billDate: '2026-01-01', dueDate: '2026-04-01' });

  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  // Somebody who owes money and cannot be reached is a problem to fix, not a
  // row to drop.
  assert.equal(w.worklist.length, 1);
  assert.equal(w.worklist[0].reachable, false);
  assert.equal(w.totals.unreachable, 1);
});

test('a settled bill is never chased', async () => {
  const f = await fixture();
  await anchor(f);
  await party(f, 'Acme');
  await bill(f, { ref: 'INV-1', partyName: 'Acme', amount: 100000,
    billDate: '2026-01-01', dueDate: '2026-04-01' });
  // The receipt posts against the same reference, from Cash.
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'r1','R','Receipt','2026-05-01','Acme',100000) RETURNING id`, [f.co.id]);
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date,
                        amount_paise, bill_type)
     VALUES ($1,$2,'INV-1','Cash','2026-05-01','2026-04-01',-100000,'Agst Ref')`,
    [f.co.id, rows[0].id]);

  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  // Chasing somebody for money they have already paid is the worst thing this
  // feature could do.
  assert.equal(w.worklist.length, 0);
});

test('a missing value does not leave a sentence with a hole in it', async () => {
  const f = await fixture();
  await query('UPDATE companies SET phone = $2 WHERE id = $1', [f.co.id, '']);
  await anchor(f);
  await party(f, 'Acme');
  await bill(f, { ref: 'INV-1', partyName: 'Acme', amount: 100000,
    billDate: '2026-01-01', dueDate: '2026-04-01' });

  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  // "Please contact us on ." was going out to real customers.
  assert.ok(!/\bon\s*\.\s*$/m.test(w.worklist[0].message));
});

// --- recording --------------------------------------------------------------

test('a reminder records what we actually know, and charges nothing', async () => {
  const f = await fixture();
  await anchor(f);
  const before = await query('SELECT message_credits FROM orgs WHERE id = $1', [f.orgId]);

  const r = await rem.record(
    ctxFor(f, { party: 'Acme', amountPaise: 5000, status: 'handed-off' }), f.co.tally_guid);
  assert.equal(r.status, 'handed-off');

  const after = await query('SELECT message_credits FROM orgs WHERE id = $1', [f.orgId]);
  // Nothing was sent on the customer's behalf, so there is nothing to bill for.
  assert.equal(after.rows[0].message_credits, before.rows[0].message_credits);
});

test('there is no way to claim a message was delivered', async () => {
  const f = await fixture();
  await anchor(f);
  const r = await rem.record(
    ctxFor(f, { party: 'Acme', amountPaise: 5000, status: 'delivered' }), f.co.tally_guid);
  // Handing a message to WhatsApp says nothing about whether it arrived.
  assert.equal(r.status, 'handed-off');
});

test('history separates what was sent from what was skipped', async () => {
  const f = await fixture();
  await anchor(f);
  await rem.record(ctxFor(f, { party: 'A', amountPaise: 100, status: 'sent' }), f.co.tally_guid);
  await rem.record(ctxFor(f, { party: 'B', amountPaise: 200, status: 'skipped' }), f.co.tally_guid);

  const h = await rem.history(ctxFor(f));
  assert.equal(h.last90Days.sent, 1);
  assert.equal(h.last90Days.skipped, 1);
  // Correlation is labelled as correlation.
  assert.match(h.last90Days.caveat, /not who settled because of it/);
});

// --- rules ------------------------------------------------------------------

test('a rule can be turned off and stops matching', async () => {
  const f = await fixture();
  await anchor(f);
  await party(f, 'Acme');
  await bill(f, { ref: 'INV-1', partyName: 'Acme', amount: 100000,
    billDate: '2026-01-01', dueDate: '2026-04-01' });

  const cfg = await rem.listConfig(ctxFor(f));
  for (const r of cfg.rules) {
    await rem.saveRule({ ...ctxFor(f), body: { enabled: false } }, r.id);
  }
  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  assert.equal(w.worklist.length, 0);
});

test('a rule below the minimum amount does not fire', async () => {
  const f = await fixture();
  await anchor(f);
  await party(f, 'Acme');
  await bill(f, { ref: 'INV-1', partyName: 'Acme', amount: 5000,
    billDate: '2026-01-01', dueDate: '2026-04-01' });

  const cfg = await rem.listConfig(ctxFor(f));
  for (const r of cfg.rules) {
    await rem.saveRule({ ...ctxFor(f), body: { minAmountPaise: 100000 } }, r.id);
  }
  // Below this, chasing costs more than the debt is worth.
  const w = await rem.worklist(ctxFor(f), f.co.tally_guid);
  assert.equal(w.worklist.length, 0);
});

test('a nonsense trigger is refused', async () => {
  const f = await fixture();
  const cfg = await rem.listConfig(ctxFor(f));
  await assert.rejects(
    () => rem.saveRule({ ...ctxFor(f), body: { trigger: 'whenever' } }, cfg.rules[0].id),
    (e) => e.status === 400);
});

test('opting a party out and back in works', async () => {
  const f = await fixture();
  await party(f, 'Acme');
  const off = await rem.setOptOut(ctxFor(f, { noReminders: true }), f.co.tally_guid, 'Acme');
  assert.equal(off.noReminders, true);
  const on = await rem.setOptOut(ctxFor(f, { noReminders: false }), f.co.tally_guid, 'Acme');
  assert.equal(on.noReminders, false);
});
