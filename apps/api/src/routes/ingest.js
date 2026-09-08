'use strict';
const { query, tx } = require('../db');
const { bad } = require('../lib/http');
const auth = require('../lib/auth');
const events = require('../lib/events');
const VT = require('../lib/vouchertypes');
const audit = require('../lib/audit');
const quotas = require('../lib/quotas');
const webhooks = require('../lib/webhooks');
const plans = require('../lib/plans');
const businesses = require('../lib/businesses');
const { dateOnly } = audit;

/**
 * The hot path: roughly 90% of all traffic.
 *
 * One transaction per batch. Every write is an upsert keyed on
 * (company_id, guid), so a retry after a timeout is harmless - which is what
 * lets the connector retry freely without risking duplicates.
 */
async function ingest(ctx) {
  const conn = auth.requireConnector(ctx);

  // Idempotency scoped to the CONNECTOR. The connector derives its key from
  // batch contents, so two businesses whose books produce an identical batch
  // would otherwise collide: the second would get a replayed 200, its data
  // would never be written, and its cursor would advance past it. Silent,
  // per-tenant data loss. Never trust a client key to be globally unique.
  const key = ctx.req.headers['idempotency-key'];
  if (key) {
    const { rows } = await query(
      'SELECT response FROM ingest_keys WHERE connector_id = $1 AND key = $2',
      [conn.id, key],
    );
    if (rows.length) return rows[0].response;
  }

  const lines = ctx.raw.toString('utf8').split('\n').filter((l) => l.trim());
  if (lines.length > 5000) throw bad('BATCH_TOO_LARGE', 'Send at most 5000 records per batch.');

  const result = await tx(async (c) => {
    const companyIds = new Map();   // tallyGuid -> uuid
    let accepted = 0, rejected = 0;
    /*
     * What arrived that somebody would want to know about.
     *
     * Gathered inside the transaction but announced after it commits: a
     * notification for a voucher that then failed to save would be a lie, and
     * one raised inside the transaction would hold a lock while it wrote.
     */
    const arrivals = [];
    /*
     * Vouchers that changed in Tally after the fact, gathered the same way and
     * for the same reason. See trailAfterSync() for what is worth recording
     * and what is deliberately not.
     */
    const trail = [];
    // Companies whose profile arrived this batch and may now be groupable.
    const regroup = new Set();
    // Neither accepted nor rejected: a record we already hold a newer copy of.
    let stale = 0;
    const errors = [];
    let maxMaster = 0, maxVoucher = 0;
    const touched = new Set();

    const companyId = async (guid) => {
      if (companyIds.has(guid)) return companyIds.get(guid);

      /*
       * The companies ceiling is enforced HERE, not on a screen.
       *
       * Nobody adds a company in Munim - the connector discovers whatever is
       * open in Tally and sends it. So this insert is the only moment a
       * customer's book count can grow, and a check anywhere else would be a
       * check on a door that is not the one being used.
       *
       * Existing companies are never refused: a customer moved to a smaller
       * plan keeps syncing what they already had, and is stopped only from
       * adding more. Cutting off books they are already relying on would be
       * punishing them for our billing change.
       */
      const { rows: known } = await c.query(
        'SELECT id FROM companies WHERE org_id = $1 AND tally_guid = $2', [conn.orgId, guid]);
      if (!known.length) {
        const { rows: count } = await c.query(
          'SELECT count(*)::int AS n FROM companies WHERE org_id = $1', [conn.orgId]);
        const { rows: org } = await c.query('SELECT * FROM orgs WHERE id = $1', [conn.orgId]);
        quotas.assertWithin(org[0], 'companies', count[0].n, {
          message: `Your plan covers ${plans.limitFor(org[0], 'companies')} `
                 + 'company. Munim is still syncing the books you already had, '
                 + 'but this new one was not added. Upgrade to include it.',
        });
      }

      const { rows } = await c.query(
        `INSERT INTO companies (org_id, tally_guid, name)
         VALUES ($1, $2, $2)
         ON CONFLICT (org_id, tally_guid) DO UPDATE SET tally_guid = EXCLUDED.tally_guid
         RETURNING id`,
        [conn.orgId, guid],
      );
      companyIds.set(guid, rows[0].id);
      return rows[0].id;
    };

    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { rejected++; continue; }
      if (!rec || !rec.companyGuid || !rec.guid) { rejected++; continue; }

      try {
        const cid = await companyId(rec.companyGuid);
        touched.add(cid);
        const alterId = Number(rec.alterId) || 0;
        const d = rec.data || {};

        if (rec.kind === 'group') {
          // Groups are the account tree. Without them there is no Trial
          // Balance, no P&L and no Balance Sheet - they were being rejected.
          await c.query(
            `INSERT INTO groups (company_id, guid, name, parent, primary_group, alter_id)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (company_id, guid) DO UPDATE SET
               name = EXCLUDED.name, parent = EXCLUDED.parent,
               primary_group = EXCLUDED.primary_group, alter_id = EXCLUDED.alter_id
             -- Never let an older version overwrite a newer one.
             --
             -- ALTERID only ever counts upward for a given record, so it is a
             -- version number. Without this guard the offline outbox can
             -- corrupt data by design: a batch queued on Monday and replayed
             -- after Tuesday's live batch would overwrite Tuesday's voucher
             -- with Monday's. Records that predate ALTERID report 0, and
             -- 0 >= 0 still updates, so nothing is lost.
             WHERE EXCLUDED.alter_id >= groups.alter_id`,
            [cid, rec.guid, d.name || '', d.parent || '', d.primaryGroup || '', alterId],
          );
          maxMaster = Math.max(maxMaster, alterId);

        } else if (rec.kind === 'company') {
          await c.query(
            // org_id as well as id: cid is already resolved from this
            // connector's org, so this is belt and braces - but it is one
            // clause, and it makes the query provably tenant-safe on its own
            // rather than only in combination with the line that produced cid.
            `UPDATE companies SET name = COALESCE(NULLIF($2,''), name)
              WHERE id = $1 AND org_id = $3`,
            [cid, d.name || '', conn.orgId]);

        } else if (rec.kind === 'companyProfile') {
          /*
           * Who the customer is, for the top of every document they send out.
           *
           * COALESCE(NULLIF(...)) on every field, so a Tally version that does
           * not report GSTIN cannot blank a GSTIN we already have. A field
           * absent from the answer means "not asked", never "cleared".
           */
          await c.query(
            `UPDATE companies SET
               name        = COALESCE(NULLIF($2,''),  name),
               formal_name = COALESCE(NULLIF($3,''),  formal_name),
               address     = COALESCE(NULLIF($4,''),  address),
               state       = COALESCE(NULLIF($5,''),  state),
               country     = COALESCE(NULLIF($6,''),  country),
               pincode     = COALESCE(NULLIF($7,''),  pincode),
               phone       = COALESCE(NULLIF($8,''),  phone),
               email       = COALESCE(NULLIF($9,''),  email),
               gstin       = COALESCE(NULLIF($10,''), gstin),
               pan         = COALESCE(NULLIF($11,''), pan),
               cin         = COALESCE(NULLIF($12,''), cin),
               books_from  = COALESCE(NULLIF($13,''), books_from),
               fy_start    = COALESCE(NULLIF($14,''), fy_start),
               fy_end      = COALESCE(NULLIF($15,''), fy_end),
               currency    = COALESCE(NULLIF($16,''), currency),
               profile_at  = now()
             WHERE id = $1 AND org_id = $17`,
            [cid, d.name || '', d.formalName || '', d.address || '', d.state || '',
             d.country || '', d.pincode || '', d.phone || '', d.email || '',
             d.gstin || '', d.pan || '', d.cin || '', d.booksFrom || '',
             d.fyStart || '', d.fyEnd || '', d.currency || '', conn.orgId],
          );

          /*
           * Work out which shop this file belongs to, now the GSTIN and the
           * financial year are known.
           *
           * Here rather than when the company row is first created: at that
           * point all Munim has is a GUID and a name, and the GSTIN is the only
           * evidence strong enough to group two files with confidence. The
           * profile arrives on the first sync, so a new year's file is grouped
           * within moments of appearing.
           *
           * Noted for after the transaction: grouping reads other companies'
           * rows, and doing that inside this write would hold locks across a
           * batch that is already the hottest path in the product.
           */
          regroup.add(cid);

        } else if (rec.kind === 'ledger') {
          await c.query(
            `INSERT INTO ledgers (company_id, guid, name, parent_group, opening_paise,
                                  closing_paise, phone, email, gstin, credit_days, alter_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (company_id, guid) DO UPDATE SET
               name = EXCLUDED.name, parent_group = EXCLUDED.parent_group,
               opening_paise = EXCLUDED.opening_paise, closing_paise = EXCLUDED.closing_paise,
               phone = EXCLUDED.phone, email = EXCLUDED.email, gstin = EXCLUDED.gstin,
               credit_days = EXCLUDED.credit_days, alter_id = EXCLUDED.alter_id,
               updated_at = now()
             -- Never let an older version overwrite a newer one.
             --
             -- ALTERID only ever counts upward for a given record, so it is a
             -- version number. Without this guard the offline outbox can
             -- corrupt data by design: a batch queued on Monday and replayed
             -- after Tuesday's live batch would overwrite Tuesday's voucher
             -- with Monday's. Records that predate ALTERID report 0, and
             -- 0 >= 0 still updates, so nothing is lost.
             WHERE EXCLUDED.alter_id >= ledgers.alter_id`,
            [cid, rec.guid, d.name || '', d.parentGroup || '', d.openingPaise || 0,
             d.closingPaise || 0, d.phone || '', d.email || '', d.gstin || '',
             d.creditDays || 0, alterId],
          );
          maxMaster = Math.max(maxMaster, alterId);

        } else if (rec.kind === 'ledgerDetail') {
          /*
           * Enrichment only, matched on GUID.
           *
           * An UPDATE rather than an upsert: this arrives from a separate
           * best-effort request, and a detail row for a ledger the core sync
           * has not sent yet must not conjure a half-built party with a GSTIN
           * and no balance. It will be enriched on the next pass.
           *
           * COALESCE(NULLIF(...)) throughout, so a Tally version that omits a
           * field cannot blank one already known.
           */
          await c.query(
            `UPDATE ledgers SET
               gstin          = COALESCE(NULLIF($3,''),  gstin),
               gst_reg_type   = COALESCE(NULLIF($4,''),  gst_reg_type),
               pan            = COALESCE(NULLIF($5,''),  pan),
               contact_person = COALESCE(NULLIF($6,''),  contact_person),
               address        = COALESCE(NULLIF($7,''),  address),
               state          = COALESCE(NULLIF($8,''),  state),
               country        = COALESCE(NULLIF($9,''),  country),
               pincode        = COALESCE(NULLIF($10,''), pincode),
               credit_limit_paise = CASE WHEN $11::bigint <> 0
                                         THEN $11::bigint ELSE credit_limit_paise END,
               bank_name      = COALESCE(NULLIF($12,''), bank_name),
               bank_account   = COALESCE(NULLIF($13,''), bank_account),
               bank_ifsc      = COALESCE(NULLIF($14,''), bank_ifsc),
               bank_holder    = COALESCE(NULLIF($15,''), bank_holder),
               updated_at     = now()
             WHERE company_id = $1 AND guid = $2`,
            [cid, rec.guid, d.gstin || '', d.gstRegType || '', d.pan || '',
             d.contactPerson || '', d.address || '', d.state || '', d.country || '',
             d.pincode || '', d.creditLimitPaise || 0, d.bankName || '',
             d.bankAccount || '', d.bankIfsc || '', d.bankHolder || '']);

        } else if (rec.kind === 'stockDetail') {
          await c.query(
            `UPDATE stock_items SET
               parent_group   = COALESCE(NULLIF($3,''), parent_group),
               category       = COALESCE(NULLIF($4,''), category),
               alt_unit       = COALESCE(NULLIF($5,''), alt_unit),
               hsn            = COALESCE(NULLIF($6,''), hsn),
               gst_rate_bp    = CASE WHEN $7::int <> 0 THEN $7::int ELSE gst_rate_bp END,
               opening_qty    = CASE WHEN $8::float8 <> 0 THEN $8::float8 ELSE opening_qty END,
               opening_value_paise = CASE WHEN $9::bigint <> 0
                                          THEN $9::bigint ELSE opening_value_paise END,
               min_level      = CASE WHEN $10::float8 <> 0 THEN $10::float8 ELSE min_level END,
               max_level      = CASE WHEN $11::float8 <> 0 THEN $11::float8 ELSE max_level END,
               reorder_level  = CASE WHEN $12::float8 <> 0 THEN $12::float8 ELSE reorder_level END
             WHERE company_id = $1 AND guid = $2`,
            [cid, rec.guid, d.parentGroup || '', d.category || '', d.altUnit || '',
             d.hsn || '', d.gstRateBp || 0, d.openingQty || 0, d.openingValuePaise || 0,
             d.minLevel || 0, d.maxLevel || 0, d.reorderLevel || 0]);

        } else if (rec.kind === 'stockItem') {
          await c.query(
            `INSERT INTO stock_items (company_id, guid, name, unit, closing_qty,
                                      closing_value_paise, alter_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (company_id, guid) DO UPDATE SET
               name = EXCLUDED.name, unit = EXCLUDED.unit,
               closing_qty = EXCLUDED.closing_qty,
               closing_value_paise = EXCLUDED.closing_value_paise,
               alter_id = EXCLUDED.alter_id
             -- Never let an older version overwrite a newer one.
             --
             -- ALTERID only ever counts upward for a given record, so it is a
             -- version number. Without this guard the offline outbox can
             -- corrupt data by design: a batch queued on Monday and replayed
             -- after Tuesday's live batch would overwrite Tuesday's voucher
             -- with Monday's. Records that predate ALTERID report 0, and
             -- 0 >= 0 still updates, so nothing is lost.
             WHERE EXCLUDED.alter_id >= stock_items.alter_id`,
            [cid, rec.guid, d.name || '', d.unit || '', d.closingQty || 0,
             d.closingValuePaise || 0, alterId],
          );
          maxMaster = Math.max(maxMaster, alterId);

        } else if (rec.kind === 'voucher') {
          const { rows } = await c.query(
            /*
             * `prior` is what Munim held before this record arrived.
             *
             * It costs nothing worth measuring: the lookup uses the same
             * (company_id, guid) unique index that ON CONFLICT is already
             * consulting, and it rides along in the same round trip. Without it
             * there is no way to tell a new voucher from an edited one, and no
             * way to say what the edit changed.
             */
            `WITH prior AS (
               SELECT vch_no, vch_type, vch_date, party, amount_paise, is_cancelled
                 FROM vouchers WHERE company_id = $1 AND guid = $2
             ), upserted AS (
            INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party,
                                   amount_paise, narration, is_cancelled, is_optional,
                                   alter_id, raw)
             VALUES ($1,$2,$3,$4,NULLIF($5,'')::date,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (company_id, guid) DO UPDATE SET
               vch_no = EXCLUDED.vch_no, vch_type = EXCLUDED.vch_type,
               vch_date = EXCLUDED.vch_date, party = EXCLUDED.party,
               amount_paise = EXCLUDED.amount_paise, narration = EXCLUDED.narration,
               is_cancelled = EXCLUDED.is_cancelled, is_optional = EXCLUDED.is_optional,
               alter_id = EXCLUDED.alter_id, raw = EXCLUDED.raw, synced_at = now()
             -- Never let an older version overwrite a newer one.
             --
             -- ALTERID only ever counts upward for a given record, so it is a
             -- version number. Without this guard the offline outbox can
             -- corrupt data by design: a batch queued on Monday and replayed
             -- after Tuesday's live batch would overwrite Tuesday's voucher
             -- with Monday's. Records that predate ALTERID report 0, and
             -- 0 >= 0 still updates, so nothing is lost.
             WHERE EXCLUDED.alter_id >= vouchers.alter_id
             RETURNING id
             )
             SELECT upserted.id,
                    prior.vch_no        AS prior_vch_no,
                    prior.vch_type      AS prior_vch_type,
                    prior.vch_date      AS prior_vch_date,
                    prior.party         AS prior_party,
                    prior.amount_paise  AS prior_amount_paise,
                    prior.is_cancelled  AS prior_is_cancelled,
                    (SELECT count(*) FROM prior) > 0 AS existed
               FROM upserted LEFT JOIN prior ON true`,
            [cid, rec.guid, d.vchNo || '', d.vchType || '', d.date || '', d.party || '',
             d.amountPaise || 0, d.narration || '', !!d.isCancelled, !!d.isOptional,
             alterId, JSON.stringify(d)],
          );
          /*
           * No row means the guard above rejected this as stale, and the
           * children are stale with it. Skipping is the whole point: deleting
           * and reinserting them would put Monday's lines under Tuesday's
           * voucher, which is worse than either version alone.
           */
          if (!rows.length) { stale++; continue; }
          const vid = rows[0].id;
          noteTallyChange(trail, cid, rec.guid, rows[0], d);

          // Children are replaced wholesale: an edited voucher in Tally can drop
          // a line, and merging would leave the removed row behind forever.
          await c.query('DELETE FROM voucher_entries WHERE voucher_id = $1', [vid]);
          await c.query('DELETE FROM voucher_items   WHERE voucher_id = $1', [vid]);
          await c.query('DELETE FROM bills           WHERE voucher_id = $1', [vid]);

          for (const e of d.entries || []) {
            await c.query(
              'INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise) VALUES ($1,$2,$3)',
              [vid, e.ledger || '', e.amountPaise || 0]);
          }
          for (const it of d.items || []) {
            if (!it.item) continue;
            await c.query(
              `INSERT INTO voucher_items (voucher_id, item_name, qty, rate_paise, amount_paise)
               VALUES ($1,$2,$3,$4,$5)`,
              [vid, it.item, it.qty || 0, it.ratePaise || 0, it.amountPaise || 0]);
          }
          for (const b of d.bills || []) {
            if (!b.ref) continue;
            await c.query(
              `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date,
                                  due_date, amount_paise, bill_type)
               VALUES ($1,$2,$3,$4,NULLIF($5,'')::date,NULLIF($6,'')::date,$7,$8)
               ON CONFLICT (voucher_id, ref) DO UPDATE SET
                 amount_paise = EXCLUDED.amount_paise, bill_type = EXCLUDED.bill_type`,
              // Signed, not absolute: a receipt's "Agst Ref" must subtract.
              [cid, vid, b.ref, d.party || '', d.date || '', b.dueDate || '',
               b.amountPaise || 0, b.billType || '']);
          }
          if (!d.isCancelled && !d.isOptional) {
            arrivals.push({
              companyId: cid,
              type: d.vchType || '',
              no: d.vchNo || '',
              party: d.party || '',
              amountPaise: Math.abs(Number(d.amountPaise) || 0),
              voucherId: vid,
            });
          }
          maxVoucher = Math.max(maxVoucher, alterId);

        } else {
          rejected++;
          continue;
        }
        accepted++;
      } catch (e) {
        // One bad record must not fail the batch - report it and carry on.
        rejected++;
        if (errors.length < 20) errors.push({ guid: rec.guid, message: e.message });
      }
    }

    for (const cid of touched) {
      await c.query(
        `INSERT INTO sync_cursors (company_id, master_alter_id, voucher_alter_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (company_id) DO UPDATE SET
           master_alter_id  = GREATEST(sync_cursors.master_alter_id,  EXCLUDED.master_alter_id),
           voucher_alter_id = GREATEST(sync_cursors.voucher_alter_id, EXCLUDED.voucher_alter_id),
           updated_at = now()`,
        [cid, maxMaster, maxVoucher]);
      await c.query('UPDATE companies SET last_sync_at = now() WHERE id = $1', [cid]);
    }

    return { accepted, rejected, stale, arrivals, trail, regroup: [...regroup],
             cursors: { master: maxMaster, voucher: maxVoucher }, errors };
  });

  /*
   * Group the year's file into its business, after the batch has committed.
   *
   * Never allowed to fail the sync: a file that is not yet grouped still syncs
   * perfectly and simply counts as its own business, which is the same as the
   * behaviour before this existed.
   */
  for (const companyId of result.regroup ?? []) {
    try {
      await businesses.assign(companyId);
    } catch (e) {
      console.warn('  could not group company into a business:', e.message);
    }
  }
  delete result.regroup;

  await announce(conn.orgId, result.arrivals ?? []);
  await trailAfterSync(conn, result.trail ?? []);
  delete result.trail;
  // Not part of the response: the connector has no use for it, and a batch
  // report that grows with every notification is a batch report nobody reads.
  delete result.arrivals;

  if (key) {
    await query(
      `INSERT INTO ingest_keys (connector_id, key, response) VALUES ($1,$2,$3)
       ON CONFLICT (connector_id, key) DO NOTHING`,
      [conn.id, key, JSON.stringify(result)],
    );
  }
  return result;
}

/**
 * Turn what arrived into notifications.
 *
 * One per voucher would flood a shop that syncs a hundred at a time, so the
 * first few are named individually and the rest are summarised - which is how
 * a person would tell you about them.
 */
/*
 * How far back an entry has to be dated before it is worth a line in the audit
 * log. A week of catch-up is ordinary bookkeeping in a small shop; a voucher
 * dated three months ago and entered today is not.
 */
const BACKDATE_DAYS = 30;

/*
 * The most entries one batch may add.
 *
 * A first sync, a re-link, or a restore replays the whole book, and every
 * voucher in it can look like a change. A flooded audit log is a useless one,
 * so a batch that looks like a bulk replay contributes nothing rather than
 * ten thousand lines nobody will read.
 */
const MAX_TRAIL_PER_BATCH = 25;

/** Decide whether this incoming voucher is worth recording, and as what. */
function noteTallyChange(trail, companyId, guid, row, d) {
  const name = `${d.vchType || 'Voucher'} #${d.vchNo || '?'}`;
  const amount = Math.abs(Number(d.amountPaise) || 0);

  if (!row.existed) {
    /*
     * A brand new voucher is NOT recorded just for existing - it is already on
     * screen as itself, and logging every one would bury the entries that
     * matter. The exception is a materially back-dated entry, which is the one
     * kind of creation somebody would want to be told about.
     */
    const date = d.date ? new Date(d.date) : null;
    if (!date || Number.isNaN(date.getTime())) return;
    const days = Math.floor((Date.now() - date.getTime()) / 86400000);
    if (days < BACKDATE_DAYS) return;
    trail.push({ action: 'voucher.backdated', companyId, guid, name,
                 after: { date: d.date, amountPaise: amount, party: d.party || '' },
                 meta: { daysBack: days } });
    return;
  }

  const before = {
    number: row.prior_vch_no || '',
    type: row.prior_vch_type || '',
    date: dateOnly(row.prior_vch_date),
    party: row.prior_party || '',
    amountPaise: Math.abs(Number(row.prior_amount_paise) || 0),
    cancelled: !!row.prior_is_cancelled,
  };
  const after = {
    number: d.vchNo || '',
    type: d.vchType || '',
    date: dateOnly(d.date),
    party: d.party || '',
    amountPaise: amount,
    cancelled: !!d.isCancelled,
  };

  // Tally bumps ALTERID for changes Munim does not store, so a re-sent record
  // is usually identical. Only a real difference is worth a line.
  const changed = Object.keys(after).some((k) => before[k] !== after[k]);
  if (!changed) return;

  trail.push({ action: 'voucher.changed', companyId, guid, name: `${before.type || 'Voucher'} #${before.number || '?'}`,
               before, after, meta: {} });
}

/**
 * Write the trail once the batch has committed.
 *
 * There is no user session here - a connector, not a person, sent this - so the
 * entry is attributed to Tally itself rather than to whoever happens to own the
 * account. Saying "Tally" is the truthful answer, and pinning a change somebody
 * did not make onto their name would be worse than saying nothing.
 */
async function trailAfterSync(conn, trail) {
  if (!trail.length) return;
  if (trail.length > MAX_TRAIL_PER_BATCH) {
    console.log(`  sync trail: ${trail.length} changes in one batch looks like a `
              + 'bulk replay - not recorded');
    return;
  }
  const ctx = { session: { org: { id: conn.orgId },
                           user: { id: null, name: 'Tally', email: '' } } };
  for (const t of trail) {
    /*
     * Sent to whoever asked to be told. Fire and forget by design: emit() never
     * throws, because a webhook is a notification ABOUT something that already
     * happened and failing to deliver it must not undo the thing it describes.
     */
    webhooks.emit(conn.orgId, t.action === 'voucher.changed' ? 'voucher.changed'
                            : t.action === 'voucher.deleted' ? 'voucher.deleted'
                            : 'voucher.created', {
      voucher: t.guid, name: t.name, before: t.before ?? null, after: t.after ?? null,
    });

    await audit.record(ctx, t.action, {
      companyId: t.companyId,
      entityId: t.guid,
      entityName: t.name,
      before: t.before ?? null,
      after: t.after ?? null,
      meta: { ...t.meta, via: 'connector', connectorId: conn.id },
    });
  }
}

async function announce(orgId, arrivals) {
  if (!arrivals.length) return;

  const rupees = (p) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

  const groups = [
    { event: 'sale.new', match: (a) => VT.isSale(a.type), what: 'sale' },
    { event: 'purchase.new', match: (a) => VT.isPurchase(a.type), what: 'purchase' },
    { event: 'payment.received', match: (a) => VT.isReceipt(a.type), what: 'receipt' },
  ];

  for (const g of groups) {
    const hits = arrivals.filter(g.match);
    if (!hits.length) continue;

    // Named individually while there are few enough to read.
    for (const a of hits.slice(0, 3)) {
      await events.raise(orgId, g.event, {
        companyId: a.companyId,
        title: `${a.type} ${a.no}`.trim(),
        body: [a.party, rupees(a.amountPaise)].filter(Boolean).join(' · '),
        amountPaise: a.amountPaise,
        link: { screen: 'voucher', id: a.voucherId },
        // The voucher itself, so a re-sync of the same record says nothing new.
        dedupeKey: a.voucherId,
      });
    }

    if (hits.length > 3) {
      const total = hits.reduce((n, a) => n + a.amountPaise, 0);
      await events.raise(orgId, g.event, {
        companyId: hits[0].companyId,
        title: `${hits.length} new ${g.what}s`,
        body: `${rupees(total)} in total`,
        amountPaise: total,
        link: { screen: 'txn', section: g.what === 'purchase' ? 'purchase' : 'sales' },
        // One summary per batch, keyed on the batch itself.
        dedupeKey: `batch-${hits[0].voucherId}`,
      });
    }
  }
}

// Exposed for tests: the judgement about what is worth recording is the
// interesting part of this file, and it is worth pinning down directly.
module.exports = {
  __test: { noteTallyChange }, ingest };
