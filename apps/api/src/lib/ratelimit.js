'use strict';

/**
 * Rate limiting.
 *
 * Only the sign-in path was throttled, which stopped password-guessing and
 * nothing else. Everything behind a valid token was unbounded: one customer's
 * misconfigured script, or one stolen token, could saturate the server for
 * every other customer on it. In a shared SaaS the noisy neighbour is the
 * normal failure, not the exotic one.
 *
 * Three deliberate choices:
 *
 *   1. Keyed on the CALLER, not the route. A token, else a connector, else the
 *      network. Per-route buckets sound tidier but let one caller multiply
 *      their allowance by spreading traffic across endpoints.
 *
 *   2. A token bucket, not a fixed window. A fixed window lets somebody spend a
 *      whole minute's budget in the last second of one window and again in the
 *      first second of the next - twice the intended rate, at the worst moment.
 *      A bucket refills continuously and has no edge to exploit.
 *
 *   3. In-process. This is a single-server deployment; a shared limiter needs
 *      Redis, and adding a second thing that can be down in order to serve a
 *      request is a bad trade at this size. The limits below are per server,
 *      and that is written on the tin so nobody assumes otherwise later.
 */

/**
 * Tiers, in requests per minute, with a burst allowance.
 *
 * The numbers come from what the apps actually do. A dashboard opening fires
 * roughly a dozen calls at once, so a burst below that would break normal use -
 * the limiter has to be invisible to real customers and only ever bite abuse.
 */
const TIERS = {
  // A signed-in person on the web or phone.
  user: { perMinute: 600, burst: 60 },
  // The connector: one machine, syncing in batches, legitimately chatty.
  connector: { perMinute: 1200, burst: 120 },
  // Unauthenticated. Sign-in, the installer script, health. Tight on purpose.
  anon: { perMinute: 60, burst: 20 },
  // Deliberately expensive things: backups, restores, archive downloads.
  // A backup reads a whole book; a handful in a row is fine, a hundred is not.
  heavy: { perMinute: 10, burst: 5 },
};

/** Routes that cost far more than a request usually does. */
function isHeavy(method, pathname) {
  if (method === 'POST' && /^\/v1\/backups(\/|$)/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/v1/restore') return true;
  if (method === 'GET' && /^\/v1\/backups\/[0-9a-f-]{36}\/download$/.test(pathname)) return true;
  return false;
}

const buckets = new Map();

/*
 * Swept rather than left to grow.
 *
 * Every distinct key allocates an entry, and the key can be an IP address - so
 * without this a long uptime under scanning traffic is a slow memory leak with
 * an attacker holding the tap. An idle bucket is indistinguishable from a full
 * one, so dropping it loses nothing.
 */
const IDLE_MS = 10 * 60 * 1000;

/*
 * A minute between sweeps is fine when traffic is ordinary. It is not fine when
 * somebody is walking the address space: that fills the map far faster than
 * once a minute clears it, so size forces a sweep as well as time.
 */
const SWEEP_EVERY_MS = 60_000;
const SWEEP_AT_SIZE = 10_000;

let lastSweep = Date.now();

function sweep(now) {
  if (now - lastSweep < SWEEP_EVERY_MS && buckets.size < SWEEP_AT_SIZE) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (now - b.seen > IDLE_MS) buckets.delete(k);
}

/**
 * Spend one token.
 *
 * Returns what the caller needs to answer with, rather than throwing: the
 * limiter should not decide the shape of the response, and a 429 needs a
 * Retry-After that only the bucket can compute.
 */
function take(key, tier) {
  const { perMinute, burst } = TIERS[tier] ?? TIERS.anon;
  const now = Date.now();
  sweep(now);

  let b = buckets.get(key);
  if (!b) { b = { tokens: burst, at: now, seen: now }; buckets.set(key, b); }

  // Refill for the time that has passed, capped at the burst size.
  const refill = ((now - b.at) / 60_000) * perMinute;
  b.tokens = Math.min(burst, b.tokens + refill);
  b.at = now;
  b.seen = now;

  if (b.tokens < 1) {
    // Whole seconds, rounded up: a Retry-After of 0 invites an instant retry.
    const wait = Math.ceil(((1 - b.tokens) / perMinute) * 60);
    return { ok: false, retryAfter: Math.max(1, wait), limit: perMinute };
  }

  b.tokens -= 1;
  return { ok: true, remaining: Math.floor(b.tokens), limit: perMinute };
}

/**
 * Who is being limited.
 *
 * A signed-in person is keyed by user id, so moving between wifi and mobile
 * data does not reset their allowance - and so one office behind one NAT
 * address is not one shared bucket for twenty staff, which would make the
 * limiter punish exactly the customers who bought the most seats.
 */
function identify(ctx) {
  if (ctx.session?.user?.id) return { key: `u:${ctx.session.user.id}`, tier: 'user' };
  if (ctx.connector?.id) return { key: `c:${ctx.connector.id}`, tier: 'connector' };
  return { key: `n:${ip(ctx)}`, tier: 'anon' };
}

function ip(ctx) {
  const fwd = String(ctx.req?.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
  return fwd || ctx.req?.socket?.remoteAddress || 'unknown';
}

/**
 * The check itself.
 *
 * A heavy route is metered against its own bucket AS WELL AS the caller's, not
 * instead of it: one is "you are asking too often", the other is "you are
 * asking for too much", and they are different questions.
 */
function check(ctx, method, pathname) {
  const who = identify(ctx);

  if (isHeavy(method, pathname)) {
    const heavy = take(`${who.key}:heavy`, 'heavy');
    if (!heavy.ok) return { ...heavy, tier: 'heavy' };
  }

  return { ...take(who.key, who.tier), tier: who.tier };
}

/**
 * Emptied between tests, and available if an operator ever needs to.
 *
 * The sweep clock is reset too, so the next call actually sweeps rather than
 * silently skipping because a sweep happened moments ago in another test.
 */
function reset() {
  buckets.clear();
  lastSweep = 0;
}

module.exports = {
  check, take, identify, isHeavy, reset, TIERS,
  // Exposed so the sweep can be tested without waiting a real minute, and so an
  // operator can reclaim memory on demand.
  sweepNow: () => { lastSweep = 0; sweep(Date.now()); },
  _buckets: buckets,
};
