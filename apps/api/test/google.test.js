const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const google = require('../src/lib/google');

/**
 * Every test forges a token and asserts it is refused. The verifier is the only
 * thing standing between a stranger and somebody's books, so each check it
 * makes gets an attack that would succeed without it.
 */

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const pem = (key) => key.export({ type: 'spki', format: 'pem' });
const KID = 'test-key';
const CLIENT = '1234.apps.googleusercontent.com';

google._setCerts({ [KID]: pem(publicKey) }, 10 * 60_000);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(payload, { key = privateKey, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'RS256', kid: KID, ...header });
  const p = b64({
    iss: 'https://accounts.google.com', aud: CLIENT, sub: 'google-uid-1',
    email: 'owner@example.com', email_verified: true,
    iat: now, exp: now + 3600, ...payload,
  });
  if (header.alg === 'none') return `${h}.${p}.`;
  const sig = crypto.createSign('RSA-SHA256').update(`${h}.${p}`).sign(key);
  return `${h}.${p}.${sig.toString('base64url')}`;
}

const verify = (t, clients = [CLIENT]) => google.verifyIdToken(t, clients);

test('accepts a properly signed token', async () => {
  const r = await verify(sign({}));
  assert.equal(r.email, 'owner@example.com');
  assert.equal(r.emailVerified, true);
  assert.equal(r.uid, 'google-uid-1');
});

test('rejects a token signed with a different key', async () => {
  await assert.rejects(() => verify(sign({}, { key: other.privateKey })),
    /signature is not valid/);
});

test('rejects a tampered payload', async () => {
  const [h, , s] = sign({}).split('.');
  const forged = b64({
    iss: 'https://accounts.google.com', aud: CLIENT, sub: 'attacker',
    email: 'victim@example.com', email_verified: true,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  });
  await assert.rejects(() => verify(`${h}.${forged}.${s}`), /signature is not valid/);
});

test('rejects alg:none', async () => {
  await assert.rejects(() => verify(sign({}, { header: { alg: 'none' } })),
    /Unexpected token algorithm/);
});

test('rejects HMAC confusion, where the public key becomes the shared secret', async () => {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', kid: KID });
  const p = b64({ iss: 'https://accounts.google.com', aud: CLIENT, sub: 'x',
    iat: now, exp: now + 3600 });
  const sig = crypto.createHmac('sha256', pem(publicKey)).update(`${h}.${p}`).digest('base64url');
  await assert.rejects(() => verify(`${h}.${p}.${sig}`), /Unexpected token algorithm/);
});

test('rejects a token minted for a different app', async () => {
  // The whole point of the audience check: any Google app could otherwise
  // hand us a valid token and sign its user into someone's books.
  await assert.rejects(() => verify(sign({ aud: 'someone-else.apps.googleusercontent.com' })),
    /issued for another app/);
});

test('accepts any of several configured clients - Android, iOS and web differ', async () => {
  const android = 'android-1.apps.googleusercontent.com';
  const r = await verify(sign({ aud: android }), [CLIENT, android]);
  assert.equal(r.uid, 'google-uid-1');
});

test('rejects the wrong issuer', async () => {
  await assert.rejects(() => verify(sign({ iss: 'https://evil.example.com' })),
    /wrong issuer/);
});

test('accepts the bare accounts.google.com issuer Google also uses', async () => {
  const r = await verify(sign({ iss: 'accounts.google.com' }));
  assert.equal(r.uid, 'google-uid-1');
});

test('rejects an expired token', async () => {
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(() => verify(sign({ iat: now - 7200, exp: now - 3600 })),
    /expired/);
});

test('rejects a token issued in the future', async () => {
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(() => verify(sign({ iat: now + 3600, exp: now + 7200 })),
    /issued in the future/);
});

test('rejects an unknown signing key', async () => {
  await assert.rejects(() => verify(sign({}, { header: { kid: 'not-a-key' } })),
    /unknown key/);
});

test('rejects a token with no subject', async () => {
  await assert.rejects(() => verify(sign({ sub: '' })), /no subject/);
});

test('reports an unverified email as unverified rather than trusting it', async () => {
  // Not an error: the caller decides. But it must never look verified, or an
  // attacker could claim an account by typing its owner's address.
  const r = await verify(sign({ email_verified: false }));
  assert.equal(r.emailVerified, false);
});

test('refuses to verify when no client id is configured', async () => {
  await assert.rejects(() => google.verifyIdToken(sign({}), []), /not configured/);
});

test('rejects malformed input', async () => {
  for (const bad of ['', 'x', 'a.b', 'a.b.c.d', null, undefined, 42]) {
    await assert.rejects(() => verify(bad));
  }
});
