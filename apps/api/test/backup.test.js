const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const backup = require('../src/routes/backup');

/**
 * Backing up Munim's copy of the books.
 *
 * The one thing a backup must do is restore. Every test here ends by checking
 * the data actually came back — a backup that cannot be restored is worse than
 * none, because somebody is relying on it.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['bk-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `bk-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name, gstin)
     VALUES ($1,$2,'Bk Co','33AAAAA0000A1Z9') RETURNING *`,
    [o[0].id, `bk-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, body = {}) => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  url: new URL('http://x/'), body,
});

/** A small but complete book: masters, vouchers, lines and bills. */
async function seed(f, { vouchers = 3, syncedAt = null } = {}) {
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group, closing_paise)
     VALUES ($1,$2,'Acme','Sundry Debtors',5000) ON CONFLICT DO NOTHING`,
    [f.co.id, `l-${f.co.id}`]);
  await query(
    `INSERT INTO stock_items (company_id, guid, name, unit, closing_qty)
     VALUES ($1,$2,'Widget','Nos',10) ON CONFLICT DO NOTHING`, [f.co.id, `i-${f.co.id}`]);

  for (let n = 1; n <= vouchers; n++) {
    const { rows } = await query(
      `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party,
                             amount_paise, synced_at)
       VALUES ($1,$2,$3,'Sales','2026-05-01','Acme',1000, COALESCE($4, now()))
       ON CONFLICT DO NOTHING RETURNING id`,
      [f.co.id, `v-${f.co.id}-${n}`, String(n), syncedAt]);
    if (!rows.length) continue;
    await query(
      `INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise)
       VALUES ($1,'Acme',1000), ($1,'Sales',-1000)`, [rows[0].id]);
    await query(
      `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, amount_paise, bill_type)
       VALUES ($1,$2,$3,'Acme','2026-05-01',1000,'New Ref')`,
      [f.co.id, rows[0].id, `INV-${n}`]);
  }
}

const countRows = async (companyId) => {
  const one = async (t) => (await query(
    `SELECT count(*)::int AS n FROM ${t} WHERE company_id = $1`, [companyId])).rows[0].n;
  const child = async (t) => (await query(
    `SELECT count(*)::int AS n FROM ${t} c JOIN vouchers v ON v.id = c.voucher_id
      WHERE v.company_id = $1`, [companyId])).rows[0].n;
  return {
    ledgers: await one('ledgers'), items: await one('stock_items'),
    vouchers: await one('vouchers'), bills: await one('bills'),
    entries: await child('voucher_entries'),
  };
};

// --- taking one -------------------------------------------------------------

test('a full backup carries the whole book and compresses it', async () => {
  const f = await fixture();
  await seed(f);
  const r = await backup.create(ctxFor(f, { kind: 'full' }), f.co.tally_guid);

  assert.equal(r.backup.counts.vouchers, 3);
  assert.equal(r.backup.counts.voucher_entries, 6);
  assert.equal(r.backup.counts.bills, 3);
  assert.ok(r.backup.sizeBytes < r.backup.rawBytes, 'compressed');
  assert.equal(r.backup.checksum.length, 64);
});

test('the note never lets anyone think Tally is backed up', async () => {
  const f = await fixture();
  await seed(f);
  const r = await backup.create(ctxFor(f), f.co.tally_guid);
  // The most expensive misunderstanding this product could create.
  assert.match(r.note, /Tally company file is separate/i);
});

test('a backup verifies against its own checksum', async () => {
  const f = await fixture();
  await seed(f);
  const made = await backup.create(ctxFor(f), f.co.tally_guid);
  const v = await backup.verify(ctxFor(f), made.backup.id);
  assert.equal(v.ok, true);
  assert.equal(v.counts.vouchers, 3);
});

test('a damaged backup is caught rather than restored', async () => {
  const f = await fixture();
  await seed(f);
  const made = await backup.create(ctxFor(f), f.co.tally_guid);
  // Corrupt the stored checksum, as a bad disk or a bad write would.
  await query(`UPDATE backups SET checksum = 'wrong' WHERE id = $1`, [made.backup.id]);

  const v = await backup.verify(ctxFor(f), made.backup.id);
  assert.equal(v.ok, false);
  assert.match(v.reason, /damaged|checksum/i);

  // And a restore refuses rather than half-restoring.
  await assert.rejects(
    () => backup.restore(ctxFor(f, { backupId: made.backup.id })),
    (e) => e.status === 500 && /Nothing was changed/.test(e.message));
});

test('download refuses a backup that fails its checksum', async () => {
  const f = await fixture();
  await seed(f);
  const made = await backup.create(ctxFor(f), f.co.tally_guid);
  await query(`UPDATE backups SET checksum = 'wrong' WHERE id = $1`, [made.backup.id]);
  await assert.rejects(
    () => backup.download(ctxFor(f), made.backup.id), (e) => e.status === 500);
});

// --- restoring --------------------------------------------------------------

test('a full restore brings back every row after everything is deleted', async () => {
  const f = await fixture();
  await seed(f);
  const before = await countRows(f.co.id);
  const made = await backup.create(ctxFor(f), f.co.tally_guid);

  // Simulate losing the lot.
  for (const t of ['voucher_entries', 'voucher_items']) {
    await query(`DELETE FROM ${t} WHERE voucher_id IN
                   (SELECT id FROM vouchers WHERE company_id = $1)`, [f.co.id]);
  }
  for (const t of ['bills', 'vouchers', 'ledgers', 'stock_items']) {
    await query(`DELETE FROM ${t} WHERE company_id = $1`, [f.co.id]);
  }
  assert.equal((await countRows(f.co.id)).vouchers, 0);

  const r = await backup.restore(ctxFor(f, { backupId: made.backup.id }));
  assert.deepEqual(await countRows(f.co.id), before);
  assert.match(r.note, /Tally company file was not touched/i);
});

test('a full restore replaces rather than merging', async () => {
  const f = await fixture();
  await seed(f, { vouchers: 2 });
  const made = await backup.create(ctxFor(f), f.co.tally_guid);

  // A voucher added after the backup. A restore is a restore: it should go.
  await seed(f, { vouchers: 5 });
  assert.equal((await countRows(f.co.id)).vouchers, 5);

  await backup.restore(ctxFor(f, { backupId: made.backup.id }));
  // Otherwise the result matches neither the backup nor Tally.
  assert.equal((await countRows(f.co.id)).vouchers, 2);
});

test('restoring into a removed company recreates it from the archive', async () => {
  const f = await fixture();
  await seed(f);
  const made = await backup.create(ctxFor(f), f.co.tally_guid);

  for (const t of ['voucher_entries', 'voucher_items']) {
    await query(`DELETE FROM ${t} WHERE voucher_id IN
                   (SELECT id FROM vouchers WHERE company_id = $1)`, [f.co.id]);
  }
  for (const t of ['bills', 'vouchers', 'ledgers', 'stock_items']) {
    await query(`DELETE FROM ${t} WHERE company_id = $1`, [f.co.id]);
  }
  await query('DELETE FROM companies WHERE id = $1', [f.co.id]);

  const r = await backup.restore(ctxFor(f, { backupId: made.backup.id }));
  const { rows } = await query(
    'SELECT id, name, gstin FROM companies WHERE org_id = $1 AND tally_guid = $2',
    [f.orgId, f.co.tally_guid]);

  // A restore must not need a working connector first.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].gstin, '33AAAAA0000A1Z9', 'the profile came back too');
  assert.equal(r.restored.vouchers, 3);
});

// --- incremental ------------------------------------------------------------

test('an incremental needs a parent', async () => {
  const f = await fixture();
  await seed(f);
  await assert.rejects(
    () => backup.create(ctxFor(f, { kind: 'incremental' }), f.co.tally_guid),
    (e) => e.status === 400 && /full backup first/i.test(e.message));
});

test('an incremental carries only what changed', async () => {
  const f = await fixture();
  await seed(f, { vouchers: 2 });
  await backup.create(ctxFor(f, { kind: 'full' }), f.co.tally_guid);

  // Two more arrive after the full backup.
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party,
                           amount_paise, synced_at)
     VALUES ($1,'new-1','9','Sales','2026-06-01','Acme',500, now()),
            ($1,'new-2','10','Sales','2026-06-02','Acme',500, now())`, [f.co.id]);

  const inc = await backup.create(ctxFor(f, { kind: 'incremental' }), f.co.tally_guid);
  assert.equal(inc.backup.counts.vouchers, 2);
  // Masters always travel in full: an incremental that omitted a renamed
  // ledger would restore vouchers pointing at nothing.
  assert.equal(inc.backup.counts.ledgers, 1);
});

test('an incremental restore adds without wiping', async () => {
  const f = await fixture();
  await seed(f, { vouchers: 2 });
  await backup.create(ctxFor(f, { kind: 'full' }), f.co.tally_guid);
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party,
                           amount_paise, synced_at)
     VALUES ($1,'new-1','9','Sales','2026-06-01','Acme',500, now())`, [f.co.id]);
  const inc = await backup.create(ctxFor(f, { kind: 'incremental' }), f.co.tally_guid);

  await query(`DELETE FROM vouchers WHERE company_id = $1 AND guid = 'new-1'`, [f.co.id]);
  assert.equal((await countRows(f.co.id)).vouchers, 2);

  await backup.restore(ctxFor(f, { backupId: inc.backup.id }));
  assert.equal((await countRows(f.co.id)).vouchers, 3, 'added, not replaced');
});

// --- uploaded archives ------------------------------------------------------

test('an uploaded archive is checked as hard as a stored one', async () => {
  const f = await fixture();
  for (const bad of ['not json', '{}', JSON.stringify({ version: 99, company: {}, data: {} })]) {
    await assert.rejects(
      () => backup.restore(ctxFor(f, { archive: bad })), (e) => e.status === 400);
  }
});

test('a download round-trips through an upload', async () => {
  const f = await fixture();
  await seed(f);
  const made = await backup.create(ctxFor(f), f.co.tally_guid);
  const file = await backup.download(ctxFor(f), made.backup.id);

  for (const t of ['bills', 'vouchers']) {
    await query(`DELETE FROM ${t} WHERE company_id = $1`, [f.co.id]);
  }
  const r = await backup.restore(ctxFor(f, { archive: file.archive }));
  assert.equal(r.restored.vouchers, 3);
  assert.match(file.filename, /^munim_Bk-Co_\d{4}-\d{2}-\d{2}_full\.json$/);
});

// --- retention and scheduling ----------------------------------------------

test('old backups lose their file but keep their history', async () => {
  const f = await fixture();
  await seed(f);
  await backup.settings(ctxFor(f, { keep: 2 }));
  for (let i = 0; i < 4; i++) await backup.create(ctxFor(f), f.co.tally_guid);

  const l = await backup.list(ctxFor(f));
  assert.equal(l.backups.length, 4, 'the history is all there');
  // So somebody can see a backup was taken in March even though the file is
  // long gone.
  assert.equal(l.backups.filter((b) => b.available).length, 2);
});

test('a silly retention or schedule is refused', async () => {
  const f = await fixture();
  await assert.rejects(() => backup.settings(ctxFor(f, { keep: 0 })), (e) => e.status === 400);
  await assert.rejects(() => backup.settings(ctxFor(f, { keep: 500 })), (e) => e.status === 400);
  await assert.rejects(
    () => backup.settings(ctxFor(f, { schedule: 'hourly' })), (e) => e.status === 400);
});

test('a schedule decides when one is due', async () => {
  const f = await fixture();
  assert.equal(await backup.due(f.orgId), false, 'off by default');

  await backup.settings(ctxFor(f, { schedule: 'daily' }));
  assert.equal(await backup.due(f.orgId), true, 'never taken');

  await query('UPDATE orgs SET backup_last_at = now() WHERE id = $1', [f.orgId]);
  assert.equal(await backup.due(f.orgId), false, 'taken today');

  await query(
    `UPDATE orgs SET backup_last_at = now() - interval '2 days' WHERE id = $1`, [f.orgId]);
  assert.equal(await backup.due(f.orgId), true);
});

test('a backup cannot be read across businesses', async () => {
  const a = await fixture();
  const b = await fixture();
  await seed(a);
  const made = await backup.create(ctxFor(a), a.co.tally_guid);

  for (const fn of [backup.download, backup.verify]) {
    await assert.rejects(() => fn(ctxFor(b), made.backup.id), (e) => e.status === 404);
  }
  await assert.rejects(
    () => backup.restore(ctxFor(b, { backupId: made.backup.id })), (e) => e.status === 404);
});
