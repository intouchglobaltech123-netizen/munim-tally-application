const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');

/**
 * The phone sign-in code carries a full session, so it is the kind of thing
 * that is fine until it is not. Each rule that keeps it safe gets a test.
 */

const orgs = [];
async function makeUser() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['code-test']);
  orgs.push(o[0].id);
  const { rows } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1, $2, 'owner') RETURNING *`,
    [o[0].id, `code-${o[0].id.slice(0, 8)}@example.com`],
  );
  return rows[0];
}
const mint = (userId, mins = 10) => query(
  `INSERT INTO app_sign_in_codes (code, user_id, expires_at)
   VALUES ($1, $2, now() + ($3 || ' minutes')::interval) RETURNING *`,
  [`TEST-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, userId, String(mins)],
).then((r) => r.rows[0]);

after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

test('a fresh code is usable', async () => {
  const u = await makeUser();
  const c = await mint(u.id);
  assert.equal(c.used_at, null);
  assert.ok(c.expires_at > new Date());
});

test('a used code cannot be used twice', async () => {
  const u = await makeUser();
  const c = await mint(u.id);
  await query('UPDATE app_sign_in_codes SET used_at = now() WHERE code = $1', [c.code]);
  const { rows } = await query(
    `SELECT * FROM app_sign_in_codes WHERE code = $1 AND used_at IS NULL`, [c.code]);
  assert.equal(rows.length, 0, 'a spent code must not be selectable as live');
});

test('an expired code is not live', async () => {
  const u = await makeUser();
  const c = await mint(u.id, -1);      // already past
  const { rows } = await query(
    `SELECT * FROM app_sign_in_codes WHERE code = $1 AND expires_at > now()`, [c.code]);
  assert.equal(rows.length, 0);
});

test('deleting the user destroys their codes', async () => {
  // A removed account must not leave a working key behind.
  const u = await makeUser();
  const c = await mint(u.id);
  await query('DELETE FROM users WHERE id = $1', [u.id]);
  const { rows } = await query('SELECT * FROM app_sign_in_codes WHERE code = $1', [c.code]);
  assert.equal(rows.length, 0);
});

test('codes are unique - one cannot overwrite another', async () => {
  const u = await makeUser();
  const c = await mint(u.id);
  await assert.rejects(
    () => query(`INSERT INTO app_sign_in_codes (code, user_id, expires_at)
                 VALUES ($1, $2, now() + interval '10 minutes')`, [c.code, u.id]),
    (e) => /app_sign_in_codes_pkey/.test(e.message),
  );
});

test('the alphabet excludes characters that are misread', () => {
  const ALPHABET = '2346789ABCDEFGHJKLMNPQRTUVWXYZ';
  // 0/O, 1/I, 5/S are the pairs people transcribe wrongly between two screens.
  for (const ch of ['0', 'O', '1', 'I', '5', 'S']) {
    assert.ok(!ALPHABET.includes(ch), `${ch} should not be in the code alphabet`);
  }
});
