const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const company = require('../src/routes/company');

/**
 * The company as an entity: its letterhead, and whether its figures can be
 * believed right now.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function makeCompany(fields = {}) {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['co-test']);
  orgs.push(o[0].id);
  const cols = Object.keys(fields);
  const { rows } = await query(
    `INSERT INTO companies (org_id, tally_guid, name${cols.length ? ', ' + cols.join(', ') : ''})
     VALUES ($1, $2, $3${cols.map((_, i) => `, $${i + 4}`).join('')}) RETURNING *`,
    [o[0].id, `guid-${o[0].id}`, 'Test Co', ...cols.map((k) => fields[k])]);
  return { orgId: o[0].id, co: rows[0] };
}

const ctxFor = (orgId) => ({
  session: { org: { id: orgId, name: 'Test Co' }, user: { role: 'owner' } },
  url: new URL('http://x/'),
});

test('Tally dates are normalised however they were stored', () => {
  // Rows written before the connector converted dates still hold YYYYMMDD.
  // Both eras must read the same, without a backfill migration.
  assert.equal(company.isoDate('20260401'), '2026-04-01');
  assert.equal(company.isoDate('2026-04-01'), '2026-04-01');
  assert.equal(company.isoDate(''), '');
  assert.equal(company.isoDate(null), '');
  assert.equal(company.isoDate('rubbish'), '', 'a value we cannot parse is not passed through');
});

test('a book that never synced is a setup problem, not a fault', () => {
  const h = company.health({ enabled: true, last_sync_at: null });
  assert.equal(h.state, 'never');
  assert.match(h.hint, /connector/i, 'the hint says what to actually do');
});

test('a paused book reads as paused, not as broken', () => {
  // Pausing is a deliberate act. Reporting it as a failure would send someone
  // to debug a connector that is working exactly as told.
  const h = company.health({ enabled: false, last_sync_at: null });
  assert.equal(h.state, 'paused');
});

test('a few quiet hours is not an alarm', () => {
  const h = company.health({ enabled: true, last_sync_at: new Date(Date.now() - 8 * 3600_000) });
  assert.equal(h.state, 'quiet');
  // Shops close overnight and on Sundays. Calling that a fault trains people
  // to ignore the warning that matters.
  assert.notEqual(h.state, 'stale');
});

test('two days silent is a fault', () => {
  const h = company.health({ enabled: true, last_sync_at: new Date(Date.now() - 60 * 3600_000) });
  assert.equal(h.state, 'stale');
});

test('a recent sync is live', () => {
  const h = company.health({ enabled: true, last_sync_at: new Date(Date.now() - 60_000) });
  assert.equal(h.state, 'live');
});

test('completeness names the missing field, not just a percentage', () => {
  const c = company.completeness({ address: '', gstin: '', state: 'TN', phone: '9', email: 'a@b.c', pan: 'X' });
  const keys = c.missing.map((m) => m.key);
  assert.deepEqual(keys, ['address', 'gstin']);
  // Every missing field explains its consequence, so the customer knows why
  // it is worth going back into Tally to fix.
  assert.ok(c.missing.every((m) => m.why && m.label));
});

test('completeness rounds down, so 99% never means "fine"', () => {
  const c = company.completeness({
    address: 'x', gstin: 'x', state: 'x', phone: 'x', email: 'x', pan: '' });
  assert.equal(c.percent, 83, '5 of 6 present');
  assert.equal(c.missing.length, 1);
});

test('a fully filled profile is complete', () => {
  const c = company.completeness({
    address: 'x', gstin: 'x', state: 'x', phone: 'x', email: 'x', pan: 'x' });
  assert.equal(c.percent, 100);
  assert.deepEqual(c.missing, []);
});

test('the list carries counts and health for every book', async () => {
  const { orgId } = await makeCompany({ gstin: '33AAAAA0000A1Z5', state: 'Tamil Nadu' });
  const r = await company.list(ctxFor(orgId));
  assert.equal(r.companies.length, 1);
  const c = r.companies[0];
  assert.equal(c.profile.gstin, '33AAAAA0000A1Z5');
  assert.equal(c.counts.vouchers, 0);
  assert.equal(c.health.state, 'never');
});

test('formalName falls back to the name rather than being blank', async () => {
  const { orgId } = await makeCompany();
  const r = await company.list(ctxFor(orgId));
  // A letterhead has to print something.
  assert.equal(r.companies[0].profile.formalName, 'Test Co');
});

test('currency defaults to the rupee', async () => {
  const { orgId } = await makeCompany();
  const r = await company.list(ctxFor(orgId));
  assert.equal(r.companies[0].profile.currency, '₹');
});

test('detail reports the span the books actually cover', async () => {
  const { orgId, co } = await makeCompany();
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,'1','Sales','2025-07-15','A',100), ($1,$3,'2','Sales','2025-09-20','A',100)`,
    [co.id, `${co.id}-v1`, `${co.id}-v2`]);

  const d = await company.detail(ctxFor(orgId), co.tally_guid);
  // Not the financial year: a book opened in April and first written to in
  // July would otherwise open every report on an empty screen.
  assert.equal(new Date(d.span.firstVoucher).toISOString().slice(0, 10), '2025-07-15');
  assert.equal(new Date(d.span.lastVoucher).toISOString().slice(0, 10), '2025-09-20');
  assert.equal(d.counts.vouchers, 2);
});

test('another org\'s book is not reachable', async () => {
  const a = await makeCompany();
  const b = await makeCompany();
  await assert.rejects(
    () => company.detail(ctxFor(b.orgId), a.co.tally_guid),
    (e) => e.status === 404);
});

test('the list never leaks another org\'s books', async () => {
  const a = await makeCompany();
  await makeCompany();
  const r = await company.list(ctxFor(a.orgId));
  assert.equal(r.companies.length, 1);
  assert.equal(r.companies[0].tallyGuid, a.co.tally_guid);
});

// --- settings, removal and the company dashboard ---------------------------

const ctxBody = (orgId, body) => ({
  session: { org: { id: orgId, name: 'Test Co' }, user: { role: 'owner' } },
  url: new URL('http://x/'),
  body,
});

test('settings default to Indian, whole rupees', async () => {
  const { orgId } = await makeCompany();
  const r = await company.list(ctxFor(orgId));
  assert.deepEqual(r.companies[0].settings, {
    logoDataUri: '', numberFormat: 'indian', decimals: 0, dateFormat: 'dd-mm-yyyy',
  });
});

test('number format and decimals can be changed', async () => {
  const { orgId, co } = await makeCompany();
  const r = await company.updateSettings(
    ctxBody(orgId, { numberFormat: 'international', decimals: 2 }), co.tally_guid);
  assert.equal(r.settings.numberFormat, 'international');
  assert.equal(r.settings.decimals, 2);
});

test('a nonsense number format is refused', async () => {
  const { orgId, co } = await makeCompany();
  await assert.rejects(
    () => company.updateSettings(ctxBody(orgId, { numberFormat: 'martian' }), co.tally_guid),
    (e) => e.status === 400);
});

test('decimals outside 0-4 are refused', async () => {
  const { orgId, co } = await makeCompany();
  for (const bad of [-1, 5, 1.5, 'two']) {
    await assert.rejects(
      () => company.updateSettings(ctxBody(orgId, { decimals: bad }), co.tally_guid),
      (e) => e.status === 400, `decimals ${bad} should be refused`);
  }
});

test('only real image types are accepted as a logo', async () => {
  const { orgId, co } = await makeCompany();
  const ok = await company.updateSettings(
    ctxBody(orgId, { logoDataUri: 'data:image/png;base64,AAAA' }), co.tally_guid);
  assert.match(ok.settings.logoDataUri, /^data:image\/png/);

  // An SVG is an image that can carry script, so it is not on the list.
  for (const bad of ['data:image/svg+xml;base64,AAAA', 'data:text/html;base64,AAAA',
                     'https://example.com/logo.png', 'not a data uri']) {
    await assert.rejects(
      () => company.updateSettings(ctxBody(orgId, { logoDataUri: bad }), co.tally_guid),
      (e) => e.status === 400, `${bad} should be refused`);
  }
});

test('an oversized logo is refused with a size error, not a database error', async () => {
  const { orgId, co } = await makeCompany();
  const huge = 'data:image/png;base64,' + 'A'.repeat(600 * 1024);
  await assert.rejects(
    () => company.updateSettings(ctxBody(orgId, { logoDataUri: huge }), co.tally_guid),
    (e) => e.status === 413 && /smaller|under/i.test(e.message));
});

test('a logo can be cleared', async () => {
  const { orgId, co } = await makeCompany();
  await company.updateSettings(
    ctxBody(orgId, { logoDataUri: 'data:image/png;base64,AAAA' }), co.tally_guid);
  const r = await company.updateSettings(ctxBody(orgId, { logoDataUri: '' }), co.tally_guid);
  assert.equal(r.settings.logoDataUri, '');
});

test('an empty settings update is refused rather than silently doing nothing', async () => {
  const { orgId, co } = await makeCompany();
  await assert.rejects(
    () => company.updateSettings(ctxBody(orgId, {}), co.tally_guid),
    (e) => e.status === 400);
});

test('settings survive a profile sync from Tally', async () => {
  const { orgId, co } = await makeCompany();
  await company.updateSettings(ctxBody(orgId, { decimals: 2 }), co.tally_guid);
  // Exactly what ingest does when Tally reports the company profile.
  await query(
    `UPDATE companies SET name = COALESCE(NULLIF($2,''), name),
                          gstin = COALESCE(NULLIF($3,''), gstin), profile_at = now()
      WHERE id = $1`, [co.id, 'Renamed Co', '33AAA']);
  const r = await company.list(ctxFor(orgId));
  // The whole point of keeping these apart: Tally has no opinion about them,
  // so a sync must never reset them.
  assert.equal(r.companies[0].settings.decimals, 2);
  assert.equal(r.companies[0].profile.name, 'Renamed Co');
});

test('removing a book deletes its data and nothing else', async () => {
  const { orgId, co } = await makeCompany();
  const other = await makeCompany();
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,'1','Sales','2025-07-15','A',100)`, [co.id, `${co.id}-v`]);
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group) VALUES ($1,$2,'L','Sundry Debtors')`,
    [co.id, `${co.id}-l`]);

  const r = await company.remove(ctxFor(orgId), co.tally_guid);
  assert.equal(r.removed.companies, 1);
  assert.equal(r.removed.vouchers, 1);
  assert.equal(r.removed.ledgers, 1);
  // The customer's biggest fear, answered in the response itself.
  assert.match(r.note, /Tally.*untouched/i);

  const { rows } = await query('SELECT count(*)::int AS n FROM companies WHERE id = $1', [co.id]);
  assert.equal(rows[0].n, 0);
  // The other org's book is untouched.
  const stillThere = await company.list(ctxFor(other.orgId));
  assert.equal(stillThere.companies.length, 1);
});

test('another org\'s book cannot be removed', async () => {
  const a = await makeCompany();
  const b = await makeCompany();
  await assert.rejects(
    () => company.remove(ctxFor(b.orgId), a.co.tally_guid),
    (e) => e.status === 404);
  const still = await company.list(ctxFor(a.orgId));
  assert.equal(still.companies.length, 1, 'the book survived');
});

test('the company dashboard carries all twelve figures', async () => {
  const { orgId, co } = await makeCompany({ fy_start: '20250401', fy_end: '20260331' });
  const d = await company.summary(ctxFor(orgId), co.tally_guid);

  for (const k of ['sales', 'purchases', 'receivables', 'payables', 'cash', 'bank',
                   'stock', 'expenses', 'gst', 'profit']) {
    assert.equal(typeof d.metrics[k], 'number', `${k} is a number`);
  }
  assert.equal(d.financialYear.from, '2025-04-01');
  assert.equal(d.financialYear.to, '2026-03-31');
  assert.ok(d.syncStatus.state);
  assert.ok(d.connection.label);
});

test('with no connector paired, connection says so plainly', async () => {
  const { orgId, co } = await makeCompany();
  const d = await company.summary(ctxFor(orgId), co.tally_guid);
  assert.equal(d.connection.online, false);
  assert.equal(d.connection.label, 'Not connected');
  assert.match(d.connection.hint, /connector/i);
});

test('a connector that has not beaten in an hour reads as offline', async () => {
  const { orgId, co } = await makeCompany();
  await query(
    `INSERT INTO connectors (org_id, machine_name, token_hash, last_seen_at)
     VALUES ($1, 'SHOP-PC', $2, now() - interval '1 hour')`, [orgId, `h-${orgId}`]);
  const d = await company.summary(ctxFor(orgId), co.tally_guid);
  assert.equal(d.connection.online, false);
  assert.equal(d.connection.label, 'Connector offline');
  assert.equal(d.connection.machineName, 'SHOP-PC');
});

test('a live connector with Tally closed is named as that, not as offline', async () => {
  const { orgId, co } = await makeCompany();
  await query(
    `INSERT INTO connectors (org_id, machine_name, token_hash, last_seen_at, tally_up)
     VALUES ($1, 'SHOP-PC', $2, now(), false)`, [orgId, `h2-${orgId}`]);
  const d = await company.summary(ctxFor(orgId), co.tally_guid);
  // The fix is different from an offline connector, so the words must be too.
  assert.equal(d.connection.online, true);
  assert.equal(d.connection.label, 'Tally not running');
  assert.match(d.connection.hint, /Open Tally/i);
});

test('queued batches read as catching up, and say nothing is lost', async () => {
  const { orgId, co } = await makeCompany();
  await query(
    `INSERT INTO connectors (org_id, machine_name, token_hash, last_seen_at, queued_batches)
     VALUES ($1, 'SHOP-PC', $2, now(), 4)`, [orgId, `h3-${orgId}`]);
  const d = await company.summary(ctxFor(orgId), co.tally_guid);
  assert.equal(d.connection.label, 'Catching up');
  assert.match(d.connection.hint, /nothing is lost/i);
});
