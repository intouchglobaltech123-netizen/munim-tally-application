#!/usr/bin/env node
'use strict';
/**
 * Wipes every customer from the database, leaving the schema intact.
 *
 * For starting a clean test run. It deletes accounts, books, vouchers, devices
 * and licence keys - everything except the tables themselves.
 *
 *   node tools/reset-db.js          # shows what would go, changes nothing
 *   node tools/reset-db.js --yes    # actually does it
 *
 * A dry run by default, because "clear the database" typed into the wrong
 * terminal is not a recoverable mistake.
 */
const { query, tx } = require('../apps/api/src/db');

const GO = process.argv.includes('--yes');

/*
 * orgs cascades to users, companies, connectors, sessions, vouchers, ledgers.
 * These are the tables that are either global, or reachable only by an id we
 * are about to delete.
 *
 * Checked against the live schema before use: naming a table that does not
 * exist aborts the transaction, and every later DELETE is then silently ignored
 * - which looks exactly like a successful wipe until you check.
 */
const EXTRA = [
  'licence_keys', 'pair_intents', 'app_sign_in_codes', 'ingest_keys',
  'otp_requests', 'audit_log',
];

/** Only the tables that are really there, so one typo cannot void the wipe. */
async function existingTables(names) {
  const { rows } = await query(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ANY($1)`, [names]);
  return rows.map((r) => r.tablename);
}

(async () => {
  const { rows: orgs } = await query(
    `SELECT o.id, o.name,
            (SELECT count(*)::int FROM users u WHERE u.org_id = o.id) AS users,
            (SELECT count(*)::int FROM companies c WHERE c.org_id = o.id) AS companies,
            (SELECT count(*)::int FROM vouchers v
               JOIN companies c ON c.id = v.company_id WHERE c.org_id = o.id) AS vouchers
       FROM orgs o ORDER BY o.name`);

  console.log(`\n  ${GO ? 'Deleting' : 'Would delete'} ${orgs.length} account(s):\n`);
  for (const o of orgs) {
    console.log(`    ${(o.name || '(unnamed)').padEnd(22)} `
      + `${String(o.users).padStart(2)} user  `
      + `${String(o.companies).padStart(2)} book  `
      + `${String(o.vouchers).padStart(5)} vouchers`);
  }

  const tables = await existingTables(EXTRA);
  for (const t of tables) {
    const { rows } = await query(`SELECT count(*)::int AS n FROM ${t}`);
    if (rows[0].n) console.log(`    ${t.padEnd(22)} ${String(rows[0].n).padStart(2)} row(s)`);
  }

  if (!GO) {
    console.log('\n  Nothing changed. Run again with --yes to actually clear it.\n');
    process.exit(0);
  }

  await tx(async (c) => {
    for (const t of tables) await c.query(`DELETE FROM ${t}`);
    await c.query('DELETE FROM orgs');
  });

  // Prove it, rather than trusting that the deletes ran.
  const { rows: left } = await query(
    `SELECT (SELECT count(*)::int FROM orgs)     AS orgs,
            (SELECT count(*)::int FROM users)    AS users,
            (SELECT count(*)::int FROM vouchers) AS vouchers`);
  const l = left[0];
  if (l.orgs || l.users || l.vouchers) {
    console.error(`\n  Not fully cleared: ${l.orgs} orgs, ${l.users} users, `
      + `${l.vouchers} vouchers remain.\n`);
    process.exit(1);
  }

  console.log('\n  Cleared. The operator account is recreated when the API restarts.\n');
  process.exit(0);
})().catch((e) => {
  console.error('\n  Failed:', e.message, '\n');
  process.exit(1);
});
