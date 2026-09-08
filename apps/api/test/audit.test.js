const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const audit = require('../src/routes/audit');
const { record, diff, ipPrefix, ACTIONS } = require('../src/lib/audit');
const users = require('../src/routes/users');
const company = require('../src/routes/company');

/**
 * The record of who did what.
 *
 * An audit log earns its keep on two counts: it survives the person it
 * describes leaving, and it cannot be quietly edited by whoever it implicates.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['au-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role, name) VALUES ($1,$2,'owner','Alice') RETURNING id`,
    [o[0].id, `au-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Au Co') RETURNING *`,
    [o[0].id, `au-${o[0].id}`]);
  await users.ensureRoles(o[0].id);
  return { orgId: o[0].id, userId: u[0].id, email: u[0].email, co: c[0] };
}

const ctxFor = (f, body = {}, qs = '') => ({
  session: {
    org: { id: f.orgId },
    user: { id: f.userId, role: 'owner', roleId: null, name: 'Alice',
            email: `au-${f.orgId.slice(0, 8)}@example.com` },
  },
  req: { headers: { 'x-munim-device': 'Chrome on Windows',
                    'x-forwarded-for': '203.0.113.42' }, socket: {} },
  url: new URL(`http://x/${qs}`), body,
});

// --- the diff ---------------------------------------------------------------

test('only what changed is recorded', () => {
  // A settings save that touched one checkbox should read as one line, not as
  // the whole record stored twice.
  assert.deepEqual(diff({ a: 1, b: 2, c: 3 }, { a: 1, b: 99, c: 3 }),
    { before: { b: 2 }, after: { b: 99 } });
});

test('an unchanged save records no diff at all', () => {
  assert.deepEqual(diff({ a: 1 }, { a: 1 }), { before: null, after: null });
});

test('nested values are compared by content, not by reference', () => {
  assert.deepEqual(diff({ p: { x: 1 } }, { p: { x: 1 } }), { before: null, after: null });
  const changed = diff({ p: { x: 1 } }, { p: { x: 2 } });
  assert.deepEqual(changed.after, { p: { x: 2 } });
});

// --- what is kept -----------------------------------------------------------

test('an address is kept only as a /24', () => {
  assert.equal(ipPrefix({ req: { headers: { 'x-forwarded-for': '203.0.113.42' } } }),
    '203.0.113.0/24');
  assert.equal(ipPrefix({}), '');
});

test('an entry survives the person being deleted', async () => {
  const f = await fixture();
  await record(ctxFor(f), 'user.disable', { entityName: 'Bob' });
  // The user row goes; the entry must still say who did it.
  await query('DELETE FROM users WHERE id = $1', [f.userId]);

  const { rows } = await query(
    'SELECT actor_name, actor_email, user_id FROM audit_log WHERE org_id = $1', [f.orgId]);
  assert.equal(rows[0].user_id, null, 'the foreign key is cleared');
  assert.equal(rows[0].actor_name, 'Alice', 'the name is not');
});

test('writing an entry never throws', async () => {
  // An entry is a record OF something that already happened; failing to write
  // it must not undo the thing it describes.
  await record(null, 'user.update', {});
  await record({}, 'nonexistent.action', { before: undefined });
  await record({ session: { org: { id: 'not-a-uuid' } } }, 'user.update', {});
  assert.ok(true);
});

test('every action raised in code has a label', () => {
  // An unlabelled action reads as a raw key in the log, which is the same as
  // not recording it.
  for (const key of ['user.update', 'role.update', 'company.settings',
    'backup.restore', 'share.sent', 'sync.settings']) {
    assert.ok(ACTIONS[key]?.label, `${key} has a label`);
  }
});

// --- through the real handlers ----------------------------------------------

test('changing a role is recorded with what changed', async () => {
  const f = await fixture();
  const made = await users.createRole(ctxFor(f, {
    name: 'Counter', permissions: { sales: ['read'] } }));
  await users.updateRole(ctxFor(f, {
    permissions: { sales: ['read', 'export'] } }), made.role.id);

  const log = await audit.list(ctxFor(f));
  const entry = log.entries.find((e) => e.action === 'role.update');
  // Who can do what is the change most worth being able to look up later.
  assert.ok(entry);
  assert.equal(entry.entityName, 'Counter');
  assert.ok(entry.after.permissions);
});

test('a settings change records the readable value, not the column name', async () => {
  const f = await fixture();
  await company.updateSettings(ctxFor(f, { numberFormat: 'international' }), f.co.tally_guid);

  const log = await audit.list(ctxFor(f));
  const entry = log.entries.find((e) => e.action === 'company.settings');
  assert.ok(entry);
  // "number format: indian → international" reads; "doc_number_format" does not.
  assert.match(entry.changes, /number format: indian → international/);
});

test('the log records where and on what', async () => {
  const f = await fixture();
  await company.updateSettings(ctxFor(f, { decimals: 2 }), f.co.tally_guid);

  const log = await audit.list(ctxFor(f));
  const entry = log.entries[0];
  assert.equal(entry.by, 'Alice');
  assert.equal(entry.ipPrefix, '203.0.113.0/24');
  assert.equal(entry.device, 'Chrome on Windows');
  assert.equal(entry.companyName, 'Au Co');
});

// --- reading ----------------------------------------------------------------

test('entries can be filtered by action, entity and date', async () => {
  const f = await fixture();
  await record(ctxFor(f), 'user.disable', { entityId: 'u1', entityName: 'Bob' });
  await record(ctxFor(f), 'backup.create', { entityId: 'b1' });

  const all = await audit.list(ctxFor(f));
  assert.equal(all.entries.length, 2);

  const one = await audit.list(ctxFor(f, {}, '?action=user.disable'));
  assert.equal(one.entries.length, 1);

  const byEntity = await audit.list(ctxFor(f, {}, '?entity=backup'));
  assert.equal(byEntity.entries.length, 1);

  const future = await audit.list(ctxFor(f, {}, '?from=2099-01-01'));
  assert.equal(future.entries.length, 0);
});

test('search covers who did it as well as what was touched', async () => {
  const f = await fixture();
  await record(ctxFor(f), 'user.disable', { entityName: 'Bob Smith' });

  const byThing = await audit.list(ctxFor(f, {}, '?q=Bob'));
  assert.equal(byThing.entries.length, 1);
  const byPerson = await audit.list(ctxFor(f, {}, '?q=Alice'));
  assert.equal(byPerson.entries.length, 1);
});

test('the action filter only offers actions that have happened', async () => {
  const f = await fixture();
  await record(ctxFor(f), 'backup.create', {});
  const log = await audit.list(ctxFor(f));
  // A filter offering a choice that returns nothing is a broken filter.
  assert.deepEqual(log.actions.map((a) => a.key), ['backup.create']);
});

test('the history of one thing can be pulled out', async () => {
  const f = await fixture();
  await record(ctxFor(f), 'user.update', { entityId: 'u1', entityName: 'Bob' });
  await record(ctxFor(f), 'user.disable', { entityId: 'u1', entityName: 'Bob' });
  await record(ctxFor(f), 'user.update', { entityId: 'u2', entityName: 'Carol' });

  const one = await audit.forEntity(ctxFor(f), 'user', 'u1');
  assert.equal(one.entries.length, 2);
});

// --- who may read it --------------------------------------------------------

test('the log is gated on users, not settings', async () => {
  const f = await fixture();
  await record(ctxFor(f), 'user.disable', { entityName: 'Bob' });

  // It records who changed permissions and who removed people, which is
  // information about staff.
  const settingsOnly = {
    ...ctxFor(f),
    session: {
      org: { id: f.orgId },
      user: { id: f.userId, role: 'member', roleId: 'r',
              permissions: { settings: ['read', 'update'] } },
    },
  };
  await assert.rejects(() => audit.list(settingsOnly), (e) => e.status === 403);
});

test('the log never crosses businesses', async () => {
  const a = await fixture();
  const b = await fixture();
  await record(ctxFor(a), 'user.disable', { entityName: 'Theirs' });

  const mine = await audit.list(ctxFor(b));
  assert.equal(mine.entries.length, 0);
});

test('there is no way to delete an entry', () => {
  // The person most motivated to tidy the log is exactly the person it exists
  // to record, so the module offers nothing that could.
  // Checked by intent rather than against a fixed list, so that adding a
  // read-only route later does not quietly turn this into a test of nothing.
  for (const name of Object.keys(audit)) {
    assert.ok(!/delete|remove|purge|clear|prune|truncate/i.test(name),
      `audit route "${name}" sounds like it can destroy the record`);
  }
  const src = require('fs').readFileSync(
    require.resolve('../src/routes/audit.js'), 'utf8');
  assert.ok(!/DELETE\s+FROM\s+audit_log|UPDATE\s+audit_log/i.test(src),
    'the audit routes must never delete from or rewrite audit_log');
});

test('the log says plainly that it cannot be edited', async () => {
  const f = await fixture();
  const log = await audit.list(ctxFor(f));
  assert.match(log.note, /cannot be edited or deleted/);
});

// --- changes that happened in Tally, not in Munim ---------------------------

/*
 * Munim never writes to Tally, so nobody "does" a voucher change through the
 * app. It is noticed during sync. These tests pin down the judgement call in
 * noteTallyChange: what is worth a line, and - just as important - what is not.
 */
const ingest = require('../src/routes/ingest');
const { noteTallyChange } = ingest.__test ?? {};

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test('an ordinary new voucher is not recorded', () => {
  const trail = [];
  noteTallyChange(trail, 'co', 'g1', { existed: false },
    { vchType: 'Sales', vchNo: '1', date: daysAgo(2), amountPaise: 100 });
  // It is already on screen as itself. Logging every entry would bury the
  // three that matter under ten thousand that do not.
  assert.equal(trail.length, 0);
});

test('a materially back-dated entry is recorded', () => {
  const trail = [];
  noteTallyChange(trail, 'co', 'g1', { existed: false },
    { vchType: 'Sales', vchNo: '7', date: daysAgo(120), amountPaise: 500000 });
  assert.equal(trail.length, 1);
  assert.equal(trail[0].action, 'voucher.backdated');
  assert.ok(trail[0].meta.daysBack >= 119);
});

test('a week of catch-up bookkeeping is not treated as back-dating', () => {
  const trail = [];
  noteTallyChange(trail, 'co', 'g1', { existed: false },
    { vchType: 'Sales', vchNo: '8', date: daysAgo(6), amountPaise: 1 });
  assert.equal(trail.length, 0);
});

test('an amount changed in Tally is recorded, with both values', () => {
  const trail = [];
  noteTallyChange(trail, 'co', 'g1', {
    existed: true, prior_vch_no: '42', prior_vch_type: 'Sales',
    prior_vch_date: '2026-01-10', prior_party: 'Ravi', prior_amount_paise: 480000,
    prior_is_cancelled: false,
  }, { vchType: 'Sales', vchNo: '42', date: '2026-01-10', party: 'Ravi',
       amountPaise: 120000, isCancelled: false });

  assert.equal(trail.length, 1);
  assert.equal(trail[0].action, 'voucher.changed');
  assert.equal(trail[0].before.amountPaise, 480000);
  assert.equal(trail[0].after.amountPaise, 120000);
  assert.equal(trail[0].name, 'Sales #42');
});

test('a voucher cancelled in Tally is recorded', () => {
  const trail = [];
  noteTallyChange(trail, 'co', 'g1', {
    existed: true, prior_vch_no: '9', prior_vch_type: 'Sales',
    prior_vch_date: '2026-01-10', prior_party: 'Ravi', prior_amount_paise: 1000,
    prior_is_cancelled: false,
  }, { vchType: 'Sales', vchNo: '9', date: '2026-01-10', party: 'Ravi',
       amountPaise: 1000, isCancelled: true });
  assert.equal(trail.length, 1);
  assert.equal(trail[0].after.cancelled, true);
});

test('a record re-sent unchanged writes nothing', () => {
  // Tally raises ALTERID for edits Munim does not even store, so the same
  // voucher arrives again and again. Every one of those must stay silent.
  const trail = [];
  noteTallyChange(trail, 'co', 'g1', {
    existed: true, prior_vch_no: '42', prior_vch_type: 'Sales',
    prior_vch_date: '2026-01-10', prior_party: 'Ravi', prior_amount_paise: 480000,
    prior_is_cancelled: false,
  }, { vchType: 'Sales', vchNo: '42', date: '2026-01-10', party: 'Ravi',
       amountPaise: 480000, isCancelled: false });
  assert.equal(trail.length, 0);
});

test('a date shifted by a day still counts as a change', () => {
  const trail = [];
  noteTallyChange(trail, 'co', 'g1', {
    existed: true, prior_vch_no: '42', prior_vch_type: 'Sales',
    prior_vch_date: new Date('2026-01-10T00:00:00Z'), prior_party: 'Ravi',
    prior_amount_paise: 1000, prior_is_cancelled: false,
  }, { vchType: 'Sales', vchNo: '42', date: '2026-01-11', party: 'Ravi',
       amountPaise: 1000, isCancelled: false });
  assert.equal(trail.length, 1);
  assert.equal(trail[0].before.date, '2026-01-10');
});

// --- what the client is allowed to report ----------------------------------

test('the client may report an export', async () => {
  const f = await fixture();
  await audit.clientEvent(ctxFor(f, { action: 'export.csv', name: 'sales.csv', rows: 40 }));
  const { entries } = await audit.list(ctxFor(f));
  assert.equal(entries[0].action, 'export.csv');
  assert.equal(entries[0].entityName, 'sales.csv');
});

test('the client cannot forge an entry it did not do', async () => {
  const f = await fixture();
  // A client-reported event is only as trustworthy as the client, so the route
  // takes a fixed whitelist. Nothing here may invent a role change.
  await assert.rejects(
    () => audit.clientEvent(ctxFor(f, { action: 'role.update', entityName: 'Owner' })),
    /not something the app reports/i);
});

test('every action the code raises is one the log can name', () => {
  // An unnamed action renders as a raw key like "voucher.backdated" in front of
  // a shop owner, which is not an audit log anybody can read.
  const { execSync } = require('child_process');
  const out = execSync(
    "grep -rho \"audit.record([a-zA-Z]*, '[a-z.]*'\" src | sed \"s/.*'\\(.*\\)'/\\1/\" | sort -u",
    { cwd: require('path').join(__dirname, '..'), encoding: 'utf8' });
  const raised = out.split('\n').filter(Boolean);
  assert.ok(raised.length > 15, `expected many actions, found ${raised.length}`);
  for (const a of raised) {
    assert.ok(ACTIONS[a], `action "${a}" is raised in code but has no label`);
  }
});

// --- how an entry reads -----------------------------------------------------

test('a deletion describes what was deleted', () => {
  // Keyed off `after` alone this was the empty string: the entries most worth
  // reading were the ones that said nothing at all.
  const line = audit.describe({
    before_val: { name: '142', party: 'Ravi Traders', amountPaise: 480000 },
    after_val: null,
  });
  assert.match(line, /Ravi Traders/);
  assert.match(line, /142/);
});

test('paise are shown as rupees', () => {
  // "amountPaise: 480000" reads as four hundred and eighty thousand rupees
  // when it means four thousand eight hundred.
  const line = audit.describe({
    before_val: { amountPaise: 480000 }, after_val: { amountPaise: 120000 },
  });
  assert.match(line, /₹4,800\.00 → ₹1,200\.00/);
});

test('a field name is one a shop owner would recognise', () => {
  const line = audit.describe({ before_val: null, after_val: { creditDays: 30 } });
  assert.match(line, /credit days: 30/);
});
