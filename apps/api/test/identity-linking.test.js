const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');

/**
 * Account linking is the part of sign-in where a mistake hands one person
 * another person's books, so the rules are pinned here against a real database.
 *
 * The rules:
 *   - a verified email or a phone identifies an account
 *   - signing in with a second identity fills a BLANK field on the account
 *   - it never overwrites an identity that is already set
 *   - two accounts can never end up sharing a phone or an email
 */

const orgs = [];
async function makeUser({ phone = null, email = null, uid = null }) {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['t']);
  orgs.push(o[0].id);
  const { rows } = await query(
    `INSERT INTO users (org_id, phone, email, firebase_uid, role)
     VALUES ($1, $2, $3, $4, 'owner') RETURNING *`,
    [o[0].id, phone, email, uid],
  );
  return rows[0];
}

after(async () => {
  for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]);
});

test('an account may have a phone only', async () => {
  const u = await makeUser({ phone: '+919000000101' });
  assert.equal(u.email, null);
});

test('an account may have an email only - a Google sign-in has no number', async () => {
  const u = await makeUser({ email: 'shop@example.com' });
  assert.equal(u.phone, null);
});

test('an account with neither identity is rejected', async () => {
  await assert.rejects(
    () => makeUser({}),
    (e) => /users_has_identity/.test(e.message),
    'a user with no phone and no email could never sign in again',
  );
});

test('two accounts cannot share an email, whatever the casing', async () => {
  await makeUser({ email: 'owner@example.com' });
  await assert.rejects(
    () => makeUser({ email: 'OWNER@example.com' }),
    (e) => /users_email_key/.test(e.message),
  );
});

test('many accounts may have no phone at all', async () => {
  // NULLs must not collide: everyone signing in with Google has a null phone.
  await makeUser({ email: 'a@example.com' });
  await makeUser({ email: 'b@example.com' });
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM users WHERE phone IS NULL AND email IN ($1,$2)`,
    ['a@example.com', 'b@example.com'],
  );
  assert.equal(rows[0].n, 2);
});

test('linking fills a blank identity but never overwrites one', async () => {
  const u = await makeUser({ phone: '+919000000102' });

  // Same account signs in with Google: the email is blank, so it is filled.
  await query(
    `UPDATE users SET phone = COALESCE(phone, $2), email = COALESCE(email, $3)
      WHERE id = $1`,
    [u.id, null, 'linked@example.com'],
  );
  let { rows } = await query('SELECT * FROM users WHERE id = $1', [u.id]);
  assert.equal(rows[0].email, 'linked@example.com');
  assert.equal(rows[0].phone, '+919000000102');

  // A different email must NOT replace the one now on the account.
  await query(
    `UPDATE users SET email = COALESCE(email, $2) WHERE id = $1`,
    [u.id, 'attacker@example.com'],
  );
  ({ rows } = await query('SELECT * FROM users WHERE id = $1', [u.id]));
  assert.equal(rows[0].email, 'linked@example.com', 'an existing email was overwritten');
});

test('linking cannot steal an identity that belongs to someone else', async () => {
  await makeUser({ email: 'taken@example.com' });
  const other = await makeUser({ phone: '+919000000103' });
  await assert.rejects(
    () => query(`UPDATE users SET email = COALESCE(email, $2) WHERE id = $1`,
      [other.id, 'taken@example.com']),
    (e) => /users_email_key/.test(e.message),
  );
});
