const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const lic = require('../src/routes/licences');

/**
 * A licence key is what a customer pays for, so the rule that matters is that
 * it works once. Everything else here exists to stop that rule being worked
 * around: sharing the key, racing two machines, reviving a revoked key, or
 * reading unredeemed keys out of the database.
 */

const ids = [];
async function makeKey(overrides = {}) {
  const key = lic._mint();
  const { rows } = await query(
    `INSERT INTO licence_keys (key_hash, key_hint, issued_to, expires_at)
     VALUES ($1, $2, 'test', $3) RETURNING id`,
    [lic._hash(key), `${key.slice(0, 9)}-****-****`, overrides.expiresAt ?? null],
  );
  ids.push(rows[0].id);
  return { key, id: rows[0].id };
}
const ctxFor = (key, machine = 'SHOP-PC') => ({ body: { key, machine } });

after(async () => {
  for (const id of ids) await query('DELETE FROM licence_keys WHERE id = $1', [id]);
});

test('a fresh key is accepted', async () => {
  const { key } = await makeKey();
  const r = await lic.redeem(ctxFor(key));
  assert.equal(r.ok, true);
});

test('the same key cannot be used on a second computer', async () => {
  // This is the rule the product is sold on.
  const { key } = await makeKey();
  await lic.redeem(ctxFor(key, 'FIRST-PC'));
  await assert.rejects(
    () => lic.redeem(ctxFor(key, 'SECOND-PC')),
    (e) => e.code === 'LICENCE_IN_USE' && /FIRST-PC/.test(e.message),
    'a second machine must be refused, and told which machine holds it',
  );
});

test('two computers racing the same key: exactly one wins', async () => {
  const { key } = await makeKey();
  const results = await Promise.allSettled([
    lic.redeem(ctxFor(key, 'PC-A')),
    lic.redeem(ctxFor(key, 'PC-B')),
    lic.redeem(ctxFor(key, 'PC-C')),
  ]);
  const won = results.filter((r) => r.status === 'fulfilled');
  assert.equal(won.length, 1, 'the row lock must let only one redemption through');
});

test('an unknown key is refused', async () => {
  await assert.rejects(
    () => lic.redeem(ctxFor('MUNM-ZZZZ-ZZZZ-ZZZZ')),
    (e) => e.code === 'BAD_LICENCE',
  );
});

test('a revoked key stops working', async () => {
  const { key, id } = await makeKey();
  await query('UPDATE licence_keys SET revoked_at = now() WHERE id = $1', [id]);
  await assert.rejects(() => lic.redeem(ctxFor(key)), (e) => e.code === 'LICENCE_REVOKED');
});

test('revoking a key that is already in use still stops it', async () => {
  const { key, id } = await makeKey();
  await lic.redeem(ctxFor(key));
  await query('UPDATE licence_keys SET revoked_at = now() WHERE id = $1', [id]);
  await assert.rejects(() => lic.redeem(ctxFor(key)), (e) => e.code === 'LICENCE_REVOKED');
});

test('an expired key is refused', async () => {
  const { key } = await makeKey({ expiresAt: new Date(Date.now() - 86400000) });
  await assert.rejects(() => lic.redeem(ctxFor(key)), (e) => e.code === 'LICENCE_EXPIRED');
});

test('a key is accepted however it is typed', async () => {
  // Read off an invoice and typed by hand: lower case, spaces, no dashes.
  const { key } = await makeKey();
  const messy = key.toLowerCase().replace(/-/g, ' ');
  const r = await lic.redeem(ctxFor(messy));
  assert.equal(r.ok, true);
});

test('keys are stored hashed, never in plain text', async () => {
  const { key, id } = await makeKey();
  const { rows } = await query('SELECT * FROM licence_keys WHERE id = $1', [id]);
  const dump = JSON.stringify(rows[0]);
  const bare = key.replace(/-/g, '');
  assert.ok(!dump.includes(key) && !dump.includes(bare),
    'a database dump must not reveal usable keys');
  assert.ok(rows[0].key_hint.endsWith('-****-****'), 'the hint must stay masked');
});

test('the alphabet avoids characters people misread', () => {
  for (const ch of ['0', 'O', '1', 'I', '5', 'S']) {
    assert.ok(!lic._mint().includes(ch) || !'0O1I5S'.includes(ch),
      `${ch} should not appear in a generated key`);
  }
  const many = Array.from({ length: 200 }, () => lic._mint()).join('');
  for (const ch of ['0', 'O', '1', 'I', '5', 'S']) {
    assert.ok(!many.includes(ch), `${ch} appeared in a generated key`);
  }
});
