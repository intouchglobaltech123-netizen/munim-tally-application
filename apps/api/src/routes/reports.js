'use strict';
const { query } = require('../db');
const VT = require('../lib/vouchertypes');
const { bad, notFound } = require('../lib/http');
const auth = require('../lib/auth');

/**
 * Every report resolves the company through the caller's org first. That single
 * lookup is the tenant fence: without it, a signed-in user could read another
 * business's books by guessing a Tally GUID.
 */
async function companyFor(session, tallyGuid) {
  const { rows } = await query(
    'SELECT id, tally_guid, name, last_sync_at FROM companies WHERE org_id = $1 AND tally_guid = $2',
    [session.org.id, tallyGuid],
  );
  if (!rows.length) throw notFound('No such company in your account.');
  return rows[0];
}

const DEBTOR = 'sundry debtors';
const CREDITOR = 'sundry creditors';
const CASH_GROUPS = ['cash-in-hand', 'bank accounts'];

async function listCompanies(ctx) {
  const s = auth.requireUser(ctx);
  const { rows } = await query(
    `SELECT c.tally_guid, c.name, c.enabled, c.last_sync_at,
            (SELECT count(*)::int FROM ledgers  l WHERE l.company_id = c.id) AS ledgers,
            (SELECT count(*)::int FROM vouchers v WHERE v.company_id = c.id) AS vouchers
       FROM companies c WHERE c.org_id = $1 ORDER BY c.name`,
    [s.org.id],
  );
  return {
    companies: rows.map((r) => ({
      tallyGuid: r.tally_guid, name: r.name, enabled: r.enabled,
      lastSyncAt: r.last_sync_at, ledgers: r.ledgers, vouchers: r.vouchers,
    })),
  };
}

/** Turn a book's sync on or off. Takes effect on the connector's next beat. */
async function setCompanySync(ctx) {
  const s = auth.requireUser(ctx);
  const { tallyGuid, enabled } = ctx.body;
  const co = await companyFor(s, tallyGuid);
  await query('UPDATE companies SET enabled = $1 WHERE id = $2', [enabled !== false, co.id]);
  return { tallyGuid, enabled: enabled !== false };
}

async function dashboard(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);

  // One round trip per figure would be four; this is one query per concern and
  // they all hit indexes.
  const [tiles, trend, items, debtors, recent, counts, purch, compare] = await Promise.all([
    query(
      `SELECT
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = $2), 0)  AS receivable,
         COALESCE(-SUM(closing_paise) FILTER (WHERE lower(parent_group) = $3), 0) AS payable,
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'cash-in-hand'), 0) AS cash,
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'bank accounts'), 0) AS bank,
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = ANY($4)), 0) AS cash_and_bank,
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'stock-in-hand'), 0) AS stock
       FROM ledgers WHERE company_id = $1`,
      [co.id, DEBTOR, CREDITOR, CASH_GROUPS],
    ),
    query(
      `SELECT vch_date::text AS day, SUM(abs(amount_paise))::bigint AS amount
         FROM vouchers
        WHERE company_id = $1 AND NOT is_cancelled AND NOT is_optional
          AND ${VT.sales('')} AND vch_date IS NOT NULL
        GROUP BY vch_date ORDER BY vch_date DESC LIMIT 30`,
      [co.id],
    ),
    query(
      `SELECT i.item_name AS name, SUM(abs(i.amount_paise))::bigint AS amount
         FROM voucher_items i JOIN vouchers v ON v.id = i.voucher_id
        WHERE v.company_id = $1 AND NOT v.is_cancelled AND ${VT.sales('v')}
          AND i.item_name <> ''
        GROUP BY i.item_name ORDER BY amount DESC LIMIT 5`,
      [co.id],
    ),
    query(
      `SELECT name, phone, closing_paise AS amount
         FROM ledgers
        WHERE company_id = $1 AND lower(parent_group) = $2 AND closing_paise > 0
        ORDER BY closing_paise DESC LIMIT 6`,
      [co.id, DEBTOR],
    ),
    query(
      `SELECT vch_no, vch_date::text AS date, party, abs(amount_paise) AS amount, vch_type
         FROM vouchers
        WHERE company_id = $1 AND NOT is_cancelled
        ORDER BY vch_date DESC NULLS LAST, vch_no DESC LIMIT 8`,
      [co.id],
    ),
    query(
      `SELECT (SELECT count(*)::int FROM ledgers  WHERE company_id = $1) AS ledgers,
              (SELECT count(*)::int FROM vouchers WHERE company_id = $1) AS vouchers,
              (SELECT count(*)::int FROM bills    WHERE company_id = $1) AS bills,
              (SELECT count(*)::int FROM stock_items WHERE company_id = $1) AS items`,
      [co.id],
    ),
    query(
      `SELECT to_char(vch_date,'YYYY-MM') AS month, SUM(abs(amount_paise))::bigint AS amount
         FROM vouchers
        WHERE company_id = $1 AND ${VT.purchases('')}
          AND NOT is_cancelled AND vch_date IS NOT NULL
        GROUP BY month`,
      [co.id],
    ),
    /*
     * Sales this period against the one before it.
     *
     * A number on its own tells a shop owner nothing - 4 lakh is good or bad
     * only next to last month. This is the single most-used figure in every
     * competing app, and it is one query.
     *
     * Anchored on the latest voucher date rather than today: books are often
     * entered a few days late, and "this month" against a half-entered current
     * month reads as a collapse in sales.
     */
    query(
      `WITH asof AS (
         SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d
           FROM vouchers WHERE company_id = $1
       ),
       s AS (
         SELECT vch_date, abs(amount_paise) AS amt
           FROM vouchers, asof
          WHERE company_id = $1 AND ${VT.sales('')}
            AND NOT is_cancelled AND vch_date IS NOT NULL
       )
       SELECT
         COALESCE(SUM(amt) FILTER (
           WHERE vch_date >  (SELECT d FROM asof) - interval '30 days'), 0)::bigint AS this_30,
         COALESCE(SUM(amt) FILTER (
           WHERE vch_date <= (SELECT d FROM asof) - interval '30 days'
             AND vch_date >  (SELECT d FROM asof) - interval '60 days'), 0)::bigint AS prev_30,
         COALESCE(SUM(amt) FILTER (
           WHERE vch_date >  (SELECT d FROM asof) - interval '7 days'), 0)::bigint AS this_7,
         COALESCE(SUM(amt) FILTER (
           WHERE vch_date <= (SELECT d FROM asof) - interval '7 days'
             AND vch_date >  (SELECT d FROM asof) - interval '14 days'), 0)::bigint AS prev_7
       FROM s`,
      [co.id],
    ),
  ]);

  const days = trend.rows.map((r) => ({ day: r.day, amountPaise: Number(r.amount) })).reverse();

  // "This month" means the latest month present in the books, not the calendar
  // month: a shop that has not billed since March should still see March.
  const latest = days.length ? days[days.length - 1].day : null;
  const month = latest ? latest.slice(0, 7) : null;
  const prevMonth = month ? shiftMonth(month, -1) : null;
  const sumMonth = (m) => days.filter((d) => d.day.startsWith(m))
    .reduce((n, d) => n + d.amountPaise, 0);
  const mtd = month ? sumMonth(month) : 0;
  const prev = prevMonth ? sumMonth(prevMonth) : 0;

  const ageing = await ageingBuckets(co.id);
  const t = tiles.rows[0];

  return {
    company: { tallyGuid: co.tally_guid, name: co.name },
    asOf: co.last_sync_at,
    syncStatus: { lastSyncAt: co.last_sync_at, healthy: !!co.last_sync_at },
    tiles: {
      sales: {
        mtd, prevMtd: prev,
        total: days.reduce((n, d) => n + d.amountPaise, 0),
        changePct: prev ? Math.round(((mtd - prev) / prev) * 100) : null,
      },
      purchases: {
        mtd: month ? Number(purch.rows.find((r) => r.month === month)?.amount ?? 0) : 0,
        prevMtd: prevMonth
          ? Number(purch.rows.find((r) => r.month === prevMonth)?.amount ?? 0) : 0,
      },
      receivables: { total: Number(t.receivable), overdue: ageing.overdue, buckets: ageing.buckets },
      payables: { total: Number(t.payable) },
      // Kept as cashInHand for the existing clients; cash and bank are now
      // also reported separately, the way Tally shows them.
      cashInHand: { amount: Number(t.cash_and_bank) },
      cash: { amount: Number(t.cash) },
      bank: { amount: Number(t.bank) },
      stock: { amount: Number(t.stock) },
    },
    /*
     * Growth, ready to display. The client should not have to divide two
     * numbers and guard against a zero denominator - a shop with no sales last
     * month is a real case, and "Infinity%" on a dashboard is a bug report.
     */
    compare: (() => {
      const c = compare.rows[0];
      const pct = (now, before) => {
        const a = Number(now); const b = Number(before);
        if (b === 0) return a === 0 ? 0 : null;   // null = "no comparison"
        return Math.round(((a - b) / b) * 1000) / 10;
      };
      return {
        last30: {
          amountPaise: Number(c.this_30),
          prevPaise: Number(c.prev_30),
          changePct: pct(c.this_30, c.prev_30),
        },
        last7: {
          amountPaise: Number(c.this_7),
          prevPaise: Number(c.prev_7),
          changePct: pct(c.this_7, c.prev_7),
        },
      };
    })(),
    salesTrend: days,
    topItems: items.rows.map((r) => ({ name: r.name, amountPaise: Number(r.amount) })),
    topDebtors: debtors.rows.map((r) => ({
      name: r.name, phone: r.phone, amountPaise: Number(r.amount),
    })),
    recentVouchers: recent.rows.map((r) => ({
      vchNo: r.vch_no, date: r.date, party: r.party,
      amountPaise: Number(r.amount), type: r.vch_type,
    })),
    counts: counts.rows[0],
  };
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Ageing is computed against the newest date in the books, not today. */
async function ageingBuckets(companyId) {
  const { rows } = await query(
    `WITH asof AS (SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d
                     FROM vouchers WHERE company_id = $1)
     SELECT
       COALESCE(SUM(amount_paise) FILTER (WHERE age <=  30), 0)::bigint AS b0,
       COALESCE(SUM(amount_paise) FILTER (WHERE age >   30 AND age <= 60), 0)::bigint AS b1,
       COALESCE(SUM(amount_paise) FILTER (WHERE age >   60 AND age <= 90), 0)::bigint AS b2,
       COALESCE(SUM(amount_paise) FILTER (WHERE age >   90), 0)::bigint AS b3
     FROM (
       /*
        * open_bills nets each reference across ALL its rows.
        *
        * This grouped by (party, ref), which looks like netting but is not: a
        * receipt allocates against the same reference while posting to Cash,
        * so the invoice and its settlement landed in different groups and the
        * settlement was then dropped by the HAVING. On real books that
        * reported ₹27,60,900 outstanding where the ledgers said ₹14,24,700.
        */
       SELECT b.amount_paise,
              ((SELECT d FROM asof)
                 - effective_due(b.due_date, b.bill_date, l.credit_days)) AS age
         FROM open_bills b
         LEFT JOIN ledgers l ON l.company_id = b.company_id AND l.name = b.party
        WHERE b.company_id = $1 AND b.bill_date IS NOT NULL
     ) x WHERE age > 0`,
    [companyId],
  );
  const r = rows[0];
  const buckets = {
    '0-30': Number(r.b0), '31-60': Number(r.b1),
    '61-90': Number(r.b2), '90+': Number(r.b3),
  };
  return {
    buckets,
    overdue: Object.values(buckets).reduce((n, v) => n + v, 0),
  };
}

async function outstanding(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const kind = ctx.url.searchParams.get('kind') === 'payable' ? 'payable' : 'receivable';
  const group = kind === 'receivable' ? DEBTOR : CREDITOR;
  const sign = kind === 'receivable' ? 1 : -1;

  const { rows: parties } = await query(
    `SELECT name, phone, credit_days, ($3 * closing_paise) AS total
       FROM ledgers
      WHERE company_id = $1 AND lower(parent_group) = $2 AND ($3 * closing_paise) > 0
      ORDER BY total DESC`,
    [co.id, group, sign],
  );

  const { rows: billRows } = await query(
    `WITH asof AS (SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d
                     FROM vouchers WHERE company_id = $1)
     SELECT b.party, b.ref, b.bill_date::text AS date,
            effective_due(b.due_date, b.bill_date, l.credit_days)::text AS due,
            b.amount_paise,
            GREATEST((SELECT d FROM asof)
                     - effective_due(b.due_date, b.bill_date, l.credit_days), 0) AS days
       FROM open_bills b
       LEFT JOIN ledgers l ON l.company_id = b.company_id AND l.name = b.party
      WHERE b.company_id = $1 AND b.bill_date IS NOT NULL
      ORDER BY days DESC`,
    [co.id],
  );

  const byParty = new Map();
  for (const p of parties) {
    byParty.set(p.name, {
      party: p.name, ledgerName: p.name, phone: p.phone || '',
      creditDays: p.credit_days, totalPaise: Number(p.total),
      overduePaise: 0, oldestDays: 0, bills: [],
    });
  }
  for (const b of billRows) {
    const p = byParty.get(b.party);
    if (!p) continue;
    const days = Number(b.days) || 0;
    p.bills.push({ ref: b.ref, date: b.date, dueDate: b.due,
                   pendingPaise: Number(b.amount_paise), days });
    if (days > 0) {
      p.overduePaise += Number(b.amount_paise);
      p.oldestDays = Math.max(p.oldestDays, days);
    }
  }

  const items = [...byParty.values()]
    .map((p) => ({ ...p, bills: p.bills.slice(0, 50) }))
    .sort((a, b) => b.overduePaise - a.overduePaise || b.totalPaise - a.totalPaise);

  const ageing = await ageingBuckets(co.id);
  return {
    kind,
    totals: {
      total: items.reduce((n, p) => n + p.totalPaise, 0),
      overdue: items.reduce((n, p) => n + p.overduePaise, 0),
      buckets: kind === 'receivable' ? ageing.buckets
                                     : { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 },
    },
    items,
  };
}

async function ledgers(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const q = (ctx.url.searchParams.get('q') || '').trim();

  const { rows } = await query(
    `SELECT name, parent_group, phone, gstin, credit_days, closing_paise
       FROM ledgers
      WHERE company_id = $1 AND ($2 = '' OR name ILIKE '%' || $2 || '%')
      ORDER BY abs(closing_paise) DESC LIMIT 50`,
    [co.id, q],
  );
  return {
    ledgers: rows.map((r) => ({
      name: r.name, parentGroup: r.parent_group, phone: r.phone, gstin: r.gstin,
      creditDays: r.credit_days, closingPaise: Number(r.closing_paise),
    })),
  };
}

async function statement(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const name = ctx.url.searchParams.get('ledger') || '';
  if (!name) throw bad('BAD_REQUEST', 'Which ledger?');

  const { rows: led } = await query(
    `SELECT name, parent_group, phone, gstin, credit_days, opening_paise, closing_paise
       FROM ledgers WHERE company_id = $1 AND name = $2`,
    [co.id, name],
  );
  if (!led.length) throw notFound('No such ledger.');

  const { rows } = await query(
    `SELECT v.vch_date::text AS date, v.vch_no, v.vch_type, v.narration,
            e.amount_paise
       FROM voucher_entries e
       JOIN vouchers v ON v.id = e.voucher_id
      WHERE v.company_id = $1 AND e.ledger_name = $2 AND NOT v.is_cancelled
      ORDER BY v.vch_date NULLS FIRST, v.vch_no
      LIMIT 500`,
    [co.id, name],
  );

  let running = Number(led[0].opening_paise);
  const out = rows.map((r) => {
    running += Number(r.amount_paise);
    return {
      date: r.date, vchNo: r.vch_no, vchType: r.vch_type, narration: r.narration,
      amountPaise: Number(r.amount_paise), balancePaise: running,
    };
  });

  return {
    ledger: {
      name: led[0].name, parentGroup: led[0].parent_group, phone: led[0].phone,
      gstin: led[0].gstin, creditDays: led[0].credit_days,
      openingPaise: Number(led[0].opening_paise),
      closingPaise: Number(led[0].closing_paise),
    },
    rows: out,
  };
}

async function listConnectors(ctx) {
  const s = auth.requireUser(ctx);
  const { rows } = await query(
    `SELECT id, machine_name, tally_version, app_version, status, tally_up,
            paired_at, last_seen_at
       FROM connectors WHERE org_id = $1 ORDER BY paired_at`,
    [s.org.id],
  );
  return {
    connectors: rows.map((r) => ({
      id: r.id, machine: r.machine_name, tallyVersion: r.tally_version,
      appVersion: r.app_version, status: r.status, tallyUp: r.tally_up,
      pairedAt: r.paired_at, lastSeenAt: r.last_seen_at,
    })),
  };
}

module.exports = {
  listCompanies, setCompanySync, dashboard, outstanding, ledgers, statement,
  listConnectors, companyFor,
};
