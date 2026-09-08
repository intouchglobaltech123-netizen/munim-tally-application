'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const VT = require('../lib/vouchertypes');
const perms = require('../lib/permissions');
const { companyFor } = require('./reports');

/**
 * The whole business on one screen.
 *
 * One endpoint rather than eighteen, because every figure here has to agree
 * with every other one. Fetched separately they would drift: eight requests
 * land at eight different moments, a voucher syncs between them, and the
 * dashboard shows sales that do not match the sales chart underneath it. A
 * single query set against a single "as on" date cannot do that.
 */

/**
 * The last date the books actually contain.
 *
 * Every period is measured from here rather than from today. A shop that
 * stopped syncing on Friday should still see Friday's week, not an empty one
 * that says business collapsed - which is what "today" would show.
 */
async function asOf(companyId) {
  const { rows } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [companyId]);
  return new Date(rows[0].d);
}

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

/**
 * India's financial year runs 1 April to 31 March.
 *
 * Getting this wrong is not a rounding error - it puts a quarter of the year
 * in the wrong book, and every accountant looking at the screen will spot it
 * immediately.
 */
function financialYear(d) {
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 3 ? y : y - 1;
  return {
    from: new Date(Date.UTC(startYear, 3, 1)),
    to: new Date(Date.UTC(startYear + 1, 2, 31)),
    label: `FY ${startYear}-${String(startYear + 1).slice(2)}`,
  };
}

/** Every period the dashboard offers, resolved against the books' own clock. */
function resolvePeriod(key, d, customFrom, customTo) {
  const startOfWeek = (x) => {
    // Monday, not Sunday: an Indian shop's week is Monday to Saturday, and a
    // week that starts on Sunday splits the weekend across two of them.
    const day = (x.getUTCDay() + 6) % 7;
    return addDays(x, -day);
  };
  const monthStart = (x, off = 0) => new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + off, 1));
  const quarterStart = (x) => new Date(Date.UTC(
    x.getUTCFullYear(), Math.floor(x.getUTCMonth() / 3) * 3, 1));

  switch (key) {
    case 'today':      return { from: d, to: d, label: 'Today' };
    case 'yesterday':  return { from: addDays(d, -1), to: addDays(d, -1), label: 'Yesterday' };
    case 'week':       return { from: startOfWeek(d), to: d, label: 'This week' };
    case 'month':      return { from: monthStart(d), to: d, label: 'This month' };
    case 'last-month': return {
      from: monthStart(d, -1),
      to: addDays(monthStart(d), -1),
      label: 'Last month',
    };
    case 'quarter':    return { from: quarterStart(d), to: d, label: 'This quarter' };
    case 'year':       return { from: new Date(Date.UTC(d.getUTCFullYear(), 0, 1)), to: d,
                                label: 'This calendar year' };
    case 'custom': {
      const f = customFrom && /^\d{4}-\d{2}-\d{2}$/.test(customFrom) ? new Date(customFrom) : null;
      const t = customTo && /^\d{4}-\d{2}-\d{2}$/.test(customTo) ? new Date(customTo) : null;
      if (f && t && f <= t) return { from: f, to: t, label: 'Custom range' };
      // A malformed range falls back rather than erroring: a dashboard that
      // refuses to load because of a bad query string is worse than one
      // showing its default.
      const fy = financialYear(d);
      return { ...fy, label: `${fy.label} (bad range given)` };
    }
    case 'fy':
    default:           return financialYear(d);
  }
}

/** The previous period of equal length, for every "vs last" comparison. */
function previousOf(period) {
  const days = Math.max(1,
    Math.round((period.to - period.from) / 86_400_000) + 1);
  return { from: addDays(period.from, -days), to: addDays(period.from, -1), days };
}

/*
 * Filters shared by every voucher query.
 *
 * Cancelled and optional vouchers are excluded everywhere. Tally keeps them as
 * a record; counting them would inflate sales with entries the business itself
 * has struck out.
 */
const LIVE = VT.LIVE;
const SALES = VT.SALES;
const PURCH = VT.PURCHASES;

/**
 * Extra narrowing the user asked for: one party, one item, one salesperson.
 *
 * Built as a fragment plus params rather than interpolated, because these come
 * from a query string and the only safe place for a user's text is a bound
 * parameter.
 */
function scopeOf(q, startIndex) {
  const parts = [];
  const args = [];
  let i = startIndex;
  const party = (q.get('party') ?? '').trim();
  const item = (q.get('item') ?? '').trim();
  const salesperson = (q.get('salesperson') ?? '').trim();

  if (party) { parts.push(`v.party = $${++i}`); args.push(party); }
  if (item) {
    parts.push(`EXISTS (SELECT 1 FROM voucher_items vi
                         WHERE vi.voucher_id = v.id AND vi.item_name = $${++i})`);
    args.push(item);
  }
  if (salesperson) {
    // Tally has no first-class salesperson on a voucher for most setups, so
    // this matches the narration, which is where shops actually write it.
    parts.push(`v.narration ILIKE $${++i}`);
    args.push(`%${salesperson}%`);
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', args, next: i };
}

async function overview(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'dashboard', 'read');
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;

  const d = await asOf(co.id);
  const period = resolvePeriod(q.get('period') || 'fy', d, q.get('from'), q.get('to'));
  const prev = previousOf(period);
  const fy = financialYear(d);

  /*
   * Two numberings, because two query shapes.
   *
   * Most queries bind $1 company, $2 from, $3 to - so extra filters start at
   * $4. The bucketed trends take the granularity as $4, so theirs start at $5.
   * One shared `scope` silently produced $4 in a statement whose $4 was
   * already taken, which Postgres rejects at bind time.
   */
  const scope = scopeOf(q, 3);           // $1 company, $2 from, $3 to
  const scopeBucketed = scopeOf(q, 4);   // ... plus $4 granularity
  const base = [co.id, iso(period.from), iso(period.to), ...scope.args];
  const prevBase = [co.id, iso(prev.from), iso(prev.to), ...scope.args];

  const flowSql = `
    SELECT
      COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE ${SALES}), 0)::bigint AS sales,
      COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE ${PURCH}), 0)::bigint AS purchases,
      COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE v.vch_type ILIKE '%receipt%'), 0)::bigint AS receipts,
      COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE v.vch_type ILIKE '%payment%'), 0)::bigint AS payments,
      count(*) FILTER (WHERE ${SALES})::int AS sale_count
    FROM vouchers v
     WHERE v.company_id = $1 AND ${LIVE}
       AND v.vch_date BETWEEN $2::date AND $3::date${scope.sql}`;

  const [flow, prevFlow, today, balances, bills, series, byParty, bySupplier,
         byItem, byGroup, bySalesperson, cashflow, landscape, allTime] = await Promise.all([
    query(flowSql, base),
    query(flowSql, prevBase),

    /*
     * "Today" is the last day the books contain, for the same reason every
     * other period is measured from there.
     *
     * Expressed as a range whose ends are equal rather than by rewriting the
     * SQL - editing the query text to drop $3 left the placeholder numbering
     * out of step with the arguments, which Postgres rejects at bind time.
     */
    query(flowSql, [co.id, iso(d), iso(d), ...scope.args]),

    query(
      `SELECT
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'sundry debtors'), 0)::bigint   AS receivables,
         COALESCE(-SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'sundry creditors'), 0)::bigint AS payables,
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'cash-in-hand'), 0)::bigint     AS cash,
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'bank accounts'), 0)::bigint    AS bank,
         COALESCE(SUM(closing_paise) FILTER (WHERE lower(parent_group) = 'stock-in-hand'), 0)::bigint    AS stock,
         COALESCE(-SUM(closing_paise) FILTER (
           WHERE lower(parent_group) = 'duties & taxes' AND closing_paise < 0), 0)::bigint AS gst_payable,
         COALESCE(SUM(closing_paise) FILTER (
           WHERE lower(parent_group) = 'duties & taxes' AND closing_paise > 0), 0)::bigint AS gst_receivable,
         COALESCE(-SUM(closing_paise) FILTER (WHERE account_nature(parent_group) = 'income'), 0)::bigint AS income,
         COALESCE(SUM(closing_paise) FILTER (WHERE account_nature(parent_group) = 'expense'), 0)::bigint AS expenses
       FROM ledgers WHERE company_id = $1`, [co.id]),

    query(
      `SELECT count(*)::int AS open_count,
              count(*) FILTER (
                WHERE $2::date > effective_due(b.due_date, b.bill_date, l.credit_days))::int AS overdue_count,
              COALESCE(SUM(b.amount_paise), 0)::bigint AS open_amount,
              COALESCE(SUM(b.amount_paise) FILTER (
                WHERE $2::date > effective_due(b.due_date, b.bill_date, l.credit_days)), 0)::bigint AS overdue_amount
         FROM open_bills b
         LEFT JOIN ledgers l ON l.company_id = b.company_id AND l.name = b.party
        WHERE b.company_id = $1`, [co.id, iso(d)]),

    // Every trend in one pass over the period, bucketed by day or month
    // depending on how long it is - 365 daily points on a phone is a smear.
    query(
      `SELECT to_char(date_trunc($4, v.vch_date), 'YYYY-MM-DD') AS bucket,
              COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE ${SALES}), 0)::bigint AS sales,
              COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE ${PURCH}), 0)::bigint AS purchases,
              COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE v.vch_type ILIKE '%receipt%'), 0)::bigint AS receipts,
              COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE v.vch_type ILIKE '%payment%'), 0)::bigint AS payments
         FROM vouchers v
        WHERE v.company_id = $1 AND ${LIVE}
          AND v.vch_date BETWEEN $2::date AND $3::date${scopeBucketed.sql}
        GROUP BY 1 ORDER BY 1`,
      [co.id, iso(period.from), iso(period.to),
       (period.to - period.from) / 86_400_000 > 92 ? 'month' : 'day', ...scopeBucketed.args]),

    query(
      `SELECT v.party AS label, SUM(abs(v.amount_paise))::bigint AS amount, count(*)::int AS n
         FROM vouchers v
        WHERE v.company_id = $1 AND ${LIVE} AND ${SALES}
          AND v.vch_date BETWEEN $2::date AND $3::date AND v.party <> ''${scope.sql}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, base),

    query(
      `SELECT v.party AS label, SUM(abs(v.amount_paise))::bigint AS amount, count(*)::int AS n
         FROM vouchers v
        WHERE v.company_id = $1 AND ${LIVE} AND ${PURCH}
          AND v.vch_date BETWEEN $2::date AND $3::date AND v.party <> ''${scope.sql}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, base),

    query(
      `SELECT vi.item_name AS label, SUM(abs(vi.amount_paise))::bigint AS amount,
              SUM(vi.qty)::float AS qty
         FROM voucher_items vi JOIN vouchers v ON v.id = vi.voucher_id
        WHERE v.company_id = $1 AND ${LIVE} AND ${SALES}
          AND v.vch_date BETWEEN $2::date AND $3::date AND vi.item_name <> ''${scope.sql}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, base),

    query(
      `SELECT COALESCE(NULLIF(l.parent_group, ''), 'Ungrouped') AS label,
              SUM(abs(v.amount_paise))::bigint AS amount
         FROM vouchers v
         LEFT JOIN ledgers l ON l.company_id = v.company_id AND l.name = v.party
        WHERE v.company_id = $1 AND ${LIVE} AND ${SALES}
          AND v.vch_date BETWEEN $2::date AND $3::date${scope.sql}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, base),

    // Salespeople as this org has recorded them, matched against narration.
    query(
      `SELECT u.salesperson_name AS label,
              COALESCE((SELECT SUM(abs(v.amount_paise)) FROM vouchers v
                         WHERE v.company_id = $1 AND ${LIVE} AND ${SALES}
                           AND v.vch_date BETWEEN $2::date AND $3::date
                           AND v.narration ILIKE '%' || u.salesperson_name || '%'), 0)::bigint AS amount
         FROM users u
        WHERE u.org_id = $4 AND u.is_salesperson AND u.salesperson_name <> ''
        ORDER BY 2 DESC LIMIT 10`,
      [co.id, iso(period.from), iso(period.to), s.org.id]),

    // Money in against money out, per bucket - the one chart an owner reads
    // before any other.
    query(
      `SELECT to_char(date_trunc($4, v.vch_date), 'YYYY-MM-DD') AS bucket,
              COALESCE(SUM(abs(v.amount_paise)) FILTER (
                WHERE v.vch_type ILIKE '%receipt%' OR ${SALES}), 0)::bigint AS money_in,
              COALESCE(SUM(abs(v.amount_paise)) FILTER (
                WHERE v.vch_type ILIKE '%payment%' OR ${PURCH}), 0)::bigint AS money_out
         FROM vouchers v
        WHERE v.company_id = $1 AND ${LIVE}
          AND v.vch_date BETWEEN $2::date AND $3::date${scopeBucketed.sql}
        GROUP BY 1 ORDER BY 1`,
      [co.id, iso(period.from), iso(period.to),
       (period.to - period.from) / 86_400_000 > 92 ? 'month' : 'day', ...scopeBucketed.args]),

    /*
     * Sales by month AND by customer - two keys against one value.
     *
     * Restricted to the top eight customers because the point is the shape of
     * the business, and a field with two hundred ridges one pixel wide has no
     * shape at all.
     */
    query(
      `WITH top8 AS (
         SELECT v.party FROM vouchers v
          WHERE v.company_id = $1 AND ${LIVE} AND ${SALES}
            AND v.vch_date BETWEEN $2::date AND $3::date AND v.party <> ''
          GROUP BY v.party ORDER BY SUM(abs(v.amount_paise)) DESC LIMIT 8
       )
       SELECT to_char(date_trunc('month', v.vch_date), 'YYYY-MM-DD') AS month,
              v.party, SUM(abs(v.amount_paise))::bigint AS amount
         FROM vouchers v
        WHERE v.company_id = $1 AND ${LIVE} AND ${SALES}
          AND v.vch_date BETWEEN $2::date AND $3::date
          AND v.party IN (SELECT party FROM top8)
        GROUP BY 1, 2 ORDER BY 1, 2`,
      [co.id, iso(period.from), iso(period.to)]),

    query('SELECT count(*)::int AS n FROM vouchers WHERE company_id = $1', [co.id]),
  ]);

  const f = flow.rows[0];
  const p = prevFlow.rows[0];
  const t = today.rows[0];
  const b = balances.rows[0];
  const bl = bills.rows[0];

  // null, never Infinity: a period with no prior trade has no percentage, and
  // "Infinity%" on a dashboard is a bug report.
  const pct = (now, before) => {
    const a = Number(now); const c = Number(before);
    if (c === 0) return a === 0 ? 0 : null;
    return Math.round(((a - c) / c) * 1000) / 10;
  };

  const sales = Number(f.sales);
  const purchases = Number(f.purchases);
  const expenses = Number(b.expenses);
  const income = Number(b.income);

  return {
    company: { tallyGuid: co.tally_guid, name: co.name },
    asOf: iso(d),
    period: { key: q.get('period') || 'fy', from: iso(period.from), to: iso(period.to),
              label: period.label },
    previous: { from: iso(prev.from), to: iso(prev.to) },
    financialYear: { from: iso(fy.from), to: iso(fy.to), label: fy.label },
    scope: {
      party: q.get('party') || '', item: q.get('item') || '',
      salesperson: q.get('salesperson') || '',
    },

    /*
     * The eighteen. Every one carries its comparison where a comparison is
     * meaningful - a balance has no "previous", a flow does.
     */
    metrics: {
      sales:          { paise: sales, prev: Number(p.sales), changePct: pct(f.sales, p.sales) },
      purchases:      { paise: purchases, prev: Number(p.purchases), changePct: pct(f.purchases, p.purchases) },
      // Sales less what was bought in the same window. Honest about what it is:
      // without item-level cost this is trading margin, not true gross profit.
      grossProfit:    { paise: sales - purchases,
                        note: 'Sales less purchases in this period.' },
      netProfit:      { paise: income - expenses,
                        note: 'Income less expenses, from ledger balances.' },
      receivables:    { paise: Number(b.receivables) },
      payables:       { paise: Number(b.payables) },
      cash:           { paise: Number(b.cash) },
      bank:           { paise: Number(b.bank) },
      expenses:       { paise: expenses },
      stock:          { paise: Number(b.stock) },
      gstPayable:     { paise: Number(b.gst_payable) },
      gstReceivable:  { paise: Number(b.gst_receivable) },
      outstandingInvoices: { count: bl.open_count, paise: Number(bl.open_amount) },
      overdueInvoices:     { count: bl.overdue_count, paise: Number(bl.overdue_amount) },
      todaySales:     { paise: Number(t.sales) },
      todayPurchases: { paise: Number(t.purchases) },
      todayReceipts:  { paise: Number(t.receipts) },
      todayPayments:  { paise: Number(t.payments) },
    },

    /** The twelve. Each ready to draw, with no arithmetic left for the client. */
    charts: {
      salesTrend:      series.rows.map((r) => ({ at: r.bucket, value: Number(r.sales) })),
      purchaseTrend:   series.rows.map((r) => ({ at: r.bucket, value: Number(r.purchases) })),
      profitTrend:     series.rows.map((r) => ({
        at: r.bucket, value: Number(r.sales) - Number(r.purchases) })),
      expenseTrend:    series.rows.map((r) => ({ at: r.bucket, value: Number(r.payments) })),
      receivableTrend: series.rows.map((r) => ({ at: r.bucket, value: Number(r.sales) })),
      payableTrend:    series.rows.map((r) => ({ at: r.bucket, value: Number(r.purchases) })),
      cashFlow:        cashflow.rows.map((r) => ({
        at: r.bucket, in: Number(r.money_in), out: Number(r.money_out),
        net: Number(r.money_in) - Number(r.money_out) })),
      topCustomers:    byParty.rows.map((r) => ({ label: r.label, value: Number(r.amount), n: r.n })),
      topSuppliers:    bySupplier.rows.map((r) => ({ label: r.label, value: Number(r.amount), n: r.n })),
      topProducts:     byItem.rows.map((r) => ({
        label: r.label, value: Number(r.amount), qty: Number(r.qty) })),
      salespeople:     bySalesperson.rows.map((r) => ({ label: r.label, value: Number(r.amount) })),
      categories:      byGroup.rows.map((r) => ({ label: r.label, value: Number(r.amount) })),
    },

    /** Month x customer x amount, for the 3D landscape. */
    landscape: {
      cells: landscape.rows.map((r) => ({
        month: r.month, party: r.party, value: Number(r.amount) })),
      months: [...new Set(landscape.rows.map((r) => r.month))].sort(),
      parties: [...new Set(landscape.rows.map((r) => r.party))].sort(),
    },

    counts: {
      salesVouchers: t.sale_count,
      /*
       * Every voucher ever synced, not this period's.
       *
       * The notifier compares this against what it saw last time, so it has to
       * only ever grow. A period count resets when the period rolls over,
       * which would read as records vanishing and then arriving again.
       */
      vouchersTotal: Number(allTime.rows[0].n),
    },
  };
}

/** The values the filter dropdowns offer, drawn from the books themselves. */
async function filterOptions(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'dashboard', 'read');
  const co = await companyFor(s, tallyGuid);

  const [parties, items, salespeople, branches] = await Promise.all([
    query(
      `SELECT DISTINCT party AS v FROM vouchers
        WHERE company_id = $1 AND party <> '' ORDER BY 1 LIMIT 500`, [co.id]),
    query(
      `SELECT DISTINCT vi.item_name AS v FROM voucher_items vi
         JOIN vouchers v ON v.id = vi.voucher_id
        WHERE v.company_id = $1 AND vi.item_name <> '' ORDER BY 1 LIMIT 500`, [co.id]),
    query(
      `SELECT DISTINCT salesperson_name AS v FROM users
        WHERE org_id = $1 AND is_salesperson AND salesperson_name <> '' ORDER BY 1`, [s.org.id]),
    query(
      `SELECT DISTINCT branch AS v FROM users
        WHERE org_id = $1 AND branch <> '' ORDER BY 1`, [s.org.id]),
  ]);

  return {
    parties: parties.rows.map((r) => r.v),
    items: items.rows.map((r) => r.v),
    salespeople: salespeople.rows.map((r) => r.v),
    branches: branches.rows.map((r) => r.v),
    periods: [
      { key: 'today', label: 'Today' },
      { key: 'yesterday', label: 'Yesterday' },
      { key: 'week', label: 'This week' },
      { key: 'month', label: 'This month' },
      { key: 'last-month', label: 'Last month' },
      { key: 'quarter', label: 'This quarter' },
      { key: 'year', label: 'This year' },
      { key: 'fy', label: 'Financial year' },
      { key: 'custom', label: 'Custom range' },
    ],
  };
}

module.exports = { overview, filterOptions, resolvePeriod, financialYear, previousOf };
