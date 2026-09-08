const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const security = require('../src/routes/security');
const google = require('../src/lib/google');

/**
 * Sign-in is Google-only, so there is no password here to steal. What is left
 * worth defending: replayed tokens, someone grinding the app code, and the
 * phone already signed in on the shop counter.
 */

const orgs = [];
after(async () => {
  for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]);
  // Anonymous failure rows belong to no org, so they need clearing by hand.
  await query('DELETE FROM login_events WHERE ip_prefix LIKE $1', [`203.${RUN}.%`]);
  // The "never throws" test deliberately logs an event with nothing in it,
  // which carries no network to match on.
  await query(
    `DELETE FROM login_events
      WHERE user_id IS NULL AND email = '' AND ip_prefix = '' AND via = ''`);
});

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['sec-test']);
  orgs.push(o[0].id);
  const email = `sec-${o[0].id.slice(0, 8)}@example.com`;
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING *`,
    [o[0].id, email]);
  return { orgId: o[0].id, user: u[0], email };
}

/*
 * A distinct network per caller.
 *
 * Throttling is keyed on the network, so tests sharing one address would
 * throttle each other - which is the behaviour working, but it makes the
 * suite order-dependent. Each test gets its own /24.
 */
let net = 0;
/*
 * A random second octet per RUN.
 *
 * Failed attempts are recorded with no org_id - that is the point, they may
 * name an account that does not exist - so deleting orgs never cleans them.
 * Reusing fixed addresses meant one run's leftovers throttled the next.
 */
const RUN = 1 + Math.floor(Math.random() * 250);
const nextNet = () => `203.${RUN}.${++net}.42`;

const ctx = (headers = {}, ip = nextNet()) => ({
  req: { headers, socket: { remoteAddress: ip } },
  url: new URL('http://x/'),
  deviceKind: 'web',
  deviceLabel: 'Chrome on Windows',
  body: {},
});
const userCtx = (f, body = {}, qs = '') => ({
  session: { org: { id: f.orgId }, user: { id: f.user.id, email: f.email } },
  url: new URL(`http://x/${qs}`),
  req: { headers: {}, socket: {} },
  body,
});

// --- what we keep about where someone signed in from ------------------------

test('an address is kept only as a /24, never in full', () => {
  assert.equal(security.ipPrefix(ctx({}, '203.0.113.42')), '203.0.113.0/24');
  // Enough to tell "the shop's usual line" from "another country", without a
  // precise record of where the owner was sitting.
  assert.equal(
    security.ipPrefix({ req: { headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' } } }),
    '198.51.100.0/24');
});

test('an IPv6 address keeps only the routing prefix', () => {
  const p = security.ipPrefix({
    req: { headers: {}, socket: { remoteAddress: '2001:db8:85a3:8d3:1319:8a2e:370:7348' } } });
  assert.equal(p, '2001:db8:85a3:8d3::/64');
});

test('an IPv4-mapped IPv6 address is read as IPv4', () => {
  assert.equal(
    security.ipPrefix({ req: { headers: {}, socket: { remoteAddress: '::ffff:203.0.113.9' } } }),
    '203.0.113.0/24');
});

test('a missing address is blank, not a crash', () => {
  assert.equal(security.ipPrefix({}), '');
  assert.equal(security.ipPrefix({ req: { headers: {}, socket: {} } }), '');
});

// --- reading a claim without trusting it -----------------------------------

test('an unverified token claim is read for counting only, and sanitised', () => {
  const tok = (o) => `x.${Buffer.from(JSON.stringify(o)).toString('base64url')}.y`;
  assert.equal(google.unsafeEmailFromToken(tok({ email: 'A@Example.COM ' })), 'a@example.com');
  // A junk token must not be able to write junk into the security log.
  assert.equal(google.unsafeEmailFromToken(tok({ email: 'not an email' })), '');
  assert.equal(google.unsafeEmailFromToken('garbage'), '');
  assert.equal(google.unsafeEmailFromToken(null), '');
});

// --- lockout ----------------------------------------------------------------

test('a run of failures from one network is throttled', async () => {
  const f = await fixture();
  const from = ctx();
  for (let i = 0; i < security.MAX_FAILURES; i++) {
    await security.record(from, { email: f.email, ok: false, via: 'google', reason: 'bad token' });
    // Below the limit, signing in must still be possible.
    if (i < security.MAX_FAILURES - 1) await security.assertNotThrottled(from, f.email);
  }
  await assert.rejects(() => security.assertNotThrottled(from, f.email),
    (e) => e.status === 429 && /too many/i.test(e.message));
});

test('throttling one network does NOT lock the account it named', async () => {
  const f = await fixture();
  const attacker = ctx();
  for (let i = 0; i < security.MAX_FAILURES + 3; i++) {
    await security.record(attacker, { email: f.email, ok: false, via: 'google' });
  }
  await assert.rejects(() => security.assertNotThrottled(attacker, f.email), (e) => e.status === 429);

  /*
   * The whole point of keying on the network.
   *
   * An invalid token can never grant access, so locking the account it named
   * would protect nothing while handing any stranger a way to lock a customer
   * out of their own books. The real owner must still get in.
   */
  const { rows } = await query('SELECT locked_until FROM users WHERE id = $1', [f.user.id]);
  assert.equal(rows[0].locked_until, null);
  await security.assertNotLocked(f.email);

  // And from their own network they are not throttled either.
  const owner = { req: { headers: {}, socket: { remoteAddress: '198.51.100.5' } } };
  await security.assertNotThrottled(owner, f.email);
});

test('old failures fall outside the window and do not count', async () => {
  const f = await fixture();
  const from = ctx();
  for (let i = 0; i < security.MAX_FAILURES; i++) {
    await security.record(from, { email: f.email, ok: false, via: 'google' });
  }
  await query(
    `UPDATE login_events SET at = now() - ($2 || ' minutes')::interval
      WHERE lower(email) = lower($1)`, [f.email, String(security.WINDOW_MINUTES + 5)]);
  // Not a grudge: only a run of failures matters.
  await security.assertNotThrottled(from, f.email);
});

test('a successful sign-in wipes the failures', async () => {
  const f = await fixture();
  const from = ctx();
  for (let i = 0; i < security.MAX_FAILURES - 1; i++) {
    await security.record(from, { email: f.email, ok: false, via: 'google' });
  }
  await security.clearFailures(f.user.id, f.email);
  const { rows } = await query(
    'SELECT count(*)::int AS n FROM login_events WHERE lower(email) = lower($1) AND NOT ok',
    [f.email]);
  assert.equal(rows[0].n, 0);
});

test('an account lock is timed, and says how long', async () => {
  const f = await fixture();
  // Only a guessable secret we issued can set this - the app sign-in code.
  await security.lockAccount(f.user.id);
  await assert.rejects(() => security.assertNotLocked(f.email),
    (e) => e.status === 429 && /minute/i.test(e.message));

  const { rows } = await query('SELECT locked_until FROM users WHERE id = $1', [f.user.id]);
  // Timed, not permanent: a real owner locked out for good is a lost customer.
  assert.ok(new Date(rows[0].locked_until) > new Date());
});

test('a locked account stays locked until the clock runs out', async () => {
  const f = await fixture();
  await query(
    `UPDATE users SET locked_until = now() + interval '10 minutes' WHERE id = $1`, [f.user.id]);
  await assert.rejects(() => security.assertNotLocked(f.email), (e) => e.status === 429);

  await query(
    `UPDATE users SET locked_until = now() - interval '1 minute' WHERE id = $1`, [f.user.id]);
  await security.assertNotLocked(f.email);
});

test('logging an attempt never throws, whatever it is given', async () => {
  // Logging must never be able to break signing in.
  await security.record({}, { email: null, ok: false });
  await security.record(ctx(), { userId: '00000000-0000-0000-0000-000000000000', ok: true });
  assert.ok(true);
});

// --- history ----------------------------------------------------------------

test('history shows both successes and failures, newest first', async () => {
  const f = await fixture();
  await security.record(ctx(), { userId: f.user.id, orgId: f.orgId, email: f.email,
    ok: false, via: 'google', reason: 'bad token' });
  await security.record(ctx(), { userId: f.user.id, orgId: f.orgId, email: f.email,
    ok: true, via: 'google' });

  const h = await security.loginHistory(userCtx(f));
  assert.equal(h.events.length, 2);
  assert.equal(h.events[0].ok, true);
  assert.equal(h.events[1].reason, 'bad token');
  assert.equal(h.events[0].deviceLabel, 'Chrome on Windows');
  // The one signal that somebody else has the owner's token.
  assert.equal(h.failedLast30Days, 1);
});

// --- devices ----------------------------------------------------------------

async function withSession(f) {
  const hash = `h-${Math.random().toString(36).slice(2)}`;
  await query(
    `INSERT INTO sessions (token_hash, user_id, device_label, device_kind)
     VALUES ($1,$2,'Chrome','web')`, [hash, f.user.id]);
  return hash;
}

test('a device can be given a name a human recognises', async () => {
  const f = await fixture();
  const hash = await withSession(f);
  await security.updateDevice(userCtx(f, { nickname: 'Shop counter iPad' }), hash.slice(0, 8));
  const { rows } = await query('SELECT nickname FROM sessions WHERE token_hash = $1', [hash]);
  // "Mozilla/5.0..." is not something anyone can match to a physical object.
  assert.equal(rows[0].nickname, 'Shop counter iPad');
});

test('a device can be trusted and untrusted', async () => {
  const f = await fixture();
  const hash = await withSession(f);
  await security.updateDevice(userCtx(f, { trusted: true }), hash.slice(0, 8));
  let { rows } = await query('SELECT trusted FROM sessions WHERE token_hash = $1', [hash]);
  assert.equal(rows[0].trusted, true);

  await security.updateDevice(userCtx(f, { trusted: false }), hash.slice(0, 8));
  ({ rows } = await query('SELECT trusted FROM sessions WHERE token_hash = $1', [hash]));
  assert.equal(rows[0].trusted, false);
});

test('one user cannot rename another user\'s device', async () => {
  const a = await fixture();
  const b = await fixture();
  const hash = await withSession(a);
  // However the id was guessed, it must not address somebody else's session.
  await assert.rejects(
    () => security.updateDevice(userCtx(b, { nickname: 'mine now' }), hash.slice(0, 8)),
    (e) => e.status === 404);
  const { rows } = await query('SELECT nickname FROM sessions WHERE token_hash = $1', [hash]);
  assert.equal(rows[0].nickname, '');
});

// --- the app lock -----------------------------------------------------------

test('a PIN can be set and then checked', async () => {
  const f = await fixture();
  const r = await security.setAppLock(userCtx(f, { pin: '4827', minutes: 5 }));
  assert.equal(r.enabled, true);
  assert.equal(r.minutes, 5);

  assert.equal((await security.checkAppLock(userCtx(f, { pin: '4827' }))).ok, true);
  assert.equal((await security.checkAppLock(userCtx(f, { pin: '4828' }))).ok, false);
});

test('the PIN is never stored in the clear', async () => {
  const f = await fixture();
  await security.setAppLock(userCtx(f, { pin: '4827' }));
  const { rows } = await query(
    'SELECT app_lock_hash, app_lock_salt FROM users WHERE id = $1', [f.user.id]);
  assert.ok(!rows[0].app_lock_hash.includes('4827'));
  assert.equal(rows[0].app_lock_hash.length, 64, 'a 32-byte digest in hex');
  assert.ok(rows[0].app_lock_salt.length >= 32, 'salted per user');
});

test('two accounts with the same PIN get different hashes', async () => {
  const a = await fixture();
  const b = await fixture();
  await security.setAppLock(userCtx(a, { pin: '4827' }));
  await security.setAppLock(userCtx(b, { pin: '4827' }));
  const { rows } = await query(
    'SELECT app_lock_hash FROM users WHERE id = ANY($1)', [[a.user.id, b.user.id]]);
  // Per-user salt, so one leaked table cannot be attacked in bulk.
  assert.notEqual(rows[0].app_lock_hash, rows[1].app_lock_hash);
});

test('obvious PINs are refused', async () => {
  const f = await fixture();
  for (const weak of ['1234', '0000', '1111', '4321', '123456']) {
    await assert.rejects(
      () => security.setAppLock(userCtx(f, { pin: weak })),
      (e) => e.status === 400, `${weak} should be refused`);
  }
});

test('a PIN must be 4 to 8 digits', async () => {
  const f = await fixture();
  for (const bad of ['123', '123456789', 'abcd', '', '12a4']) {
    await assert.rejects(
      () => security.setAppLock(userCtx(f, { pin: bad })), (e) => e.status === 400);
  }
});

test('the lock can be turned off', async () => {
  const f = await fixture();
  await security.setAppLock(userCtx(f, { pin: '4827' }));
  const off = await security.setAppLock(userCtx(f, { enabled: false }));
  assert.equal(off.enabled, false);
  // With no lock set, any check passes rather than locking the owner out.
  const c = await security.checkAppLock(userCtx(f, { pin: '' }));
  assert.equal(c.ok, true);
  assert.equal(c.enabled, false);
});

test('status reports the policy plainly', async () => {
  const f = await fixture();
  await withSession(f);
  const st = await security.status(userCtx(f));
  assert.equal(st.appLock.enabled, false);
  assert.equal(st.devices.active, 1);
  // A deliberate decision people ask about, so it is stated rather than implied.
  assert.equal(st.sessionPolicy.expires, false);
  assert.match(st.sessionPolicy.note, /WhatsApp/);
});
