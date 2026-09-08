'use strict';
const os = require('os');

/**
 * What the server itself is doing.
 *
 * Latency and error rates cannot be read out of the database, because the
 * requests that are slowest are often the ones that never reached it. So they
 * are measured where they happen - in the request path - and kept in memory.
 *
 * In memory, and therefore lost on restart. That is the honest trade at this
 * size: a metrics store is another service to run and another thing to be down,
 * and the question this answers ("is it slow right now, and which route") is a
 * question about now. Anything that has to survive a restart belongs in the
 * database, and the business metrics all do.
 */

/*
 * A ring buffer rather than a growing list.
 *
 * The alternative leaks: a busy server would accumulate a million samples a day
 * and the memory graph would blame the metrics. Two thousand samples is enough
 * to compute a stable p95 and costs a few tens of kilobytes.
 */
const CAPACITY = 2000;

const samples = new Array(CAPACITY);
let next = 0;
let total = 0;

const counters = {
  requests: 0,
  errors: 0,          // 5xx: our fault
  rejected: 0,        // 4xx: theirs, but a spike still means something
  rateLimited: 0,
};

const startedAt = Date.now();

/** Record one finished request. */
function observe({ method, path, status, ms }) {
  samples[next] = { at: Date.now(), method, path: normalise(path), status, ms };
  next = (next + 1) % CAPACITY;
  total++;

  counters.requests++;
  if (status >= 500) counters.errors++;
  else if (status === 429) { counters.rejected++; counters.rateLimited++; }
  else if (status >= 400) counters.rejected++;
}

/**
 * Collapse ids out of a path so routes group.
 *
 * Without this every voucher ever opened is its own "route" and the slowest
 * endpoint is always whichever one has the most distinct ids, which is exactly
 * backwards.
 */
function normalise(path) {
  return String(path || '')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:n')
    .slice(0, 120);
}

/** The percentile of a sorted array, nearest-rank. */
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

/**
 * Latency and errors over a window.
 *
 * p95 as well as the mean, because the mean hides the tail and the tail is what
 * a customer actually experiences. A route averaging 80ms with a p95 of four
 * seconds is a broken route, and the average says it is fine.
 */
function apiHealth(windowMs = 15 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  const recent = samples.filter((s) => s && s.at >= cutoff);

  const times = recent.map((s) => s.ms).sort((a, b) => a - b);
  const errors = recent.filter((s) => s.status >= 500).length;
  const slow = recent.filter((s) => s.ms > 1000).length;

  const byRoute = new Map();
  for (const s of recent) {
    const key = `${s.method} ${s.path}`;
    const r = byRoute.get(key) ?? { route: key, calls: 0, totalMs: 0, errors: 0, maxMs: 0 };
    r.calls++;
    r.totalMs += s.ms;
    r.maxMs = Math.max(r.maxMs, s.ms);
    if (s.status >= 500) r.errors++;
    byRoute.set(key, r);
  }

  return {
    windowMinutes: Math.round(windowMs / 60000),
    samples: recent.length,
    // Never sampled: this is every request in the window, up to the buffer size.
    truncated: total > CAPACITY && recent.length === CAPACITY,
    avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0,
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    p99Ms: percentile(times, 99),
    maxMs: times.length ? times[times.length - 1] : 0,
    errors,
    errorRate: recent.length ? Math.round((errors / recent.length) * 10000) / 100 : 0,
    slowRequests: slow,
    slowest: [...byRoute.values()]
      .map((r) => ({ ...r, avgMs: Math.round(r.totalMs / r.calls) }))
      .sort((a, b) => b.avgMs - a.avgMs)
      .slice(0, 10),
    busiest: [...byRoute.values()]
      .map((r) => ({ ...r, avgMs: Math.round(r.totalMs / r.calls) }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10),
    lifetime: { ...counters },
  };
}

/**
 * The machine.
 *
 * loadavg over a bare CPU percentage: a single instantaneous reading of CPU on a
 * mostly-idle Node process is noise, while load average is already smoothed over
 * one, five and fifteen minutes and is what an operator will compare against
 * core count anyway.
 */
function system() {
  const mem = process.memoryUsage();
  const cores = os.cpus().length || 1;
  const [l1, l5, l15] = os.loadavg();

  return {
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()}`,
    cores,
    load: { one: round2(l1), five: round2(l5), fifteen: round2(l15) },
    // Against cores, because "load 4" means nothing without knowing there are 8.
    loadPercent: Math.round((l1 / cores) * 100),
    memory: {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
      heapTotalMb: Math.round(mem.heapTotal / 1048576),
      systemTotalMb: Math.round(os.totalmem() / 1048576),
      systemFreeMb: Math.round(os.freemem() / 1048576),
      systemUsedPercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100),
    },
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

/** Emptied between tests. */
function reset() {
  samples.fill(undefined);
  next = 0;
  total = 0;
  for (const k of Object.keys(counters)) counters[k] = 0;
}

module.exports = { observe, apiHealth, system, reset, normalise, percentile, CAPACITY };
