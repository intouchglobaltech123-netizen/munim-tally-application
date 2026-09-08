const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

/**
 * Encryption at rest.
 *
 * A backup payload is a customer's entire book. These tests are about the one
 * property that matters: a copy of the database, without the key, is worthless.
 */

// Set before the module is loaded, since the key is read from the environment.
process.env.MUNIM_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const secrets = require('../src/lib/secrets');

const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const book = Buffer.from(JSON.stringify({ sales: [{ party: 'Ravi', amount: 480000 }] }));

test('a sealed payload does not contain the plaintext', () => {
  const sealed = secrets.seal(ORG, book);
  assert.ok(!sealed.data.includes(Buffer.from('Ravi')),
    'the party name survived into the ciphertext');
  assert.equal(sealed.alg, 'aes-256-gcm');
});

test('it opens again for the tenant it was sealed for', () => {
  const sealed = secrets.seal(ORG, book);
  assert.deepEqual(secrets.open(ORG, sealed), book);
});

test('one tenant cannot open another tenant\'s backup', () => {
  // The keys are derived per tenant, so a leak of one is not a leak of all.
  const sealed = secrets.seal(ORG, book);
  assert.throws(() => secrets.open(OTHER, sealed), /could not be decrypted/);
});

test('a tampered payload refuses to open rather than decrypting to nonsense', () => {
  // This is the whole reason for GCM over CBC: an altered archive must fail,
  // not restore silently altered books.
  const sealed = secrets.seal(ORG, book);
  sealed.data[3] ^= 0xff;
  assert.throws(() => secrets.open(ORG, sealed), /could not be decrypted/);
});

test('a tampered auth tag refuses to open', () => {
  const sealed = secrets.seal(ORG, book);
  sealed.tag[0] ^= 0xff;
  assert.throws(() => secrets.open(ORG, sealed), /could not be decrypted/);
});

test('every seal uses a fresh IV', () => {
  /*
   * GCM fails catastrophically on IV reuse - two records under one IV leak the
   * XOR of their plaintexts and, worse, the authentication key. Sealing the
   * same book twice must never produce the same bytes.
   */
  const a = secrets.seal(ORG, book);
  const b = secrets.seal(ORG, book);
  assert.notDeepEqual(a.iv, b.iv);
  assert.notDeepEqual(a.data, b.data);
});

test('a backup written before encryption was on still opens', () => {
  // Otherwise switching encryption on would strand every existing backup.
  const plain = { alg: 'none', iv: null, tag: null, data: book };
  assert.deepEqual(secrets.open(ORG, plain), book);
});

test('a short key is rejected loudly, not padded', () => {
  const was = process.env.MUNIM_ENCRYPTION_KEY;
  process.env.MUNIM_ENCRYPTION_KEY = 'abc123';
  assert.throws(() => secrets.seal(ORG, book), /must be 32 bytes/);
  process.env.MUNIM_ENCRYPTION_KEY = was;
});

test('production refuses to start without a key', () => {
  // A warning would be wrong: nobody reads one, and the damage only shows up
  // when the data is already out.
  const wasKey = process.env.MUNIM_ENCRYPTION_KEY;
  const wasEnv = process.env.NODE_ENV;
  delete process.env.MUNIM_ENCRYPTION_KEY;
  process.env.NODE_ENV = 'production';
  assert.throws(() => secrets.assertConfigured(), /not set/);
  process.env.MUNIM_ENCRYPTION_KEY = wasKey;
  process.env.NODE_ENV = wasEnv;
});

test('development is allowed to run without one', () => {
  const wasKey = process.env.MUNIM_ENCRYPTION_KEY;
  const wasEnv = process.env.NODE_ENV;
  delete process.env.MUNIM_ENCRYPTION_KEY;
  process.env.NODE_ENV = 'development';
  assert.equal(secrets.assertConfigured().encryption, 'off');
  process.env.MUNIM_ENCRYPTION_KEY = wasKey;
  process.env.NODE_ENV = wasEnv;
});

test('a generated key is the right size and hex', () => {
  assert.match(secrets.generateKey(), /^[0-9a-f]{64}$/);
});
