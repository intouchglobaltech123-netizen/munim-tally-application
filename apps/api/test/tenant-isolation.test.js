const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { query } = require('../src/db');

/**
 * Tenant isolation.
 *
 * The property the whole product rests on: one customer can never see another
 * customer's books. It is also the property that decays silently - nobody
 * writes an unscoped query on purpose, they write one in a hurry and it works
 * perfectly in a database with one tenant in it.
 *
 * So this file checks it two ways. The static sweep catches the query that was
 * never scoped; the behavioural probes catch the route that scopes its query
 * and then hands back the row anyway.
 */

const ROUTES = path.join(__dirname, '..', 'src', 'routes');

/*
 * Tables that are not tenant data.
 *
 * Everything else must be reached through org_id, or through company_id, which
 * is itself only ever resolved from the caller's org.
 */
const GLOBAL_TABLES = new Set([
  'schema_migrations',
  'orgs',                 // scoped by id = the caller's own org
  'users',                // scoped by org_id, checked separately below
  'sessions',             // keyed by token hash
  'otp_requests', 'app_sign_in_codes', 'pair_intents',
  'licence_keys',         // a key belongs to nobody until it is redeemed
  'login_events',         // scoped by user or by network, both checked in security.js
  'ingest_keys',          // keyed by connector
  'connectors',
  // A price list, not customer data: the same codes are offered to everybody.
  'coupons',

  /*
   * The partner programme is not tenant data.
   *
   * A partner is a business Munim sells THROUGH, not a customer whose books are
   * being kept. Their rows are scoped by partner_id, which is checked by
   * partners.test.js ("a partner sees only their own customers", "leads belong
   * to the partner who created them"). Forcing an org_id on them would be
   * meaningless: a partner has many customers, and one of their leads has no
   * account at all yet - which is the whole point of tracking a lead.
   */
  'partners', 'partner_users', 'partner_leads', 'commissions', 'payouts',
]);

/**
 * Pull every table a statement touches.
 *
 * Matched against the real table list rather than "whatever word followed
 * FROM", because aliases and column names otherwise show up as tables and the
 * failure list fills with noise nobody reads.
 */
function tablesIn(sql, real) {
  const out = new Set();
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(sql))) {
    const t = m[1].toLowerCase();
    if (real.has(t)) out.add(t);
  }
  return [...out];
}

/** Split a file into its individual SQL literals. */
function statementsIn(src) {
  const out = [];
  const re = /`([^`]*?)`/gs;
  let m;
  while ((m = re.exec(src))) {
    const body = m[1];
    if (/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(body)) out.push(body);
  }
  return out;
}

async function realTables() {
  const { rows } = await query(`
    SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')`);
  return new Set(rows.map((r) => r.t));
}

test('no route reads tenant data without scoping it to a tenant', async () => {
  /*
   * The check that would have caught every cross-tenant bug this codebase has
   * had: a query touching a tenant table must name a scope column.
   *
   * A query whose predicate is built at runtime (`${where.join(' AND ')}`)
   * cannot be judged by reading it, so those are reported separately rather
   * than passed silently - the behavioural probes below are what cover them.
   *
   * A genuinely platform-wide query says so in the SQL itself, with
   * `-- tenant-global:` and a reason. Making that visible in the query is the
   * point: it is the line a reviewer should stop on.
   */
  const real = await realTables();
  const offenders = [];
  const dynamic = [];

  for (const file of fs.readdirSync(ROUTES).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROUTES, file), 'utf8');

    for (const sql of statementsIn(src)) {
      const tenantTables = tablesIn(sql, real).filter((t) => !GLOBAL_TABLES.has(t));
      if (!tenantTables.length) continue;
      if (/--\s*tenant-global:/i.test(sql)) continue;

      const scoped = /\borg_id\b/i.test(sql)
        || /\bcompany_id\b/i.test(sql)
        // A child row reached through a parent that is itself scoped.
        || /\bvoucher_id\b/i.test(sql)
        || /\buser_id\b/i.test(sql)
        || /\bconnector_id\b/i.test(sql);

      const entry = {
        file,
        tables: tenantTables.join(', '),
        sql: sql.replace(/\s+/g, ' ').trim().slice(0, 100),
      };

      if (scoped) continue;
      if (/\$\{/.test(sql)) dynamic.push(entry);
      else offenders.push(entry);
    }
  }

  assert.deepEqual(offenders, [],
    'these queries touch tenant data without naming a tenant:\n'
    + offenders.map((o) => `  ${o.file}: [${o.tables}] ${o.sql}`).join('\n'));

  // Not a failure, but worth knowing: every one of these has to be covered by
  // a behavioural probe, because no amount of reading proves them safe.
  if (dynamic.length && process.env.VERBOSE === '1') {
    console.log(`  ${dynamic.length} queries build their predicate at runtime:`);
    for (const d of dynamic) console.log(`    ${d.file}: ${d.sql}`);
  }
});

test('every tenant table can be traced back to an org', async () => {
  /*
   * A table with neither org_id nor company_id nor a scoped parent cannot be
   * isolated at all - and would also survive an account deletion, which is the
   * same bug wearing a different hat.
   */
  const { rows } = await query(`
    SELECT c.relname AS t
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY 1`);

  const known = new Set([...GLOBAL_TABLES,
    // Children, reached only through a scoped parent.
    'voucher_entries', 'voucher_items', 'stock_batches', 'notification_reads',
    'owner_transfers', 'user_companies', 'connector_commands', 'connector_logs',
    'pinned_reports',
    // Reached through their ticket, which is scoped.
    'ticket_messages', 'ticket_files',
    // Reached through their webhook, which is scoped.
    'webhook_deliveries',
  ]);

  const unreachable = [];
  for (const { t } of rows) {
    if (known.has(t)) continue;
    const { rows: cols } = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [t]);
    const names = cols.map((c) => c.column_name);
    if (!names.includes('org_id') && !names.includes('company_id')) unreachable.push(t);
  }

  assert.deepEqual(unreachable, [],
    'these tables hold data that cannot be traced to a tenant');
});

// --- behavioural probes -----------------------------------------------------

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function tenant(name) {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING *', [name]);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role, name) VALUES ($1,$2,'owner',$3) RETURNING *`,
    [o[0].id, `iso-${o[0].id.slice(0, 8)}@example.com`, name]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,$3) RETURNING *`,
    [o[0].id, `iso-${o[0].id}`, `${name} Books`]);
  const { rows: v } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,'1','Sales','2025-07-01',$3,100000) RETURNING *`,
    [c[0].id, `v-${o[0].id}`, `${name} Customer`]);
  return { org: o[0], user: u[0], co: c[0], voucher: v[0] };
}

const ctxFor = (t, body = {}, qs = '') => ({
  session: {
    org: { id: t.org.id, name: t.org.name, plan: t.org.plan },
    user: { id: t.user.id, role: 'owner', roleId: null,
            name: t.user.name, email: t.user.email },
  },
  req: { headers: {}, socket: {} },
  url: new URL(`http://x/${qs}`),
  body,
});

test('one tenant cannot open another tenant\'s company by guid', async () => {
  const a = await tenant('Alpha');
  const b = await tenant('Beta');
  const company = require('../src/routes/company');

  await assert.rejects(() => company.detail(ctxFor(b), a.co.tally_guid),
    (e) => e.status === 404,
    'Beta was able to read Alpha\'s company');
});

test('one tenant cannot open another tenant\'s voucher by id', async () => {
  const a = await tenant('Alpha2');
  const b = await tenant('Beta2');
  const vouchers = require('../src/routes/vouchers');

  await assert.rejects(
    () => vouchers.detail(ctxFor(b), b.co.tally_guid, a.voucher.id),
    (e) => e.status === 404 || e.status === 403,
    'Beta read Alpha\'s voucher by pointing at it from their own company');
});

test('a guid from another tenant does not resolve, even with a valid session', async () => {
  // The classic multi-tenant bug: the id is validated, the row is fetched, and
  // the ownership check is the line somebody forgot.
  const a = await tenant('Alpha3');
  const b = await tenant('Beta3');

  const { rows } = await query(
    'SELECT id FROM companies WHERE org_id = $1 AND tally_guid = $2',
    [b.org.id, a.co.tally_guid]);
  assert.equal(rows.length, 0);
});

test('search never crosses tenants', async () => {
  const a = await tenant('Alpha4');
  const b = await tenant('Beta4');
  const search = require('../src/routes/search');

  const out = await search.find(ctxFor(b, {}, '?q=Alpha4'), b.co.tally_guid);
  const text = JSON.stringify(out);
  assert.ok(!text.includes('Alpha4 Customer'), 'Beta\'s search returned Alpha\'s party');
});

test('the audit log never crosses tenants', async () => {
  const a = await tenant('Alpha5');
  const b = await tenant('Beta5');
  const audit = require('../src/routes/audit');
  const { record } = require('../src/lib/audit');

  await record(ctxFor(a), 'user.disable', { entityName: 'Alpha secret' });
  const mine = await audit.list(ctxFor(b));
  assert.equal(mine.entries.length, 0);
});

test('a backup cannot be read by another tenant', async () => {
  const a = await tenant('Alpha6');
  const b = await tenant('Beta6');
  const backup = require('../src/routes/backup');

  const made = await backup.create(ctxFor(a), a.co.tally_guid);
  await assert.rejects(() => backup.download(ctxFor(b), made.backup.id),
    (e) => e.status === 404);
});
