const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const auth = require('../src/lib/auth');

/**
 * Sessions never expire, so the rules that END one are the only thing standing
 * between a sold phone and somebody's books. Each rule gets a test.
 */

const orgs = [];
async function makeUser() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['sess-test']);
  orgs.push(o[0].id);
  const { rows } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1, $2, 'owner') RETURNING *`,
    [o[0].id, `sess-${o[0].id.slice(0, 8)}@example.com`]);
  return rows[0];
}
const signIn = (userId, kind, label) => query(
  `INSERT INTO sessions (token_hash, user_id, expires_at, device_kind, device_label, last_seen_at)
   VALUES ($1, $2, NULL, $3, $4, now()) RETURNING token_hash`,
  [`h-${Math.random().toString(36).slice(2)}`, userId, kind, label],
).then((r) => r.rows[0].token_hash);

// What the sign-in route does before issuing a new session.
const replaceKind = (userId, kind) => query(
  `UPDATE sessions SET revoked_at = now()
    WHERE user_id = $1 AND device_kind = $2 AND revoked_at IS NULL`,
  [userId, kind]).then((r) => r.rowCount);

const live = (userId) => query(
  `SELECT device_kind, device_label FROM sessions
    WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
  [userId]).then((r) => r.rows);

after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

test('sessions are created with no expiry - sign in once', async () => {
  const u = await makeUser();
  await signIn(u.id, 'mobile', 'Android 33');
  const { rows } = await query(
    'SELECT expires_at FROM sessions WHERE user_id = $1', [u.id]);
  assert.equal(rows[0].expires_at, null);
});

test('a second phone signs the first one out', async () => {
  const u = await makeUser();
  await signIn(u.id, 'mobile', 'Old phone');
  const replaced = await replaceKind(u.id, 'mobile');
  await signIn(u.id, 'mobile', 'New phone');

  assert.equal(replaced, 1, 'the old phone should have been revoked');
  const rows = await live(u.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device_label, 'New phone');
});

test('signing in on the phone does NOT sign out the web', async () => {
  // The counter PC and the owner's pocket are the normal case.
  const u = await makeUser();
  await signIn(u.id, 'web', 'Shop PC');
  await replaceKind(u.id, 'mobile');
  await signIn(u.id, 'mobile', 'Android 33');

  const rows = await live(u.id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.device_kind).sort(), ['mobile', 'web']);
});

test('a second browser signs the first one out', async () => {
  const u = await makeUser();
  await signIn(u.id, 'web', 'Old laptop');
  const replaced = await replaceKind(u.id, 'web');
  await signIn(u.id, 'web', 'New laptop');
  assert.equal(replaced, 1);
  assert.equal((await live(u.id)).length, 1);
});

test('a revoked session cannot authenticate, however recent', async () => {
  const u = await makeUser();
  const token = auth.newToken('acc');
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, device_kind, last_seen_at)
     VALUES ($1, $2, NULL, 'mobile', now())`,
    [auth.hash(token), u.id]);

  assert.ok(await auth.sessionFor(token), 'should work before revoking');
  await query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1',
    [auth.hash(token)]);
  assert.equal(await auth.sessionFor(token), null, 'a revoked token must not authenticate');
});

test('sign out everywhere leaves only the device that asked', async () => {
  const u = await makeUser();
  const keep = auth.newToken('acc');
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, device_kind, device_label, last_seen_at)
     VALUES ($1, $2, NULL, 'mobile', 'This phone', now())`, [auth.hash(keep), u.id]);
  await signIn(u.id, 'web', 'Somewhere else');
  await signIn(u.id, 'web', 'Another place');

  const cut = await auth.revokeOtherSessions(u.id, keep);
  assert.equal(cut, 2);
  const rows = await live(u.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].device_label, 'This phone');
});
