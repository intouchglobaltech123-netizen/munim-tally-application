'use strict';
const { query } = require('../db');
const apikeys = require('../lib/apikeys');
const quotas = require('../lib/quotas');
const VT = require('../lib/vouchertypes');
const { HttpError, bad } = require('../lib/http');

/**
 * The API other people build on.
 *
 * Versioned in the path from the first day. `/api/v1/` costs nothing now and is
 * the only thing that lets a breaking change ever ship: without it, the first
 * customer integration freezes the response shape permanently.
 *
 * Read-only, and that is a product decision rather than an omission. Munim
 * reads Tally and never writes to it, so a write API would be writing to a copy
 * - and the customer's accountant would then reconcile two sets of books that
 * disagree. Every route here is a GET.
 *
 * Responses are deliberately NOT the app's internal shapes. The app's shapes
 * change whenever a screen changes; these have to stay still for years, so they
 * are mapped explicitly even where that means writing out fields one by one.
 */

const VERSION = 'v1';
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/** Paging that a client can actually follow. */
function paging(url) {
  const limit = Math.min(MAX_LIMIT,
    Math.max(1, parseInt(url.searchParams.get('limit'), 10) || DEFAULT_LIMIT));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0);
  return { limit, offset };
}

const envelope = (items, { limit, offset }, total) => ({
  data: items,
  paging: {
    limit,
    offset,
    total,
    /*
     * The next offset rather than a cursor: this API sorts by date and id over
     * data that only ever grows at the end, so offset paging is stable enough
     * and is far easier for somebody writing their first integration.
     */
    next: offset + items.length < total ? offset + limit : null,
  },
});

/**
 * Resolve which company a call is about.
 *
 * A key can be tied to one book, in which case the caller does not get to
 * choose - passing a different company must fail rather than being ignored,
 * because silently answering about the wrong books is the worst outcome here.
 */
async function companyFor(apiKey, url) {
  const guid = url.searchParams.get('company');

  if (apiKey.companyId) {
    if (guid) {
      const { rows } = await query(
        'SELECT tally_guid FROM companies WHERE id = $1', [apiKey.companyId]);
      if (rows[0]?.tally_guid !== guid) {
        throw new HttpError(403, 'WRONG_COMPANY',
          'This key is tied to one company and that is not it.');
      }
    }
    return apiKey.companyId;
  }

  if (guid) {
    const { rows } = await query(
      'SELECT id FROM companies WHERE org_id = $1 AND tally_guid = $2',
      [apiKey.orgId, guid]);
    if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such company.');
    return rows[0].id;
  }

  const { rows } = await query(
    'SELECT id FROM companies WHERE org_id = $1 ORDER BY name LIMIT 2', [apiKey.orgId]);
  if (!rows.length) throw new HttpError(404, 'NO_COMPANY', 'This account has no companies yet.');
  if (rows.length > 1) {
    // Guessing would answer about the wrong books roughly half the time.
    throw bad('COMPANY_REQUIRED',
      'This account has more than one company. Pass ?company=<tallyGuid>.');
  }
  return rows[0].id;
}

// --- the routes -------------------------------------------------------------

/** What this key can see. The first call anybody makes. */
async function whoami(ctx) {
  const k = ctx.apiKey;
  const { rows } = await query(
    `SELECT tally_guid, name, gstin, last_sync_at FROM companies
      WHERE org_id = $1 ${k.companyId ? 'AND id = $2' : ''} ORDER BY name`,
    k.companyId ? [k.orgId, k.companyId] : [k.orgId]);

  return {
    account: k.orgName,
    key: { name: k.name, scopes: k.scopes },
    companies: rows.map((c) => ({
      id: c.tally_guid, name: c.name, gstin: c.gstin || null, lastSyncAt: c.last_sync_at,
    })),
    readOnly: true,
    note: 'This API only reads. Vouchers you create inside Munim are written to '
        + 'Tally, but nothing reached through a key ever can.',
  };
}

async function companies(ctx) {
  apikeys.requireScope(ctx.apiKey, 'settings');
  const k = ctx.apiKey;
  const { rows } = await query(
    `SELECT tally_guid, name, formal_name, gstin, pan, state, pincode, address,
            phone, email, currency, fy_start, fy_end, last_sync_at
       FROM companies WHERE org_id = $1 ${k.companyId ? 'AND id = $2' : ''}
      ORDER BY name`,
    k.companyId ? [k.orgId, k.companyId] : [k.orgId]);

  return {
    data: rows.map((c) => ({
      id: c.tally_guid,
      name: c.name,
      legalName: c.formal_name || c.name,
      gstin: c.gstin || null,
      pan: c.pan || null,
      address: {
        line: c.address || null, state: c.state || null, pincode: c.pincode || null,
      },
      phone: c.phone || null,
      email: c.email || null,
      currency: c.currency || '₹',
      financialYear: { from: c.fy_start, to: c.fy_end },
      lastSyncAt: c.last_sync_at,
    })),
  };
}

/** Ledgers, and the two views of them customers ask for by name. */
const ledgers = (filter) => async (ctx) => {
  apikeys.requireScope(ctx.apiKey, 'ledgers');
  const companyId = await companyFor(ctx.apiKey, ctx.url);
  const p = paging(ctx.url);

  const where = ['l.company_id = $1'];
  const args = [companyId];

  if (filter === 'customers') where.push(`l.parent_group ILIKE '%debtor%'`);
  if (filter === 'suppliers') where.push(`l.parent_group ILIKE '%creditor%'`);

  const q = ctx.url.searchParams.get('q');
  if (q) { args.push(`%${q}%`); where.push(`l.name ILIKE $${args.length}`); }

  const { rows: count } = await query(
    `SELECT count(*)::int AS n FROM ledgers l WHERE ${where.join(' AND ')}`, args);

  const { rows } = await query(
    `SELECT l.guid, l.name, l.parent_group, l.closing_paise, l.gstin, l.phone,
            l.email, l.credit_days, l.credit_limit_paise
       FROM ledgers l WHERE ${where.join(' AND ')}
      ORDER BY l.name LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    [...args, p.limit, p.offset]);

  return envelope(rows.map((l) => ({
    id: l.guid,
    name: l.name,
    group: l.parent_group,
    // Positive is debit throughout Munim, because the connector negates Tally's
    // sign on the way in. Stated in the field name so nobody has to guess.
    closingBalancePaise: Number(l.closing_paise),
    closingBalanceIsDebit: Number(l.closing_paise) >= 0,
    gstin: l.gstin || null,
    phone: l.phone || null,
    email: l.email || null,
    creditDays: l.credit_days ?? null,
    creditLimitPaise: l.credit_limit_paise ? Number(l.credit_limit_paise) : null,
  })), p, count[0].n);
};

async function items(ctx) {
  apikeys.requireScope(ctx.apiKey, 'inventory');
  const companyId = await companyFor(ctx.apiKey, ctx.url);
  const p = paging(ctx.url);

  const { rows: count } = await query(
    'SELECT count(*)::int AS n FROM stock_items WHERE company_id = $1', [companyId]);
  const { rows } = await query(
    `SELECT guid, name, unit, closing_qty, closing_value_paise, hsn, gst_rate_bp,
            parent_group, category, reorder_level, sales_rate_paise, purchase_rate_paise
       FROM stock_items WHERE company_id = $1
      ORDER BY name LIMIT $2 OFFSET $3`, [companyId, p.limit, p.offset]);

  return envelope(rows.map((i) => ({
    id: i.guid,
    name: i.name,
    unit: i.unit || null,
    group: i.parent_group || null,
    category: i.category || null,
    quantity: Number(i.closing_qty),
    valuePaise: Number(i.closing_value_paise),
    hsn: i.hsn || null,
    // Basis points throughout, so 18% is 1800 and there is no float anywhere.
    gstRateBasisPoints: i.gst_rate_bp ?? null,
    reorderLevel: Number(i.reorder_level ?? 0),
    salesRatePaise: i.sales_rate_paise ? Number(i.sales_rate_paise) : null,
    purchaseRatePaise: i.purchase_rate_paise ? Number(i.purchase_rate_paise) : null,
  })), p, count[0].n);
}

/** Vouchers, with the sub-views the spec names as their own endpoints. */
const vouchers = (kind) => async (ctx) => {
  const scope = kind === 'invoices' ? 'sales'
    : kind === 'payments' ? 'cashbank' : 'sales';
  apikeys.requireScope(ctx.apiKey, scope);

  const companyId = await companyFor(ctx.apiKey, ctx.url);
  const p = paging(ctx.url);

  const where = ['v.company_id = $1', 'NOT v.is_optional'];
  const args = [companyId];

  if (kind === 'invoices') where.push(VT.SALES);
  if (kind === 'payments') where.push(`(${VT.RECEIPTS} OR ${VT.PAYMENTS})`);

  const type = ctx.url.searchParams.get('type');
  if (type) { args.push(type); where.push(`v.vch_type = $${args.length}`); }

  const party = ctx.url.searchParams.get('party');
  if (party) { args.push(party); where.push(`v.party = $${args.length}`); }

  const from = ctx.url.searchParams.get('from');
  if (from) { args.push(from); where.push(`v.vch_date >= $${args.length}::date`); }

  const to = ctx.url.searchParams.get('to');
  if (to) { args.push(to); where.push(`v.vch_date <= $${args.length}::date`); }

  /*
   * `since` is what makes an integration incremental rather than re-reading
   * the whole book every night. Against synced_at, not voucher date: a voucher
   * back-dated to last April arrived today, and a client watching vch_date
   * would never see it.
   */
  const since = ctx.url.searchParams.get('since');
  if (since) { args.push(since); where.push(`v.synced_at > $${args.length}::timestamptz`); }

  const { rows: count } = await query(
    `SELECT count(*)::int AS n FROM vouchers v WHERE ${where.join(' AND ')}`, args);

  const { rows } = await query(
    `SELECT v.id, v.guid, v.vch_no, v.vch_type, v.vch_date, v.party, v.amount_paise,
            v.narration, v.is_cancelled, v.synced_at
       FROM vouchers v WHERE ${where.join(' AND ')}
      ORDER BY v.vch_date DESC, v.id DESC
      LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    [...args, p.limit, p.offset]);

  return envelope(rows.map(voucherOut), p, count[0].n);
};

const voucherOut = (v) => ({
  id: v.guid,
  number: v.vch_no,
  type: v.vch_type,
  date: v.vch_date,
  party: v.party || null,
  amountPaise: Math.abs(Number(v.amount_paise)),
  narration: v.narration || null,
  cancelled: v.is_cancelled,
  syncedAt: v.synced_at,
});

/** One voucher, in full, with its lines. */
async function voucher(ctx, guid) {
  apikeys.requireScope(ctx.apiKey, 'sales');
  const companyId = await companyFor(ctx.apiKey, ctx.url);

  const { rows } = await query(
    'SELECT * FROM vouchers WHERE company_id = $1 AND guid = $2', [companyId, guid]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such voucher.');
  const v = rows[0];

  const [entries, lines, bills] = await Promise.all([
    query('SELECT ledger_name, amount_paise FROM voucher_entries WHERE voucher_id = $1',
      [v.id]),
    query(`SELECT item_name, qty, rate_paise, amount_paise
             FROM voucher_items WHERE voucher_id = $1`, [v.id]),
    query(`SELECT ref, bill_date, due_date, amount_paise, bill_type
             FROM bills WHERE voucher_id = $1`, [v.id]),
  ]);

  return {
    data: {
      ...voucherOut(v),
      entries: entries.rows.map((e) => ({
        ledger: e.ledger_name,
        amountPaise: Number(e.amount_paise),
        // Spelled out because the sign convention is the single most common
        // thing an integrator gets backwards.
        side: Number(e.amount_paise) >= 0 ? 'debit' : 'credit',
      })),
      items: lines.rows.map((i) => ({
        item: i.item_name,
        quantity: Number(i.qty),
        ratePaise: Number(i.rate_paise),
        amountPaise: Number(i.amount_paise),
      })),
      bills: bills.rows.map((b) => ({
        reference: b.ref,
        billDate: b.bill_date,
        dueDate: b.due_date,
        amountPaise: Number(b.amount_paise),
        type: b.bill_type,
      })),
    },
  };
}

/** What is owed, netted per reference. */
async function outstanding(ctx) {
  apikeys.requireScope(ctx.apiKey, 'outstanding');
  const companyId = await companyFor(ctx.apiKey, ctx.url);
  const p = paging(ctx.url);

  const { rows: count } = await query(
    'SELECT count(*)::int AS n FROM open_bills WHERE company_id = $1', [companyId]);

  const { rows } = await query(
    `SELECT ref, party, bill_date, due_date, amount_paise
       FROM open_bills WHERE company_id = $1
      ORDER BY due_date NULLS LAST, amount_paise DESC
      LIMIT $2 OFFSET $3`, [companyId, p.limit, p.offset]);

  return envelope(rows.map((b) => ({
    reference: b.ref,
    party: b.party,
    billDate: b.bill_date,
    dueDate: b.due_date,
    // Netted across every allocation for this reference. Summing the raw bills
    // table instead overstates receivables badly.
    pendingPaise: Number(b.amount_paise),
    overdue: b.due_date ? new Date(b.due_date) < new Date() : false,
    daysOverdue: b.due_date
      ? Math.max(0, Math.floor((Date.now() - new Date(b.due_date)) / 86400000)) : 0,
  })), p, count[0].n);
}

/** The headline numbers, so a caller does not have to add up vouchers. */
async function reports(ctx) {
  apikeys.requireScope(ctx.apiKey, 'reports');
  const companyId = await companyFor(ctx.apiKey, ctx.url);

  const from = ctx.url.searchParams.get('from');
  const to = ctx.url.searchParams.get('to');
  if (!from || !to) throw bad('PERIOD_REQUIRED', 'Pass ?from=YYYY-MM-DD&to=YYYY-MM-DD.');

  const { rows } = await query(`
    SELECT
      COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE ${VT.SALES}), 0)::bigint AS sales,
      COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE ${VT.PURCHASES}), 0)::bigint
        AS purchases,
      COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE ${VT.RECEIPTS}), 0)::bigint
        AS receipts,
      COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE ${VT.PAYMENTS}), 0)::bigint
        AS payments,
      count(*) FILTER (WHERE ${VT.SALES})::int AS invoices
      FROM vouchers v
     WHERE v.company_id = $1 AND v.vch_date BETWEEN $2::date AND $3::date
       AND NOT v.is_cancelled AND NOT v.is_optional`, [companyId, from, to]);

  const r = rows[0];
  return {
    data: {
      period: { from, to },
      salesPaise: Number(r.sales),
      purchasesPaise: Number(r.purchases),
      receiptsPaise: Number(r.receipts),
      paymentsPaise: Number(r.payments),
      invoices: r.invoices,
      tradingMarginPaise: Number(r.sales) - Number(r.purchases),
      // The caveat travels with the number, exactly as it does in the app.
      note: 'tradingMargin is sales less purchases in the same period. It is not '
          + 'gross profit: that needs opening and closing stock, which Munim does '
          + 'not read.',
    },
  };
}

/** Connector health, for somebody running a fleet of shops. */
async function connectors(ctx) {
  apikeys.requireScope(ctx.apiKey, 'settings');
  const { rows } = await query(
    `SELECT machine_name, status, tally_up, tally_version, app_version,
            last_seen_at, paired_at, queued_batches
       FROM connectors WHERE org_id = $1 AND revoked_at IS NULL
      ORDER BY machine_name`, [ctx.apiKey.orgId]);

  return {
    data: rows.map((c) => ({
      machine: c.machine_name,
      status: c.status,
      tallyRunning: c.tally_up,
      tallyVersion: c.tally_version,
      connectorVersion: c.app_version,
      lastSeenAt: c.last_seen_at,
      pairedAt: c.paired_at,
      queuedBatches: c.queued_batches,
      online: c.last_seen_at
        ? Date.now() - new Date(c.last_seen_at) < 10 * 60 * 1000 : false,
    })),
  };
}

/** GST summary for a period. */
async function gst(ctx) {
  apikeys.requireScope(ctx.apiKey, 'gst');
  const companyId = await companyFor(ctx.apiKey, ctx.url);
  const from = ctx.url.searchParams.get('from');
  const to = ctx.url.searchParams.get('to');
  if (!from || !to) throw bad('PERIOD_REQUIRED', 'Pass ?from=YYYY-MM-DD&to=YYYY-MM-DD.');

  const { rows } = await query(`
    SELECT l.gstin, count(DISTINCT v.id)::int AS vouchers,
           COALESCE(SUM(abs(v.amount_paise)), 0)::bigint AS amount
      FROM vouchers v
      LEFT JOIN ledgers l ON l.company_id = v.company_id AND l.name = v.party
     WHERE v.company_id = $1 AND v.vch_date BETWEEN $2::date AND $3::date
       AND NOT v.is_cancelled AND NOT v.is_optional AND ${VT.SALES}
     GROUP BY l.gstin ORDER BY amount DESC`, [companyId, from, to]);

  const registered = rows.filter((r) => r.gstin);
  const unregistered = rows.filter((r) => !r.gstin);

  return {
    data: {
      period: { from, to },
      b2b: {
        parties: registered.length,
        vouchers: registered.reduce((a, r) => a + r.vouchers, 0),
        amountPaise: registered.reduce((a, r) => a + Number(r.amount), 0),
      },
      b2c: {
        vouchers: unregistered.reduce((a, r) => a + r.vouchers, 0),
        amountPaise: unregistered.reduce((a, r) => a + Number(r.amount), 0),
      },
      note: 'Summary only. Munim does not file returns and does not issue '
          + 'E-Invoices or E-Way Bills — both need write access to Tally and a '
          + 'GSP contract.',
    },
  };
}

/**
 * The route table.
 *
 * Flat and explicit so that the whole public surface is readable in one place,
 * which is what makes it possible to notice that something was added without a
 * scope check.
 */
const ROUTES = {
  'GET /api/v1/me': whoami,
  'GET /api/v1/companies': companies,
  'GET /api/v1/ledgers': ledgers(null),
  'GET /api/v1/customers': ledgers('customers'),
  'GET /api/v1/suppliers': ledgers('suppliers'),
  'GET /api/v1/items': items,
  'GET /api/v1/vouchers': vouchers('all'),
  'GET /api/v1/invoices': vouchers('invoices'),
  'GET /api/v1/payments': vouchers('payments'),
  'GET /api/v1/outstanding': outstanding,
  'GET /api/v1/reports': reports,
  'GET /api/v1/connectors': connectors,
  'GET /api/v1/gst': gst,
};

const VOUCHER_ONE = /^\/api\/v1\/vouchers\/([^/]+)$/;

/**
 * The daily call ceiling, checked per key rather than per request path.
 *
 * Separate from the general rate limiter, which is about bursts: this is about
 * what the plan sold. A customer on Pro gets five thousand calls a day, and an
 * integration that loops forever should hit a wall it can read rather than
 * quietly costing the operator money.
 */
async function assertWithinDailyLimit(apiKey) {
  const plans = require('../lib/plans');
  const limit = plans.limitFor(apiKey.org, 'apiCallsPerDay');
  if (limit === null) return;

  const { rows } = await query(
    `SELECT count(*)::int AS n FROM api_log
      WHERE org_id = $1 AND at >= $2`, [apiKey.orgId, quotas.dayStart()]);

  if (rows[0].n >= limit) {
    throw new HttpError(429, 'DAILY_LIMIT',
      `Your plan allows ${limit} API calls a day and you have used them. `
      + 'The count resets at midnight.');
  }
}

/** Dispatch one public API request. Returns null if the path is not ours. */
async function handle(ctx, method, pathname) {
  if (!pathname.startsWith('/api/')) return null;

  if (!pathname.startsWith(`/api/${VERSION}/`)) {
    throw new HttpError(404, 'BAD_VERSION',
      `This API is at /api/${VERSION}/. Nothing else is served.`);
  }

  if (!ctx.apiKey) {
    throw new HttpError(401, 'NO_KEY',
      'Send your key as "Authorization: Bearer munim_…".');
  }

  await assertWithinDailyLimit(ctx.apiKey);

  const one = pathname.match(VOUCHER_ONE);
  if (one && method === 'GET') return voucher(ctx, decodeURIComponent(one[1]));

  const fn = ROUTES[`${method} ${pathname}`];
  if (!fn) {
    /*
     * A 405 rather than a 404 when the path exists but the method does not, so
     * that somebody who POSTs discovers the API is read-only rather than
     * concluding they have the URL wrong.
     */
    const anyMethod = Object.keys(ROUTES).some((k) => k.endsWith(` ${pathname}`));
    if (anyMethod) {
      throw new HttpError(405, 'READ_ONLY',
        'This API only reads. Munim can write vouchers you create in the app, '
        + 'but never through an API key.');
    }
    throw new HttpError(404, 'NO_ROUTE', `No route ${method} ${pathname}.`);
  }

  return fn(ctx);
}

/** The API's own documentation, served from the route table so it cannot lie. */
function describe() {
  return {
    version: VERSION,
    baseUrl: `${process.env.PUBLIC_API_URL || ''}/api/${VERSION}`,
    authentication: 'Authorization: Bearer munim_…',
    readOnly: true,
    paging: { limit: `default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}`, offset: 'from 0' },
    money: 'All amounts are integer paise. All GST rates are basis points (18% = 1800).',
    signs: 'Positive is debit. Munim negates Tally\'s convention on the way in.',
    incremental: 'Pass ?since=<ISO timestamp> to /vouchers to fetch only what has '
               + 'arrived since. It filters on when Munim received the record, not '
               + 'the voucher date, so a back-dated entry is not missed.',
    endpoints: Object.keys(ROUTES)
      .concat('GET /api/v1/vouchers/:id')
      .sort(),
    scopes: apikeys.SCOPES,
    webhooks: require('../lib/webhooks').EVENTS,
  };
}

module.exports = { handle, describe, VERSION, ROUTES };
