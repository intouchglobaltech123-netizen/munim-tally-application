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

const pool = new Pool({
  connectionString: CONNECTION,
  max: Number(process.env.PG_POOL || 10),
  idleTimeoutMillis: 30_000,
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
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`  migrated ${file}`);
  }
  return files.length;
}

module.exports = { pool, query, tx, migrate };
