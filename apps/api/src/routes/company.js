'use strict';
const { query } = require('../db');
const audit = require('../lib/audit');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const VT = require('../lib/vouchertypes');
const { HttpError } = require('../lib/http');
const doc = require('../lib/doctemplate');
const { companyFor } = require('./reports');

/**
 * The company as an entity in its own right, rather than a name attached to
 * some figures.
 *
 * Everything a customer sends outward - an invoice, a statement, a reminder -
 * has to be headed with who they are. That letterhead lives here, alongside
 * the health signals (is it syncing, how big is it, when did we last hear from
 * it) that decide whether the figures below can be trusted at all.
 */

/**
 * Whether this book can be believed right now.
 *
 * Three states rather than a boolean: a book that has never synced is a setup
 * problem, one that has gone quiet is an operational problem, and they need
 * different words in front of the customer. "Stale" is deliberately generous -
 * a shop closes overnight and on Sundays, and calling that a fault would train
 * people to ignore the warning.
 */
function health(row) {
  if (!row.enabled) {
    return { state: 'paused', label: 'Sync paused',
             hint: 'Turn sync on to start updating this book again.' };
  }
  if (!row.last_sync_at) {
    return { state: 'never', label: 'Never synced',
             hint: 'Open this company in Tally and leave the connector running.' };
  }
  const hours = (Date.now() - new Date(row.last_sync_at).getTime()) / 3_600_000;
  if (hours > 48) {
    return { state: 'stale', label: 'Not syncing',
             hint: 'Tally or the connector has been off for more than two days.' };
  }
  if (hours > 6) {
    return { state: 'quiet', label: 'Quiet',
             hint: 'Nothing new since the last few hours. Normal outside shop hours.' };
  }
  return { state: 'live', label: 'Live', hint: 'Up to date with Tally.' };
}

/**
 * Dates out of Tally arrive as YYYYMMDD; the connector now converts them, but
 * rows written before it did are still in the raw form. Normalising on read
 * means the UI never has to know which era a row came from, and no backfill
 * migration is needed.
 */
const isoDate = (v) => {
  const t = String(v || '').trim();
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
};

/** The settings Munim owns, as opposed to the ones Tally dictates. */
const settingsOf = (r) => ({
  logoDataUri: r.logo_data_uri || '',
  numberFormat: r.number_format || 'indian',
  decimals: r.decimals ?? 0,
  dateFormat: r.date_format || 'dd-mm-yyyy',
});

/** The profile fields, shaped for a letterhead. */
const profileOf = (r) => ({
  name: r.name,
  formalName: r.formal_name || r.name,
  address: r.address,
  state: r.state,
  country: r.country,
  pincode: r.pincode,
  phone: r.phone,
  email: r.email,
  gstin: r.gstin,
  pan: r.pan,
  cin: r.cin,
  currency: r.currency || '₹',
  booksFrom: isoDate(r.books_from),
  fyStart: isoDate(r.fy_start),
  fyEnd: isoDate(r.fy_end),
  profileAt: r.profile_at,
});

/**
 * How complete the profile is, and what is missing.
 *
 * Returned rather than left to the UI because the answer is the same
 * everywhere and the consequence is concrete: an invoice without a GSTIN is
 * not a tax invoice. Naming the missing field is what makes this actionable -
 * "80% complete" tells nobody what to type into Tally.
 */
const REQUIRED = [
  { key: 'address', label: 'Address', why: 'Printed at the top of every invoice.' },
  { key: 'gstin', label: 'GSTIN', why: 'Without it an invoice is not a tax invoice.' },
  { key: 'state', label: 'State', why: 'Decides CGST/SGST against IGST.' },
  { key: 'phone', label: 'Phone', why: 'So customers can reach you from a bill.' },
  { key: 'email', label: 'Email', why: 'Needed to send statements by mail.' },
  { key: 'pan', label: 'PAN', why: 'Asked for on most B2B paperwork.' },
];

function completeness(profile) {
  const missing = REQUIRED.filter((f) => !String(profile[f.key] || '').trim());
  return {
    // Rounded down: 99% when a required field is missing reads as "fine".
    percent: Math.floor(((REQUIRED.length - missing.length) / REQUIRED.length) * 100),
    missing,
    // Everything here comes from Tally, so the fix is always in Tally.
    fixHint: 'These come from Tally. Set them in Gateway of Tally → F11 → Company Features, '
           + 'or Alter Company, and Munim picks them up on the next sync.',
  };
}

/** Every book in the account, with enough to choose between them. */
async function list(ctx) {
  const s = auth.requireUser(ctx);
  const { rows } = await query(
    `SELECT c.*,
            (SELECT count(*)::int FROM ledgers     l WHERE l.company_id = c.id) AS ledgers,
            (SELECT count(*)::int FROM vouchers    v WHERE v.company_id = c.id) AS vouchers,
            (SELECT count(*)::int FROM stock_items i WHERE i.company_id = c.id) AS items,
            (SELECT count(*)::int FROM ledgers l
              WHERE l.company_id = c.id AND lower(l.parent_group) = 'sundry debtors') AS customers
       FROM companies c WHERE c.org_id = $1 ORDER BY c.name`,
    [s.org.id]);

  return {
    companies: rows.map((r) => {
      const profile = profileOf(r);
      return {
        tallyGuid: r.tally_guid,
        enabled: r.enabled,
        lastSyncAt: r.last_sync_at,
        discoveredAt: r.discovered_at,
        health: health(r),
        profile,
        settings: settingsOf(r),
        completeness: completeness(profile),
        counts: {
          ledgers: r.ledgers, vouchers: r.vouchers,
          items: r.items, customers: r.customers,
        },
      };
    }),
  };
}

/** One book, in full. */
async function detail(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const { rows } = await query(
    `SELECT c.*,
            (SELECT count(*)::int FROM ledgers     l WHERE l.company_id = c.id) AS ledgers,
            (SELECT count(*)::int FROM vouchers    v WHERE v.company_id = c.id) AS vouchers,
            (SELECT count(*)::int FROM stock_items i WHERE i.company_id = c.id) AS items,
            (SELECT count(*)::int FROM groups      g WHERE g.company_id = c.id) AS groups,
            (SELECT count(*)::int FROM bills       b WHERE b.company_id = c.id) AS bills,
            (SELECT count(*)::int FROM ledgers l
              WHERE l.company_id = c.id AND lower(l.parent_group) = 'sundry debtors') AS customers,
            (SELECT count(*)::int FROM ledgers l
              WHERE l.company_id = c.id AND lower(l.parent_group) = 'sundry creditors') AS suppliers,
            (SELECT min(vch_date) FROM vouchers v WHERE v.company_id = c.id) AS first_vch,
            (SELECT max(vch_date) FROM vouchers v WHERE v.company_id = c.id) AS last_vch
       FROM companies c WHERE c.id = $1`,
    [co.id]);

  const r = rows[0];
  const profile = profileOf(r);
  return {
    tallyGuid: r.tally_guid,
    enabled: r.enabled,
    lastSyncAt: r.last_sync_at,
    discoveredAt: r.discovered_at,
    health: health(r),
    profile,
    settings: settingsOf(r),
    completeness: completeness(profile),
    counts: {
      ledgers: r.ledgers, vouchers: r.vouchers, items: r.items,
      groups: r.groups, bills: r.bills,
      customers: r.customers, suppliers: r.suppliers,
    },
    // The span the books actually cover, which is not the same as the
    // financial year: a book can be opened in April and first written to in
    // July, and a report defaulting to the FY would open on an empty screen.
    span: { firstVoucher: r.first_vch, lastVoucher: r.last_vch },
  };
}

/*
 * Roughly 512 KB of base64, which is about 380 KB of image.
 *
 * Generous for a logo and small enough that it never slows a page down. The
 * limit is enforced here rather than by a database constraint so the customer
 * gets a sentence telling them to use a smaller picture, instead of a
 * constraint violation.
 */
const LOGO_MAX = 512 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/** Change how this company's figures and documents look. */
async function updateSettings(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const b = ctx.body || {};
  const sets = [];
  const args = [co.id];

  if (b.logoDataUri !== undefined) {
    const uri = String(b.logoDataUri || '');
    if (uri) {
      if (uri.length > LOGO_MAX) {
        throw new HttpError(413, 'LOGO_TOO_BIG',
          'That picture is too large. Please use one under about 380 KB.');
      }
      const m = /^data:([a-z/+-]+);base64,/i.exec(uri);
      // Only real images, and only ones a PDF renderer can embed. An SVG is
      // an image that can carry script, so it is not on the list.
      if (!m || !LOGO_TYPES.includes(m[1].toLowerCase())) {
        throw new HttpError(400, 'BAD_LOGO', 'Please upload a PNG, JPG or WebP image.');
      }
    }
    sets.push(`logo_data_uri = $${args.push(uri)}`);
  }

  if (b.numberFormat !== undefined) {
    if (!['indian', 'international'].includes(b.numberFormat)) {
      throw new HttpError(400, 'BAD_FORMAT', 'Number format must be indian or international.');
    }
    sets.push(`number_format = $${args.push(b.numberFormat)}`);
  }

  if (b.decimals !== undefined) {
    const d = Number(b.decimals);
    if (!Number.isInteger(d) || d < 0 || d > 4) {
      throw new HttpError(400, 'BAD_DECIMALS', 'Decimals must be a whole number from 0 to 4.');
    }
    sets.push(`decimals = $${args.push(d)}`);
  }

  if (b.dateFormat !== undefined) {
    if (!['dd-mm-yyyy', 'mm-dd-yyyy', 'yyyy-mm-dd'].includes(b.dateFormat)) {
      throw new HttpError(400, 'BAD_DATE_FORMAT', 'That date format is not one we support.');
    }
    sets.push(`date_format = $${args.push(b.dateFormat)}`);
  }

  if (!sets.length) throw new HttpError(400, 'NOTHING_TO_DO', 'No settings were given.');

  const { rows: was } = await query('SELECT * FROM companies WHERE id = $1', [co.id]);
  const { rows } = await query(
    `UPDATE companies SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, args);

  await audit.record(ctx, 'company.settings', {
    companyId: co.id, entityId: co.tally_guid, entityName: rows[0].name,
    before: settingsOf(was[0]), after: settingsOf(rows[0]),
  });
  return { settings: settingsOf(rows[0]) };
}

/**
 * Remove a book from Munim.
 *
 * This deletes Munim's copy and nothing else - the Tally company on the
 * customer's own computer is untouched, because Munim never writes to Tally.
 * Worth being exact about: "delete company" is the most alarming button in the
 * product, and a shop owner reading it will assume the worst.
 *
 * The connector will rediscover the company on its next pass and start
 * downloading it again, so this is a way to reclaim space or to force a clean
 * re-sync, not a way to hide a company for good. Pausing sync is that.
 */
async function remove(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);

  // ON DELETE CASCADE is not relied on: it may or may not be declared on every
  // child table, and a partial delete would leave vouchers pointing at a
  // company that no longer exists.
  const { rows } = await query(
    `WITH v AS (DELETE FROM vouchers    WHERE company_id = $1 RETURNING 1),
          l AS (DELETE FROM ledgers     WHERE company_id = $1 RETURNING 1),
          i AS (DELETE FROM stock_items WHERE company_id = $1 RETURNING 1),
          g AS (DELETE FROM groups      WHERE company_id = $1 RETURNING 1),
          b AS (DELETE FROM bills       WHERE company_id = $1 RETURNING 1),
          c AS (DELETE FROM companies   WHERE id = $1 RETURNING 1)
     SELECT (SELECT count(*) FROM v)::int AS vouchers,
            (SELECT count(*) FROM l)::int AS ledgers,
            (SELECT count(*) FROM i)::int AS items,
            (SELECT count(*) FROM b)::int AS bills,
            (SELECT count(*) FROM c)::int AS companies`,
    [co.id]);

  await audit.record(ctx, 'company.remove', {
    entityId: tallyGuid, entityName: co.name, meta: rows[0],
  });

  return {
    removed: rows[0],
    // Said plainly, because this is the sentence that stops a support call.
    note: 'Removed from Munim only. Your Tally company on your own computer is untouched. '
        + 'The connector will find it again on its next sync unless you pause it.',
  };
}

/**
 * The company at a glance: the twelve figures that say how the business stands.
 *
 * Deliberately one query per concern rather than one wide join. These come
 * from different places - balances from ledgers, turnover from vouchers,
 * liveness from the connector - and forcing them together would multiply rows
 * and silently inflate every total.
 */
async function summary(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);

  const [row, flow, conn] = await Promise.all([
    // Balances, classified by what each group actually is.
    query(
      `SELECT
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'sundry debtors'), 0)::bigint   AS receivables,
         COALESCE(-SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'sundry creditors'), 0)::bigint AS payables,
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'cash-in-hand'), 0)::bigint     AS cash,
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'bank accounts'), 0)::bigint    AS bank,
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'stock-in-hand'), 0)::bigint    AS stock,
         -- Duties & Taxes nets GST collected on sales against GST paid on
         -- purchases. A positive balance is money owed to the government.
         COALESCE(-SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'duties & taxes'), 0)::bigint  AS gst,
         COALESCE(-SUM(closing_paise) FILTER (WHERE account_nature(parent_group) = 'income'), 0)::bigint AS income,
         COALESCE(SUM(closing_paise) FILTER (WHERE account_nature(parent_group) = 'expense'), 0)::bigint AS expenses
       FROM ledgers WHERE company_id = $1`,
      [co.id]),

    // Turnover for the year the books are actually in.
    query(
      `SELECT
         COALESCE(SUM(abs(amount_paise)) FILTER (
           WHERE ${VT.SALES.replace(/v\./g, '')}), 0)::bigint AS sales,
         COALESCE(SUM(abs(amount_paise)) FILTER (
           WHERE ${VT.purchases('')}), 0)::bigint AS purchases
       FROM vouchers
        WHERE company_id = $1 AND NOT is_cancelled AND NOT is_optional`,
      [co.id]),

    // Is the machine that feeds this company actually switched on? Distinct
    // from whether the book synced recently: a connector that is up but has
    // sent nothing means Tally is closed, which is a different fix.
    query(
      `SELECT machine_name, tally_up, status, last_seen_at, last_error, queued_batches
         FROM connectors
        WHERE org_id = $1 AND revoked_at IS NULL
        ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
      [s.org.id]),
  ]);

  const r = row.rows[0];
  const f = flow.rows[0];
  const c = conn.rows[0];

  const seenMins = c?.last_seen_at
    ? (Date.now() - new Date(c.last_seen_at).getTime()) / 60_000 : null;
  // Five minutes: the connector beats far more often than that, so anything
  // longer means it has genuinely stopped rather than just been slow.
  const online = seenMins != null && seenMins < 5;

  const profile = profileOf(await query('SELECT * FROM companies WHERE id = $1', [co.id])
    .then((x) => x.rows[0]));

  return {
    company: { tallyGuid: co.tally_guid, name: co.name },
    financialYear: {
      from: profile.fyStart, to: profile.fyEnd, booksFrom: profile.booksFrom,
    },
    metrics: {
      sales: Number(f.sales),
      purchases: Number(f.purchases),
      receivables: Number(r.receivables),
      payables: Number(r.payables),
      cash: Number(r.cash),
      bank: Number(r.bank),
      stock: Number(r.stock),
      expenses: Number(r.expenses),
      gst: Number(r.gst),
      // Income less expenses, from the ledger balances rather than from
      // turnover: turnover ignores every cost, and a "profit" that does the
      // same is worse than no figure at all.
      profit: Number(r.income) - Number(r.expenses),
    },
    syncStatus: {
      ...health(await query('SELECT enabled, last_sync_at FROM companies WHERE id = $1', [co.id])
        .then((x) => x.rows[0])),
      lastSyncAt: co.last_sync_at,
    },
    connection: c ? {
      online,
      machineName: c.machine_name,
      tallyUp: c.tally_up,
      lastSeenAt: c.last_seen_at,
      queuedBatches: c.queued_batches,
      lastError: c.last_error || '',
      label: !online ? 'Connector offline'
        : !c.tally_up ? 'Tally not running'
        : c.queued_batches > 0 ? 'Catching up'
        : 'Connected',
      hint: !online
        ? 'The computer running Tally is off, asleep, or has no internet.'
        : !c.tally_up
          ? 'The connector is running but Tally is closed. Open Tally and your company.'
          : c.queued_batches > 0
            ? `${c.queued_batches} batch(es) still to send. Nothing is lost.`
            : 'Munim is talking to your Tally right now.',
    } : {
      online: false, machineName: '', tallyUp: false, lastSeenAt: null,
      queuedBatches: 0, lastError: '',
      label: 'Not connected',
      hint: 'No computer is linked yet. Install the connector on the PC that runs Tally.',
    },
  };
}

/** How this company's documents are laid out, and what can be changed. */
async function docTemplate(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');
  const co = await companyFor(s, tallyGuid);
  const { rows } = await query('SELECT * FROM companies WHERE id = $1', [co.id]);

  return {
    template: doc.templateOf(rows[0]),
    // The catalogue travels with the value so a screen can render the whole
    // form without a second list to keep in step.
    blocks: doc.BLOCKS,
    pages: doc.PAGES,
    note: 'These apply to every invoice and document this company prints.',
  };
}

async function updateDocTemplate(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');
  const co = await companyFor(s, tallyGuid);

  const fields = doc.validate(ctx.body || {});
  const keys = Object.keys(fields);
  if (!keys.length) throw new HttpError(400, 'NOTHING_TO_DO', 'No settings were given.');

  const args = [co.id];
  const sets = keys.map((k) => `${k} = $${args.push(fields[k])}`
    + (k === 'doc_show' ? '::jsonb' : ''));

  const { rows: was } = await query('SELECT * FROM companies WHERE id = $1', [co.id]);
  const { rows } = await query(
    `UPDATE companies SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, args);

  await audit.record(ctx, 'company.template', {
    companyId: co.id, entityId: co.tally_guid, entityName: rows[0].name,
    // The rendered template, not the raw columns: a log line saying
    // doc_page_size changed is worse than one saying the paper did.
    before: doc.templateOf(was[0]), after: doc.templateOf(rows[0]),
  });
  return { template: doc.templateOf(rows[0]) };
}

module.exports = {
  list, detail, health, completeness, profileOf, settingsOf, isoDate,
  updateSettings, remove, summary, docTemplate, updateDocTemplate,
};
