const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const rl = require('../src/lib/ratelimit');

/**
 * Rate limiting.
 *
 * The limiter has to be invisible to real customers and bite only abuse, so
 * these tests are as much about what it must NOT do as what it must.
 */

beforeEach(() => rl.reset());

const anon = (ip = '203.0.113.1') =>
  ({ req: { headers: { 'x-forwarded-for': ip }, socket: {} } });
const user = (id) => ({ session: { user: { id } }, req: { headers: {}, socket: {} } });
const conn = (id) => ({ connector: { id }, req: { headers: {}, socket: {} } });

test('an unauthenticated caller is cut off after its burst', () => {
  const ctx = anon();
  let allowed = 0;
  for (let i = 0; i < 100; i++) if (rl.check(ctx, 'GET', '/v1/health').ok) allowed++;
  assert.equal(allowed, rl.TIERS.anon.burst);
});

test('a 429 always says when to come back', () => {
  // Without Retry-After a client can only guess, and a client that guesses
  // wrong retries straight into the same wall.
  const ctx = anon();
  let res;
  for (let i = 0; i < 100; i++) res = rl.check(ctx, 'GET', '/v1/health');
  assert.equal(res.ok, false);
  assert.ok(res.retryAfter >= 1, 'never zero, which would invite an instant retry');
});

test('two networks do not share a bucket', () => {
  for (let i = 0; i < 100; i++) rl.check(anon('203.0.113.1'), 'GET', '/v1/health');
  assert.equal(rl.check(anon('198.51.100.9'), 'GET', '/v1/health').ok, true);
});

test('two people in one office do not share a bucket', () => {
  /*
   * They sit behind one NAT address. Keying on IP would make the limiter
   * punish exactly the customers who bought the most seats.
   */
  const office = { 'x-forwarded-for': '203.0.113.7' };
  const a = { session: { user: { id: 'a' } }, req: { headers: office, socket: {} } };
  const b = { session: { user: { id: 'b' } }, req: { headers: office, socket: {} } };
  for (let i = 0; i < 100; i++) rl.check(a, 'GET', '/v1/dashboard');
  assert.equal(rl.check(b, 'GET', '/v1/dashboard').ok, true);
});

test('a signed-in person keeps their allowance across networks', () => {
  // Walking out of the shop and onto mobile data must not reset or penalise.
  const wifi = { session: { user: { id: 'x' } },
                 req: { headers: { 'x-forwarded-for': '10.0.0.2' }, socket: {} } };
  const cell = { session: { user: { id: 'x' } },
                 req: { headers: { 'x-forwarded-for': '49.207.1.1' }, socket: {} } };
  for (let i = 0; i < 30; i++) rl.check(wifi, 'GET', '/v1/dashboard');
  const after = rl.check(cell, 'GET', '/v1/dashboard');
  assert.ok(after.remaining < rl.TIERS.user.burst - 25, 'the same bucket followed them');
});

test('opening a dashboard does not trip the limiter', () => {
  // A dashboard fires roughly a dozen calls at once. If a normal screen load
  // can hit the limit, the limit is wrong.
  const ctx = user('u1');
  for (let i = 0; i < 15; i++) {
    assert.equal(rl.check(ctx, 'GET', '/v1/dashboard').ok, true, `call ${i + 1}`);
  }
});

test('the connector is allowed to be chattier than a person', () => {
  assert.ok(rl.TIERS.connector.perMinute > rl.TIERS.user.perMinute);
  const ctx = conn('c1');
  let allowed = 0;
  for (let i = 0; i < 200; i++) if (rl.check(ctx, 'POST', '/v1/ingest').ok) allowed++;
  assert.equal(allowed, rl.TIERS.connector.burst);
});

test('backups are metered far more tightly than ordinary calls', () => {
  // One backup reads an entire book. A handful in a row is fine; a hundred is
  // a way to make the server read every customer's book at once.
  const ctx = user('u2');
  let allowed = 0;
  for (let i = 0; i < 50; i++) {
    if (rl.check(ctx, 'POST', '/v1/backups/abc').ok) allowed++;
  }
  assert.equal(allowed, rl.TIERS.heavy.burst);
});

test('spending the heavy budget leaves ordinary calls working', () => {
  /*
   * The two buckets answer different questions - "too often" and "too much" -
   * so exhausting one must not lock somebody out of their own dashboard.
   */
  const ctx = user('u3');
  for (let i = 0; i < 50; i++) rl.check(ctx, 'POST', '/v1/backups/abc');
  assert.equal(rl.check(ctx, 'GET', '/v1/dashboard').ok, true);
});

test('the bucket refills over time', () => {
  const ctx = user('u4');
  for (let i = 0; i < 100; i++) rl.check(ctx, 'GET', '/v1/dashboard');
  assert.equal(rl.check(ctx, 'GET', '/v1/dashboard').ok, false);

  // Reach into the bucket rather than sleeping: a test that waits a real
  // minute is a test nobody runs.
  const bucket = rl._buckets.get('u:u4');
  bucket.at -= 60_000;
  assert.equal(rl.check(ctx, 'GET', '/v1/dashboard').ok, true);
});

test('a refill never exceeds the burst size', () => {
  // Otherwise an idle week would bank a week of requests and the burst limit
  // would mean nothing.
  const ctx = user('u5');
  rl.check(ctx, 'GET', '/v1/dashboard');
  rl._buckets.get('u:u5').at -= 7 * 24 * 3600 * 1000;
  const r = rl.check(ctx, 'GET', '/v1/dashboard');
  assert.ok(r.remaining <= rl.TIERS.user.burst);
});

test('idle buckets are swept rather than left to grow', () => {
  // Every distinct IP allocates an entry, so without a sweep a long uptime
  // under scanning traffic is a memory leak with an attacker holding the tap.
  for (let i = 0; i < 50; i++) rl.check(anon(`198.51.100.${i}`), 'GET', '/v1/health');
  assert.equal(rl._buckets.size, 50);

  for (const b of rl._buckets.values()) b.seen -= 20 * 60 * 1000;
  rl.sweepNow();
  assert.equal(rl._buckets.size, 0, 'every idle bucket was reclaimed');

  // A bucket still in use must survive the sweep.
  const live = user('still-here');
  rl.check(live, 'GET', '/v1/dashboard');
  rl.sweepNow();
  assert.equal(rl._buckets.size, 1);
});

test('heavy routes are recognised by what they cost, not by prefix', () => {
  assert.equal(rl.isHeavy('POST', '/v1/backups/guid'), true);
  assert.equal(rl.isHeavy('POST', '/v1/restore'), true);
  assert.equal(rl.isHeavy('GET', '/v1/backups/11111111-1111-1111-1111-111111111111/download'), true);
  // Listing backups is a cheap read and must not be throttled as a heavy one.
  assert.equal(rl.isHeavy('GET', '/v1/backups'), false);
});
