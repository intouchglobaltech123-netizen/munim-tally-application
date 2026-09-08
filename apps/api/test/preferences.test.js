const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const prefs = require('../src/routes/preferences');

/**
 * What each person wants their copy of Munim to look like.
 *
 * The interesting properties are about what happens LATER: a widget added in a
 * future release, a person whose permissions were cut, a client sending a shape
 * the server has never seen.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('pref-test','internal') RETURNING *`);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `pf-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Books') RETURNING *`,
    [o[0].id, `pf-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, body = {}, qs = '') => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  req: { headers: {}, socket: {} },
  url: new URL(`http://x/${qs}`), body,
});

// --- the layout -------------------------------------------------------------

test('a core widget added in a later release appears for existing customers', () => {
  /*
   * The reason the layout stores an ORDER and a HIDDEN set rather than a list
   * of visible widgets. Storing "what to show" means anything shipped later is
   * invisible to everybody who ever saved a layout.
   *
   * Scoped to widgets that are part of the dashboard. Opt-in ones are covered
   * by the two tests below, and deliberately do NOT behave this way.
   */
  const saved = { order: ['money', 'today'], hidden: [] };
  const shown = prefs.resolveLayout(saved, () => true).widgets.map((w) => w.key);

  for (const key of prefs.DEFAULT_ORDER) {
    if (!prefs.WIDGETS[key].default) continue;
    assert.ok(shown.includes(key), `"${key}" disappeared for somebody with a saved layout`);
  }
});

test('an opt-in widget stays off until somebody asks for it', () => {
  /*
   * Otherwise every release quietly makes the dashboard longer, and a screen
   * that grows on its own is one people stop reading. `default: false` used to
   * be decorative - resolveLayout ignored it and showed everything.
   */
  const shown = prefs.resolveLayout(null, () => true).widgets.map((w) => w.key);
  for (const key of prefs.DEFAULT_ORDER) {
    if (prefs.WIDGETS[key].default) continue;
    assert.ok(!shown.includes(key), `"${key}" is opt-in but appeared unbidden`);
  }
});

test('an opt-in widget appears once it is deliberately placed', () => {
  const optional = prefs.DEFAULT_ORDER.find((k) => !prefs.WIDGETS[k].default);
  const shown = prefs.resolveLayout({ order: [optional], hidden: [] }, () => true)
    .widgets.map((w) => w.key);
  assert.equal(shown[0], optional);
});

test('an opt-in widget is offered, or nobody could ever find it', () => {
  // Not in `widgets` and not in `hidden` would make it unreachable.
  const l = prefs.resolveLayout(null, () => true);
  const offered = l.hidden.map((h) => h.key);
  for (const key of prefs.DEFAULT_ORDER) {
    if (prefs.WIDGETS[key].default) continue;
    assert.ok(offered.includes(key), `"${key}" is off and cannot be turned on`);
  }
  assert.ok(l.hidden.some((h) => h.optional), 'the screen cannot tell the two apart');
});

test('a saved order is honoured, and the rest follow', () => {
  const l = prefs.resolveLayout({ order: ['cashflow', 'money'], hidden: [] }, () => true);
  assert.equal(l.widgets[0].key, 'cashflow');
  assert.equal(l.widgets[1].key, 'money');
  assert.equal(l.widgets[2].key, 'today', 'the default order continues from there');
});

test('a hidden widget is not rendered but is still offered back', () => {
  // Otherwise there is no way to un-hide it.
  const l = prefs.resolveLayout({ order: [], hidden: ['landscape'] }, () => true);
  assert.ok(!l.widgets.some((w) => w.key === 'landscape'));
  assert.ok(l.hidden.some((h) => h.key === 'landscape'));
});

test('a widget the person cannot read is removed on the server', () => {
  /*
   * Hiding it in the client would still ship them the data, which is the whole
   * difference between a layout preference and a permission.
   */
  const l = prefs.resolveLayout(null, (m) => m !== 'cashbank');
  assert.ok(!l.widgets.some((w) => w.module === 'cashbank'));
});

test('an unknown widget key in stored data is dropped, not rendered', () => {
  // A key from an older release, or a client that invented one.
  const l = prefs.resolveLayout({ order: ['nonsense', 'money'], hidden: ['alsofake'] },
    () => true);
  assert.equal(l.widgets[0].key, 'money');
  assert.ok(!l.widgets.some((w) => w.key === 'nonsense'));
});

test('the catalogue is sent so the two apps cannot drift', () => {
  // Hardcoding the widget list in each client is how the web and the phone end
  // up offering different ones.
  const l = prefs.resolveLayout(null, () => true);
  assert.equal(l.catalogue.length, prefs.DEFAULT_ORDER.length);
  assert.ok(l.catalogue.every((c) => c.label && c.module));
});

// --- storing ----------------------------------------------------------------

test('a preference is saved and read back', async () => {
  const f = await fixture();
  await prefs.set(ctxFor(f, {
    key: 'dashboard.layout',
    company: f.co.tally_guid,
    value: { order: ['cashflow'], hidden: ['today'], period: 'month' },
  }));

  const got = await prefs.get(ctxFor(f, {}, `?company=${f.co.tally_guid}`));
  assert.deepEqual(got.preferences['dashboard.layout'].order, ['cashflow']);
  assert.equal(got.preferences['dashboard.layout'].period, 'month');
  assert.equal(got.dashboard.widgets[0].key, 'cashflow');
});

test('saving twice updates rather than accumulating', async () => {
  const f = await fixture();
  for (const p of ['month', 'quarter', 'fy']) {
    await prefs.set(ctxFor(f, {
      key: 'dashboard.layout', company: f.co.tally_guid, value: { period: p } }));
  }
  const { rows } = await query(
    `SELECT count(*)::int n FROM preferences WHERE user_id = $1 AND key = 'dashboard.layout'`,
    [f.userId]);
  assert.equal(rows[0].n, 1);
});

test('a global preference does not accumulate a row per save either', async () => {
  /*
   * The primary key does not deduplicate rows where company_id IS NULL,
   * because NULL is not equal to itself. Without the partial index a person
   * gains a row on every save and the newest wins only by luck.
   */
  const f = await fixture();
  for (const l of ['dashboard', 'outstanding', 'kpi']) {
    await prefs.set(ctxFor(f, { key: 'app.preferences', value: { landing: l } }));
  }
  const { rows } = await query(
    `SELECT count(*)::int n FROM preferences WHERE user_id = $1 AND key = 'app.preferences'`,
    [f.userId]);
  assert.equal(rows[0].n, 1);

  const got = await prefs.get(ctxFor(f));
  assert.equal(got.preferences['app.preferences'].landing, 'kpi');
});

test('a client cannot invent a preference key', async () => {
  const f = await fixture();
  await assert.rejects(
    () => prefs.set(ctxFor(f, { key: 'evil.thing', value: { a: 1 } })),
    /does not know that preference/);
});

test('a client cannot store a shape the server does not recognise', async () => {
  /*
   * This table is read back into the UI, so anything accepted is something a
   * future version has to keep understanding.
   */
  const f = await fixture();
  await prefs.set(ctxFor(f, {
    key: 'dashboard.layout',
    company: f.co.tally_guid,
    value: { order: ['money'], hidden: [], period: 'decade', extra: 'junk', compact: 'yes' },
  }));

  const got = await prefs.get(ctxFor(f, {}, `?company=${f.co.tally_guid}`));
  const v = got.preferences['dashboard.layout'];
  assert.equal(v.period, 'fy', 'an unknown period fell back to the default');
  assert.equal(v.compact, false, 'a non-boolean did not become true');
  assert.equal(v.extra, undefined, 'the junk was not stored');
});

test('two people on one account keep separate layouts', async () => {
  // An org-level layout means one of them loses every time.
  const f = await fixture();
  const { rows: other } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'member') RETURNING id`,
    [f.orgId, `pf2-${f.orgId.slice(0, 8)}@example.com`]);

  await prefs.set(ctxFor(f, {
    key: 'dashboard.layout', company: f.co.tally_guid, value: { order: ['cashflow'] } }));

  const theirs = await prefs.get({
    ...ctxFor(f, {}, `?company=${f.co.tally_guid}`),
    session: { org: { id: f.orgId },
               user: { id: other[0].id, role: 'owner', roleId: null } },
  });
  assert.deepEqual(theirs.preferences['dashboard.layout'].order, []);
});

test('one person can lay out two books differently', async () => {
  const f = await fixture();
  const { rows: second } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Second') RETURNING *`,
    [f.orgId, `pf2-${f.orgId}`]);

  await prefs.set(ctxFor(f, {
    key: 'dashboard.layout', company: f.co.tally_guid, value: { order: ['cashflow'] } }));
  await prefs.set(ctxFor(f, {
    key: 'dashboard.layout', company: second[0].tally_guid, value: { order: ['landscape'] } }));

  const a = await prefs.get(ctxFor(f, {}, `?company=${f.co.tally_guid}`));
  const b = await prefs.get(ctxFor(f, {}, `?company=${second[0].tally_guid}`));
  assert.equal(a.dashboard.widgets[0].key, 'cashflow');
  assert.equal(b.dashboard.widgets[0].key, 'landscape');
});

test('a preference can be put back to how it ships', async () => {
  const f = await fixture();
  await prefs.set(ctxFor(f, {
    key: 'dashboard.layout', company: f.co.tally_guid, value: { hidden: ['money'] } }));
  await prefs.reset(ctxFor(f, { key: 'dashboard.layout' }));

  const got = await prefs.get(ctxFor(f, {}, `?company=${f.co.tally_guid}`));
  assert.deepEqual(got.preferences['dashboard.layout'].hidden, []);
});

test('preferences cannot be set against another business\'s books', async () => {
  const a = await fixture();
  const b = await fixture();
  await assert.rejects(
    () => prefs.set({
      ...ctxFor(b, { key: 'dashboard.layout', company: a.co.tally_guid, value: {} }),
    }),
    (e) => e.status === 404);
});

test('a preference dies with the person', async () => {
  // Otherwise a deleted user leaves rows nobody can reach or clean up.
  const f = await fixture();
  await prefs.set(ctxFor(f, { key: 'app.preferences', value: { landing: 'kpi' } }));
  await query('DELETE FROM users WHERE id = $1', [f.userId]);
  const { rows } = await query(
    'SELECT count(*)::int n FROM preferences WHERE user_id = $1', [f.userId]);
  assert.equal(rows[0].n, 0);
});
