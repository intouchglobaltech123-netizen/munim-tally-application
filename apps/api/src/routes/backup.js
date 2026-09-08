'use strict';
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { query, tx } = require('../db');
const audit = require('../lib/audit');
const secrets = require('../lib/secrets');
const webhooks = require('../lib/webhooks');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const { HttpError } = require('../lib/http');
const { companyFor } = require('./reports');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Backing up Munim's copy of the books.
 *
 * The boundary matters and is stated everywhere it could be misread: Munim
 * reads Tally and never writes to it, so this backs up what MUNIM holds and
 * restores into Munim. A customer's Tally company file is not covered by it,
 * and letting somebody believe otherwise would be the most expensive
 * misunderstanding this product could create.
 *
 * What it is genuinely good for: a shop whose PC dies still has every voucher
 * in a file they own; a company removed from Munim can be put back without a
 * full re-sync; and an accountant can be handed the data without a login.
 */

const ARCHIVE_VERSION = 1;

/*
 * What goes in, and in this order.
 *
 * Parents before children, because a restore inserts in the same order and a
 * voucher line cannot land before its voucher.
 */
const TABLES = [
  { name: 'groups', by: 'company_id' },
  { name: 'ledgers', by: 'company_id' },
  { name: 'stock_items', by: 'company_id' },
  { name: 'stock_batches', by: 'company_id' },
  { name: 'vouchers', by: 'company_id' },
  { name: 'voucher_entries', by: 'voucher' },
  { name: 'voucher_items', by: 'voucher' },
  { name: 'bills', by: 'company_id' },
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Read one company's rows, optionally only what changed since a cut-off. */
async function collect(companyId, since) {
  const data = {};
  const counts = {};

  for (const t of TABLES) {
    let sql;
    const args = [companyId];

    if (t.by === 'company_id') {
      sql = `SELECT * FROM ${t.name} WHERE company_id = $1`;
      if (since && t.name === 'vouchers') {
        // Only vouchers carry a sync timestamp, so only they can be narrowed.
        // Masters are small and are always taken in full - an incremental that
        // omitted a renamed ledger would restore vouchers pointing at nothing.
        sql += ` AND synced_at > $${args.push(since)}`;
      }
    } else {
      // Children follow whichever vouchers were taken.
      sql = `SELECT c.* FROM ${t.name} c
               JOIN vouchers v ON v.id = c.voucher_id
              WHERE v.company_id = $1`;
      if (since) sql += ` AND v.synced_at > $${args.push(since)}`;
    }

    const { rows } = await query(sql, args);
    data[t.name] = rows;
    counts[t.name] = rows.length;
  }

  return { data, counts };
}

/** Take a backup. */
async function create(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'create');
  const co = await companyFor(s, tallyGuid);
  const kind = ctx.body?.kind === 'incremental' ? 'incremental' : 'full';

  let parent = null;
  let since = null;
  if (kind === 'incremental') {
    const { rows } = await query(
      `SELECT id, taken_upto FROM backups
        WHERE org_id = $1 AND company_id = $2 AND status = 'ready'
        ORDER BY created_at DESC LIMIT 1`, [s.org.id, co.id]);
    if (!rows.length) {
      throw new HttpError(400, 'NO_PARENT',
        'There is no earlier backup to build on. Take a full backup first.');
    }
    parent = rows[0].id;
    since = rows[0].taken_upto;
  }

  const takenUpto = new Date();
  const { data, counts } = await collect(co.id, since);

  const { rows: cos } = await query('SELECT * FROM companies WHERE id = $1', [co.id]);
  const archive = {
    version: ARCHIVE_VERSION,
    kind,
    takenAt: takenUpto.toISOString(),
    since: since ? new Date(since).toISOString() : null,
    company: {
      tallyGuid: cos[0].tally_guid,
      name: cos[0].name,
      // The profile travels too, so a restore into a fresh account rebuilds
      // the letterhead rather than producing a nameless company.
      profile: {
        formalName: cos[0].formal_name, address: cos[0].address,
        state: cos[0].state, pincode: cos[0].pincode, phone: cos[0].phone,
        email: cos[0].email, gstin: cos[0].gstin, pan: cos[0].pan,
        fyStart: cos[0].fy_start, fyEnd: cos[0].fy_end,
      },
    },
    counts,
    data,
  };

  const raw = Buffer.from(JSON.stringify(archive), 'utf8');
  /*
   * Checksummed over the PLAINTEXT, and compressed before it is sealed.
   *
   * Both orderings matter. A checksum over ciphertext would prove only that the
   * bytes came back as stored, not that the book inside is intact - and it is
   * the book that is being protected. Compressing after encryption would
   * achieve nothing at all: ciphertext has no redundancy left to squeeze.
   */
  const checksum = sha256(raw);
  const compressed = await gzip(raw, { level: 9 });
  const sealed = secrets.seal(s.org.id, compressed);
  const payload = sealed.data;

  const { rows } = await query(
    `INSERT INTO backups (org_id, company_id, company_name, kind, parent_id, trigger,
                          payload, size_bytes, raw_bytes, checksum, counts,
                          taken_upto, created_by, enc_alg, enc_iv, enc_tag)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)
     RETURNING id, created_at`,
    [s.org.id, co.id, cos[0].name, kind, parent,
     ctx.body?.trigger === 'scheduled' ? 'scheduled' : 'manual',
     payload, payload.length, raw.length, checksum,
     JSON.stringify(counts), takenUpto, s.user.id,
     sealed.alg, sealed.iv, sealed.tag]);

  await prune(s.org.id);
  await audit.record(ctx, 'backup.create', {
    companyId: co.id, entityId: rows[0].id, entityName: cos[0].name,
    meta: { kind, counts, sizeBytes: payload.length, encrypted: sealed.alg !== 'none' },
  });

  webhooks.emit(s.org.id, 'backup.completed', {
    backup: rows[0].id, company: cos[0].name, kind,
    sizeBytes: payload.length, counts,
  });

  return {
    backup: {
      id: rows[0].id, kind, createdAt: rows[0].created_at,
      sizeBytes: payload.length, rawBytes: raw.length,
      checksum, counts,
      encrypted: sealed.alg !== 'none',
    },
    note: 'This is a copy of what Munim holds. Your Tally company file is '
        + 'separate and still needs its own backup.',
  };
}

/**
 * Drop the oldest beyond the retention limit.
 *
 * The payload is nulled rather than the row deleted: the history stays
 * readable, so somebody can see that a backup was taken in March even though
 * the file itself is long gone.
 */
async function prune(orgId) {
  const { rows } = await query('SELECT backup_keep FROM orgs WHERE id = $1', [orgId]);
  const keep = rows[0]?.backup_keep ?? 10;

  await query(
    `UPDATE backups SET payload = NULL, size_bytes = 0
      WHERE org_id = $1 AND payload IS NOT NULL AND id NOT IN (
        SELECT id FROM backups
         WHERE org_id = $1 AND payload IS NOT NULL
         ORDER BY created_at DESC LIMIT $2)`,
    [orgId, keep]);
}

/** Every backup taken, newest first. */
async function list(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');

  const { rows } = await query(
    `SELECT b.id, b.company_name, b.kind, b.trigger, b.status, b.size_bytes,
            b.raw_bytes, b.checksum, b.counts, b.created_at, b.error,
            b.payload IS NOT NULL AS available, b.enc_alg,
            u.name AS by_name
       FROM backups b
       LEFT JOIN users u ON u.id = b.created_by
      WHERE b.org_id = $1 ORDER BY b.created_at DESC LIMIT 100`, [s.org.id]);

  const { rows: org } = await query(
    'SELECT backup_keep, backup_schedule, backup_last_at FROM orgs WHERE id = $1', [s.org.id]);

  return {
    backups: rows.map((r) => ({
      id: r.id, companyName: r.company_name, kind: r.kind, trigger: r.trigger,
      status: r.status, sizeBytes: Number(r.size_bytes), rawBytes: Number(r.raw_bytes),
      checksum: r.checksum, counts: r.counts, createdAt: r.created_at,
      error: r.error, by: r.by_name ?? '',
      // Distinguished from deleted: the row is history, the file may be gone.
      available: r.available,
      encrypted: r.enc_alg !== 'none',
    })),
    settings: {
      keep: org[0].backup_keep,
      schedule: org[0].backup_schedule,
      lastAt: org[0].backup_last_at,
      // Surfaced so the answer to "are our backups encrypted" is on the screen
      // rather than in somebody's memory of how the server was deployed.
      encryptionOn: secrets.enabled(),
    },
    note: 'Munim backs up its own copy of your books. Your Tally data file is '
        + 'separate — keep taking Tally\'s own backups as well.',
  };
}

/**
 * The archive, as a file.
 *
 * Verified before it is handed over: a backup nobody has checked is a guess,
 * and finding out it was corrupt at restore time is finding out too late.
 */
/**
 * Turn a stored row back into the archive it was made from.
 *
 * Every read path goes through here - download, verify and restore - so there
 * is exactly one place that knows a payload is sealed, and no way to add a
 * fourth reader that forgets. Unsealing first, then decompressing, is the
 * reverse of how it was written; getting that order wrong fails loudly rather
 * than quietly, which is the good case.
 */
async function unseal(orgId, row) {
  const compressed = secrets.open(orgId, {
    alg: row.enc_alg, iv: row.enc_iv, tag: row.enc_tag, data: row.payload,
  });
  return gunzip(compressed);
}

async function download(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'export');

  const { rows } = await query(
    'SELECT * FROM backups WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such backup.');
  if (!rows[0].payload) {
    throw new HttpError(410, 'GONE',
      'This backup has passed its retention limit and the file is no longer kept.');
  }

  const raw = await unseal(s.org.id, rows[0]);
  if (sha256(raw) !== rows[0].checksum) {
    throw new HttpError(500, 'CORRUPT',
      'This backup failed its checksum and will not be handed over. '
      + 'Take a fresh one.');
  }

  const name = `munim_${String(rows[0].company_name).replace(/[^a-zA-Z0-9]+/g, '-')}`
    + `_${new Date(rows[0].created_at).toISOString().slice(0, 10)}_${rows[0].kind}.json`;

  return {
    filename: name,
    checksum: rows[0].checksum,
    // Returned as text rather than a stream: an archive is a few megabytes and
    // the apps hand it straight to a download.
    archive: raw.toString('utf8'),
  };
}

/** Check a backup without restoring it. */
async function verify(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');

  const { rows } = await query(
    'SELECT * FROM backups WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such backup.');
  if (!rows[0].payload) return { ok: false, reason: 'The file is past its retention limit.' };

  try {
    const raw = await unseal(s.org.id, rows[0]);
    const actual = sha256(raw);
    if (actual !== rows[0].checksum) {
      return { ok: false, reason: 'Checksum does not match. This backup is damaged.' };
    }
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed.version !== ARCHIVE_VERSION) {
      return { ok: false, reason: `Written by a different version (${parsed.version}).` };
    }
    return {
      ok: true,
      counts: parsed.counts,
      takenAt: parsed.takenAt,
      company: parsed.company?.name ?? '',
      reason: 'Opens, matches its checksum, and contains what it claims.',
    };
  } catch (e) {
    return { ok: false, reason: `Could not be read: ${e.message}` };
  }
}

/**
 * Put a backup back into Munim.
 *
 * Restores into the company the archive names, matched by Tally GUID. It does
 * NOT write to Tally: the customer's accounting software is untouched, and the
 * response says so.
 */
async function restore(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'delete');
  const b = ctx.body || {};

  let archive;
  if (b.backupId) {
    const { rows } = await query(
      'SELECT * FROM backups WHERE id = $1 AND org_id = $2', [b.backupId, s.org.id]);
    if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such backup.');
    if (!rows[0].payload) {
      throw new HttpError(410, 'GONE', 'That backup is past its retention limit.');
    }
    const raw = await unseal(s.org.id, rows[0]);
    if (sha256(raw) !== rows[0].checksum) {
      throw new HttpError(500, 'CORRUPT', 'That backup failed its checksum. Nothing was changed.');
    }
    archive = JSON.parse(raw.toString('utf8'));
  } else if (typeof b.archive === 'string') {
    // An uploaded file. Checked exactly as hard as a stored one.
    try {
      archive = JSON.parse(b.archive);
    } catch {
      throw new HttpError(400, 'BAD_ARCHIVE', 'That file is not a Munim backup.');
    }
  } else {
    throw new HttpError(400, 'BAD_REQUEST', 'Give a backup id or an archive to restore.');
  }

  if (archive?.version !== ARCHIVE_VERSION || !archive.company?.tallyGuid || !archive.data) {
    throw new HttpError(400, 'BAD_ARCHIVE',
      'That file is not a Munim backup, or was written by a different version.');
  }

  const { rows: co } = await query(
    'SELECT id FROM companies WHERE org_id = $1 AND tally_guid = $2',
    [s.org.id, archive.company.tallyGuid]);

  return tx(async (c) => {
    let companyId = co[0]?.id;

    if (!companyId) {
      // The company was removed, or this is a fresh account. Recreate it from
      // what the archive carries, so a restore does not need a connector first.
      const p = archive.company.profile ?? {};
      const { rows } = await c.query(
        `INSERT INTO companies (org_id, tally_guid, name, formal_name, address, state,
                                pincode, phone, email, gstin, pan, fy_start, fy_end)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [s.org.id, archive.company.tallyGuid, archive.company.name,
         p.formalName ?? '', p.address ?? '', p.state ?? '', p.pincode ?? '',
         p.phone ?? '', p.email ?? '', p.gstin ?? '', p.pan ?? '',
         p.fyStart ?? '', p.fyEnd ?? '']);
      companyId = rows[0].id;
    }

    const restored = {};

    /*
     * A full restore replaces; an incremental adds.
     *
     * Clearing first on a full restore is what makes it a restore rather than
     * a merge: a voucher deleted in Tally since the backup would otherwise
     * survive, and the result would match neither the backup nor Tally.
     */
    if (archive.kind === 'full') {
      for (const t of [...TABLES].reverse()) {
        if (t.by === 'company_id') {
          await c.query(`DELETE FROM ${t.name} WHERE company_id = $1`, [companyId]);
        } else {
          await c.query(
            `DELETE FROM ${t.name} WHERE voucher_id IN
               (SELECT id FROM vouchers WHERE company_id = $1)`, [companyId]);
        }
      }
    }

    for (const t of TABLES) {
      const rows = archive.data[t.name] ?? [];
      if (!rows.length) { restored[t.name] = 0; continue; }

      let done = 0;
      for (const row of rows) {
        const r = { ...row };
        // Re-point at this account's company, whatever id the archive carried.
        if ('company_id' in r) r.company_id = companyId;

        const cols = Object.keys(r);
        const params = cols.map((_, i) => `$${i + 1}`);
        await c.query(
          `INSERT INTO ${t.name} (${cols.map((x) => `"${x}"`).join(',')})
           VALUES (${params.join(',')}) ON CONFLICT DO NOTHING`,
          cols.map((k) => r[k]));
        done += 1;
      }
      restored[t.name] = done;
    }

    await c.query(
      `INSERT INTO audit_log (org_id, user_id, action, meta) VALUES ($1,$2,$3,$4)`,
      [s.org.id, s.user.id, 'backup.restore',
       JSON.stringify({ company: archive.company.name, kind: archive.kind, restored })]);

    return {
      company: archive.company.name,
      kind: archive.kind,
      restored,
      note: 'Restored into Munim. Your Tally company file was not touched — '
          + 'Munim never writes to Tally.',
    };
  });
}

/** How often to take one, and how many to keep. */
async function settings(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');
  const b = ctx.body || {};
  const sets = [];
  const args = [s.org.id];

  if (b.schedule !== undefined) {
    if (!['off', 'daily', 'weekly'].includes(b.schedule)) {
      throw new HttpError(400, 'BAD_SCHEDULE', 'Schedule must be off, daily or weekly.');
    }
    sets.push(`backup_schedule = $${args.push(b.schedule)}`);
  }
  if (b.keep !== undefined) {
    const n = Number(b.keep);
    if (!Number.isInteger(n) || n < 1 || n > 60) {
      throw new HttpError(400, 'BAD_KEEP', 'Keep between 1 and 60 backups.');
    }
    sets.push(`backup_keep = $${args.push(n)}`);
  }
  if (!sets.length) throw new HttpError(400, 'NOTHING_TO_DO', 'No settings were given.');

  await query(`UPDATE orgs SET ${sets.join(', ')} WHERE id = $1`, args);
  if (b.keep !== undefined) await prune(s.org.id);
  await audit.record(ctx, 'backup.settings', { after: b });

  return { saved: true };
}

/**
 * Is a scheduled backup due?
 *
 * Asked by the connector on its heartbeat, because nothing in this system runs
 * on a timer of its own - and a shop's data is only worth backing up when
 * their PC is on anyway.
 */
async function due(orgId) {
  const { rows } = await query(
    'SELECT backup_schedule, backup_last_at FROM orgs WHERE id = $1', [orgId]);
  if (!rows.length || rows[0].backup_schedule === 'off') return false;

  const last = rows[0].backup_last_at;
  if (!last) return true;

  const days = (Date.now() - new Date(last).getTime()) / 86_400_000;
  return rows[0].backup_schedule === 'daily' ? days >= 1 : days >= 7;
}

module.exports = { create, list, download, verify, restore, settings, due, prune, ARCHIVE_VERSION };
