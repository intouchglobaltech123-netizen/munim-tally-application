'use strict';
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Default to the local unix socket: peer auth means no password to manage in
// development. Production sets DATABASE_URL to a real TCP connection string.
const CONNECTION =
  process.env.DATABASE_URL || 'postgres:///munim?host=/var/run/postgresql';

// Small pool on purpose. Hundreds of connectors plus the web app will exhaust
// Postgres long before they exhaust the machine; PgBouncer goes in front of
// this in production (docs/10-performance.md).
/*
 * TLS, decided from the connection string rather than hardcoded.
 *
 * A managed Postgres reached over the public internet (Railway's proxy host,
 * Neon, Supabase) requires TLS and presents a certificate signed by a CA the
 * container does not carry, so verification fails and the pool throws
 * "self-signed certificate in certificate chain" before a single query runs.
 *
 * Reached over a provider's private network - which is the normal case, and
 * what Railway's own DATABASE_URL gives you - there is no TLS and asking for it
 * fails just as hard.
 *
 * So: honour what the URL asks for. sslmode=require turns TLS on;
 * rejectUnauthorized stays off because we are verifying the host through the
 * provider's network, not through a CA we control, and pretending otherwise
 * would be security theatre that only breaks deploys.
 */
const wantsSsl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(CONNECTION)
  || process.env.PGSSLMODE === 'require';

/*
 * Nothing waits for ever.
 *
 * A query blocked behind somebody else's row lock does not fail, it waits -
 * and Postgres will happily wait until the process is restarted. Sign-in hit
 * exactly that: it revokes the user's other sessions, which takes a lock on
 * their rows, and one abandoned transaction holding those rows is enough to
 * hang that one account's sign-in and nobody else's. From the outside it looks
 * like the server "did not answer", which is true and completely unhelpful.
 *
 * lock_timeout is the short one on purpose: waiting on a lock is almost always
 * contention rather than work, and failing in ten seconds with a message beats
 * a spinner. statement_timeout is the long stop for a query that is genuinely
 * running - a big report on a large book is allowed to be slow.
 *
 * idle_in_transaction_session_timeout is what stops this recurring: a
 * connection that opened a transaction and then stopped doing anything is the
 * thing that holds the locks, and it is now closed rather than left there.
 */
const pool = new Pool({
  connectionString: CONNECTION,
  max: Number(process.env.PG_POOL || 10),
  idleTimeoutMillis: 30_000,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 20_000),
  lock_timeout: Number(process.env.PG_LOCK_TIMEOUT_MS || 10_000),
  idle_in_transaction_session_timeout:
    Number(process.env.PG_IDLE_TX_TIMEOUT_MS || 30_000),
  ...(wantsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

const query = (text, params) => pool.query(text, params);

/** Runs fn inside a transaction, rolling back on any throw. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Applies any migration files not yet recorded, in filename order, each in its
 * own transaction. Running at boot means a deploy can never start against a
 * schema it does not understand.
 */
async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await query('SELECT name FROM schema_migrations');
  const done = new Set(rows.map((r) => r.name));

  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await tx(async (c) => {
      /*
       * Migrations opt out of the pool's timeouts.
       *
       * Those exist to stop one request hanging the app. A migration is not a
       * request: a backfill across every voucher in a large database is
       * allowed to take minutes, and being cut off at twenty seconds would
       * leave the schema half-applied and the service unable to boot. LOCAL,
       * so it lasts exactly as long as this transaction.
       */
      await c.query('SET LOCAL statement_timeout = 0');
      await c.query('SET LOCAL lock_timeout = 0');
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`  migrated ${file}`);
  }
  return files.length;
}

module.exports = { pool, query, tx, migrate };
