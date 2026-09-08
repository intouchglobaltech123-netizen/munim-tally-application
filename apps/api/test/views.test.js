const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const views = require('../src/routes/views');

/**
 * A report, arranged the way one person likes to read it.
 *
 * The rules worth pinning: a view is personal, only its owner can change it,
 * and there is exactly one default per person per report.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['vw-test']);
  orgs.push(o[0].id);
  const mk = async (label) => {
    const { rows } = await query(
      `INSERT INTO users (org_id, email, role, name) VALUES ($1,$2,'owner',$3) RETURNING id`,
      [o[0].id, `${label}-${o[0].id.slice(0, 8)}@example.com`, label]);
    return rows[0].id;
  };
  return { orgId: o[0].id, alice: await mk('Alice'), bob: await mk('Bob') };
}

const ctxFor = (f, userId, body = {}, qs = '') => ({
  session: { org: { id: f.orgId }, user: { id: userId, role: 'owner', roleId: null } },
  url: new URL(`http://x/${qs}`), body,
});

// --- config validation ------------------------------------------------------

test('the column list is the order, and hidden is simply absent', () => {
  const c = views.validateConfig({ columns: ['b', 'a', 'b', 'c'] });
  // One field rather than three that can disagree with each other.
  assert.deepEqual(c.columns, ['b', 'a', 'c']);
});

test('a nonsense sort direction falls back rather than being stored', () => {
  assert.equal(views.validateConfig({ sort: { by: 'x', dir: 'sideways' } }).sort.dir, 'desc');
  assert.equal(views.validateConfig({ sort: { by: 'x', dir: 'asc' } }).sort.dir, 'asc');
});

test('decimals and number format are bounded', () => {
  assert.throws(() => views.validateConfig({ decimals: 9 }), (e) => e.status === 400);
  assert.throws(() => views.validateConfig({ numberFormat: 'martian' }), (e) => e.status === 400);
  assert.equal(views.validateConfig({ decimals: 2 }).decimals, 2);
});

test('a config that is not an object is refused', () => {
  for (const bad of [[], 'x', 5]) {
    assert.throws(() => views.validateConfig(bad), (e) => e.status === 400);
  }
  // Absent is fine - a view with no settings is just the defaults.
  assert.deepEqual(views.validateConfig(undefined), {});
});

test('an absurd number of columns is refused', () => {
  const many = Array.from({ length: 200 }, (_, i) => `c${i}`);
  assert.throws(() => views.validateConfig({ columns: many }), (e) => e.status === 400);
});

// --- saving and loading -----------------------------------------------------

test('a view round-trips', async () => {
  const f = await fixture();
  const made = await views.create(ctxFor(f, f.alice, {
    report: 'trial-balance', name: 'Month end',
    config: { columns: ['group', 'debit'], sort: { by: 'debit', dir: 'desc' }, totals: true },
  }));
  assert.equal(made.view.name, 'Month end');
  assert.deepEqual(made.view.config.columns, ['group', 'debit']);

  const listed = await views.list(ctxFor(f, f.alice, {}, '?report=trial-balance'));
  assert.equal(listed.views.length, 1);
  assert.equal(listed.views[0].mine, true);
});

test('saving the same name again updates rather than duplicating', async () => {
  const f = await fixture();
  await views.create(ctxFor(f, f.alice, {
    report: 'stock', name: 'Mine', config: { columns: ['a'] } }));
  await views.create(ctxFor(f, f.alice, {
    report: 'stock', name: 'Mine', config: { columns: ['b'] } }));

  const listed = await views.list(ctxFor(f, f.alice, {}, '?report=stock'));
  assert.equal(listed.views.length, 1);
  assert.deepEqual(listed.views[0].config.columns, ['b']);
});

test('a view is private until it is shared', async () => {
  const f = await fixture();
  await views.create(ctxFor(f, f.alice, { report: 'stock', name: 'Alice only' }));

  const bobSees = await views.list(ctxFor(f, f.bob, {}, '?report=stock'));
  // One person's preferred columns are not an opinion the business inherits.
  assert.equal(bobSees.views.length, 0);
});

test('a shared view is visible to colleagues and marked as theirs', async () => {
  const f = await fixture();
  await views.create(ctxFor(f, f.alice, {
    report: 'stock', name: 'Team view', shared: true }));

  const bobSees = await views.list(ctxFor(f, f.bob, {}, '?report=stock'));
  assert.equal(bobSees.views.length, 1);
  assert.equal(bobSees.views[0].mine, false);
  assert.equal(bobSees.views[0].owner, 'Alice');
});

test('a colleague cannot edit or delete a shared view', async () => {
  const f = await fixture();
  const made = await views.create(ctxFor(f, f.alice, {
    report: 'stock', name: 'Team view', shared: true }));

  // Otherwise one person's edit silently rearranges a colleague's screen.
  await assert.rejects(
    () => views.update(ctxFor(f, f.bob, { name: 'Mine now' }), made.view.id),
    (e) => e.status === 403 && /someone else/.test(e.message));
  await assert.rejects(
    () => views.remove(ctxFor(f, f.bob), made.view.id), (e) => e.status === 404);
});

// --- defaults ---------------------------------------------------------------

test('there is exactly one default per person per report', async () => {
  const f = await fixture();
  await views.create(ctxFor(f, f.alice, {
    report: 'stock', name: 'First', isDefault: true }));
  await views.create(ctxFor(f, f.alice, {
    report: 'stock', name: 'Second', isDefault: true }));

  const listed = await views.list(ctxFor(f, f.alice, {}, '?report=stock'));
  const defaults = listed.views.filter((v) => v.isDefault);
  // Two defaults means the report opens differently depending on row order.
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].name, 'Second');
});

test('two people can each have their own default for one report', async () => {
  const f = await fixture();
  await views.create(ctxFor(f, f.alice, { report: 'stock', name: 'A', isDefault: true }));
  await views.create(ctxFor(f, f.bob, { report: 'stock', name: 'B', isDefault: true }));

  const a = await views.list(ctxFor(f, f.alice, {}, '?report=stock'));
  const b = await views.list(ctxFor(f, f.bob, {}, '?report=stock'));
  assert.equal(a.views.find((v) => v.isDefault).name, 'A');
  assert.equal(b.views.find((v) => v.isDefault).name, 'B');
});

test('setting a new default clears the old one', async () => {
  const f = await fixture();
  const first = await views.create(ctxFor(f, f.alice, {
    report: 'stock', name: 'First', isDefault: true }));
  const second = await views.create(ctxFor(f, f.alice, { report: 'stock', name: 'Second' }));

  await views.update(ctxFor(f, f.alice, { isDefault: true }), second.view.id);

  const listed = await views.list(ctxFor(f, f.alice, {}, '?report=stock'));
  assert.equal(listed.views.find((v) => v.id === first.view.id).isDefault, false);
  assert.equal(listed.views.find((v) => v.id === second.view.id).isDefault, true);
});

// --- guards -----------------------------------------------------------------

test('a view needs a report and a name', async () => {
  const f = await fixture();
  await assert.rejects(
    () => views.create(ctxFor(f, f.alice, { name: 'x' })), (e) => e.status === 400);
  await assert.rejects(
    () => views.create(ctxFor(f, f.alice, { report: 'stock', name: '  ' })),
    (e) => e.status === 400);
});

test('views never cross businesses', async () => {
  const a = await fixture();
  const b = await fixture();
  const made = await views.create(ctxFor(a, a.alice, { report: 'stock', name: 'Theirs', shared: true }));

  const seen = await views.list(ctxFor(b, b.alice, {}, '?report=stock'));
  assert.equal(seen.views.length, 0);
  await assert.rejects(
    () => views.update(ctxFor(b, b.alice, { name: 'x' }), made.view.id), (e) => e.status === 404);
});

test('deleting your own view works', async () => {
  const f = await fixture();
  const made = await views.create(ctxFor(f, f.alice, { report: 'stock', name: 'Temp' }));
  await views.remove(ctxFor(f, f.alice), made.view.id);
  const listed = await views.list(ctxFor(f, f.alice, {}, '?report=stock'));
  assert.equal(listed.views.length, 0);
});
