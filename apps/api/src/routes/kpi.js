'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const VT = require('../lib/vouchertypes');
const { HttpError } = require('../lib/http');

/**
 * The numbers a business is actually run on.
 *
 * Scattered across the dashboard, insights and reports until now, which meant
 * three screens computing "revenue" three slightly different ways. This is one
 * place, one definition each, and every figure carries what it was computed
 * from - because a KPI whose derivation is invisible is a KPI nobody trusts the
 * second time it disagrees with Tally.
 *
 * Where the data cannot support a figure honestly, it says so rather than
 * approximating. Munim reads Tally; it does not hold item cost, so "gross
 * profit" here is trading margin and is labelled as such. Quietly presenting
 * one as the other is how a shop owner makes a pricing decision on a number
 * that was never real.
 */

async function companyFor(session, tallyGuid) {
  const { rows } = await query(
    'SELECT * FROM companies WHERE org_id = $1 AND tally_guid = $2',
    [session.org.id, tallyGuid]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such company.');
  return rows[0];
}

/**
 * The window, defaulting to this financial year.
 *
 * India runs 1 April to 31 March, and a shop owner asking "how are we doing"
 * means the year they file, not the last 365 days.
 */
function period(ctx) {
  const q = ctx.url.searchParams;
  const from = q.get('from');
  const to = q.get('to');
  if (from && to) return { from, to, label: `${from} to ${to}` };

  const now = new Date();
  const startYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
  return {
    from: `${startYear}-04-01`,
    to: `${startYear + 1}-03-31`,
    label: `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`,
  };
}

/** The same window, one year earlier, for growth. */
function priorPeriod(p) {
  const shift = (d) => {
    const x = new Date(d);
    x.setFullYear(x.getFullYear() - 1);
    return x.toISOString().slice(0, 10);
  };
  return { from: shift(p.from), to: shift(p.to) };
}

const pct = (now, before) => {
  if (!before) return null;                 // no base: a percentage would be a lie
  return Math.round(((now - before) / Math.abs(before)) * 1000) / 10;
};

/** Sales: what came in, from whom, and for what. */
async function sales(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'reports', 'read');
  const co = await companyFor(s, tallyGuid);
  const p = period(ctx);
  const prior = priorPeriod(p);

  const { rows: totals } = await query(`
    SELECT
      COALESCE(SUM(abs(v.amount_paise)) FILTER (
        WHERE v.vch_date BETWEEN $2::date AND $3::date), 0)::bigint AS revenue,
      count(*) FILTER (WHERE v.vch_date BETWEEN $2::date AND $3::date) AS invoices,
      COALESCE(SUM(abs(v.amount_paise)) FILTER (
        WHERE v.vch_date BETWEEN $4::date AND $5::date), 0)::bigint AS prior_revenue,
      count(*) FILTER (WHERE v.vch_date BETWEEN $4::date AND $5::date) AS prior_invoices
      FROM vouchers v
     WHERE v.company_id = $1 AND NOT v.is_cancelled AND NOT v.is_optional
       AND ${VT.SALES}`,
    [co.id, p.from, p.to, prior.from, prior.to]);

  const t = totals[0];
  const revenue = Number(t.revenue);
  const invoices = Number(t.invoices);
  const priorRevenue = Number(t.prior_revenue);

  const { rows: customers } = await query(`
    SELECT v.party, SUM(abs(v.amount_paise))::bigint AS amount, count(*)::int AS invoices
      FROM vouchers v
     WHERE v.company_id = $1 AND v.vch_date BETWEEN $2::date AND $3::date
       AND NOT v.is_cancelled AND NOT v.is_optional AND v.party <> '' AND ${VT.SALES}
     GROUP BY v.party ORDER BY amount DESC LIMIT 10`, [co.id, p.from, p.to]);

  const { rows: products } = await query(`
    SELECT i.item_name, SUM(i.amount_paise)::bigint AS amount,
           SUM(i.qty)::numeric AS qty, count(DISTINCT v.id)::int AS invoices
      FROM voucher_items i JOIN vouchers v ON v.id = i.voucher_id
     WHERE v.company_id = $1 AND v.vch_date BETWEEN $2::date AND $3::date
       AND NOT v.is_cancelled AND NOT v.is_optional AND ${VT.SALES}
     GROUP BY i.item_name ORDER BY amount DESC LIMIT 10`, [co.id, p.from, p.to]);

  const { rows: monthly } = await query(`
    SELECT to_char(date_trunc('month', v.vch_date), 'YYYY-MM') AS month,
           SUM(abs(v.amount_paise))::bigint AS amount, count(*)::int AS invoices
      FROM vouchers v
     WHERE v.company_id = $1 AND v.vch_date BETWEEN $2::date AND $3::date
       AND NOT v.is_cancelled AND NOT v.is_optional AND ${VT.SALES}
     GROUP BY 1 ORDER BY 1`, [co.id, p.from, p.to]);

  /*
   * Salesperson performance depends on Tally cost centres, which Munim does not
   * fetch. Reported as unavailable with the reason rather than omitted: a
   * missing section reads as "we have no sales staff", which is a different
   * and wrong answer.
   */
  return {
    period: p,
    revenuePaise: revenue,
    invoices,
    averageInvoicePaise: invoices ? Math.round(revenue / invoices) : 0,
    growthPercent: pct(revenue, priorRevenue),
    priorRevenuePaise: priorRevenue,
    priorInvoices: Number(t.prior_invoices),
    topCustomers: customers.map((c) => ({
      party: c.party,
      amountPaise: Number(c.amount),
      invoices: c.invoices,
      sharePercent: revenue ? Math.round((Number(c.amount) / revenue) * 1000) / 10 : 0,
    })),
    topProducts: products.map((i) => ({
      item: i.item_name,
      amountPaise: Number(i.amount),
      qty: Number(i.qty),
      invoices: i.invoices,
    })),
    monthly: monthly.map((m) => ({
      month: m.month, amountPaise: Number(m.amount), invoices: m.invoices,
    })),
    /*
     * Concentration risk, which is the number a lender asks for and an owner
     * rarely computes: how much of the year rests on one customer.
     */
    concentration: customers.length ? {
      topCustomerPercent: revenue
        ? Math.round((Number(customers[0].amount) / revenue) * 1000) / 10 : 0,
      topFivePercent: revenue
        ? Math.round((customers.slice(0, 5)
            .reduce((a, c) => a + Number(c.amount), 0) / revenue) * 1000) / 10 : 0,
    } : null,
    salespeople: {
      available: false,
      note: 'Salesperson performance needs Tally cost centres, which Munim does '
          + 'not currently read.',
    },
  };
}

/** Collection: what is owed, how overdue, and how fast it actually arrives. */
async function collection(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'outstanding', 'read');
  const co = await companyFor(s, tallyGuid);
  const p = period(ctx);

  // open_bills nets each reference across its allocations. Summing `bills`
  // directly overstated receivables by 94% before that view existed.
  const { rows: due } = await query(`
    SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total,
           COALESCE(SUM(amount_paise) FILTER (WHERE due_date < CURRENT_DATE), 0)::bigint
             AS overdue,
           count(*)::int AS bills,
           count(*) FILTER (WHERE due_date < CURRENT_DATE)::int AS overdue_bills,
           COALESCE(max(CURRENT_DATE - due_date) FILTER (WHERE due_date < CURRENT_DATE), 0)::int
             AS oldest_days
      FROM open_bills WHERE company_id = $1`, [co.id]);

  const { rows: flow } = await query(`
    SELECT
      COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE ${VT.SALES}), 0)::bigint AS billed,
      COALESCE(SUM(abs(v.amount_paise)) FILTER (
        WHERE v.vch_type ILIKE '%receipt%' AND v.vch_type NOT ILIKE '%note%'), 0)::bigint
        AS collected
      FROM vouchers v
     WHERE v.company_id = $1 AND v.vch_date BETWEEN $2::date AND $3::date
       AND NOT v.is_cancelled AND NOT v.is_optional`, [co.id, p.from, p.to]);

  /*
   * Average days to pay, measured on bills that have actually been settled.
   *
   * Including unsettled ones would flatter the number early in their life and
   * ruin it later, and the figure would move every day without anything having
   * happened.
   */
  const { rows: paid } = await query(`
    -- date minus date is already a count of days in Postgres, not an interval.
    SELECT COALESCE(avg(settled.at - b.bill_date), 0)::numeric AS days,
           count(*)::int AS n
      FROM bills b
      JOIN LATERAL (
        SELECT max(v2.vch_date) AS at FROM bills b2
          JOIN vouchers v2 ON v2.id = b2.voucher_id
         WHERE b2.company_id = b.company_id AND b2.ref = b.ref AND b2.amount_paise < 0
      ) settled ON settled.at IS NOT NULL
     WHERE b.company_id = $1 AND b.amount_paise > 0 AND b.bill_date IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM open_bills o
                        WHERE o.company_id = b.company_id AND o.ref = b.ref)`,
    [co.id]);

  const billed = Number(flow[0].billed);
  const collected = Number(flow[0].collected);
  const total = Number(due[0].total);

  /*
   * DSO the simple way: receivables divided by average daily sales over the
   * window. The "countback" method is more precise for a seasonal business but
   * needs a monthly series and explaining, and this is the number a bank asks
   * for.
   */
  const days = Math.max(1,
    Math.round((new Date(p.to) - new Date(p.from)) / 86400000) + 1);
  const dailySales = billed / days;

  return {
    period: p,
    receivablePaise: total,
    overduePaise: Number(due[0].overdue),
    bills: due[0].bills,
    overdueBills: due[0].overdue_bills,
    oldestOverdueDays: due[0].oldest_days,
    billedPaise: billed,
    collectedPaise: collected,
    /*
     * Collection rate over one window is receipts against billings in the same
     * window, which is not the same as "of what we billed, how much came in" -
     * receipts land against older invoices too. Named for what it measures.
     */
    collectionRatePercent: billed ? Math.round((collected / billed) * 1000) / 10 : null,
    collectionRateNote: 'Receipts in this period against sales in this period. '
                      + 'Receipts often settle older invoices, so this can exceed 100%.',
    averagePaymentDays: Number(paid[0].n) ? Math.round(Number(paid[0].days)) : null,
    averagePaymentBasis: Number(paid[0].n)
      ? `${paid[0].n} settled bills`
      : 'No bills have been settled yet',
    dsoDays: dailySales > 0 ? Math.round(total / dailySales) : null,
    dsoNote: 'Receivables divided by average daily sales over this period.',
  };
}

/** Purchases: what went out, to whom, and how concentrated the supply is. */
async function purchases(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'purchase', 'read');
  const co = await companyFor(s, tallyGuid);
  const p = period(ctx);
  const prior = priorPeriod(p);

  const { rows: totals } = await query(`
    SELECT
      COALESCE(SUM(abs(v.amount_paise)) FILTER (
        WHERE v.vch_date BETWEEN $2::date AND $3::date), 0)::bigint AS amount,
      count(*) FILTER (WHERE v.vch_date BETWEEN $2::date AND $3::date) AS bills,
      COALESCE(SUM(abs(v.amount_paise)) FILTER (
        WHERE v.vch_date BETWEEN $4::date AND $5::date), 0)::bigint AS prior_amount
      FROM vouchers v
     WHERE v.company_id = $1 AND NOT v.is_cancelled AND NOT v.is_optional
       AND ${VT.PURCHASES}`, [co.id, p.from, p.to, prior.from, prior.to]);

  const { rows: suppliers } = await query(`
    SELECT v.party, SUM(abs(v.amount_paise))::bigint AS amount, count(*)::int AS bills
      FROM vouchers v
     WHERE v.company_id = $1 AND v.vch_date BETWEEN $2::date AND $3::date
       AND NOT v.is_cancelled AND NOT v.is_optional AND v.party <> '' AND ${VT.PURCHASES}
     GROUP BY v.party ORDER BY amount DESC LIMIT 10`, [co.id, p.from, p.to]);

  const amount = Number(totals[0].amount);
  const topFive = suppliers.slice(0, 5).reduce((a, x) => a + Number(x.amount), 0);

  return {
    period: p,
    amountPaise: amount,
    bills: Number(totals[0].bills),
    growthPercent: pct(amount, Number(totals[0].prior_amount)),
    priorAmountPaise: Number(totals[0].prior_amount),
    topSuppliers: suppliers.map((x) => ({
      party: x.party, amountPaise: Number(x.amount), bills: x.bills,
      sharePercent: amount ? Math.round((Number(x.amount) / amount) * 1000) / 10 : 0,
    })),
    /*
     * The risk nobody looks at until the supplier raises prices or closes.
     */
    concentration: amount ? {
      topSupplierPercent: suppliers.length
        ? Math.round((Number(suppliers[0].amount) / amount) * 1000) / 10 : 0,
      topFivePercent: Math.round((topFive / amount) * 1000) / 10,
      warning: suppliers.length && (Number(suppliers[0].amount) / amount) > 0.5
        ? `Over half your buying is from ${suppliers[0].party}.` : '',
    } : null,
  };
}

/** Inventory: what is sitting there, what moves, and what has stopped. */
async function inventory(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'stock', 'read');
  const co = await companyFor(s, tallyGuid);
  const p = period(ctx);

  const { rows: value } = await query(`
    SELECT COALESCE(SUM(closing_value_paise), 0)::bigint AS value,
           count(*)::int AS items,
           count(*) FILTER (WHERE closing_qty < 0)::int AS negative,
           COALESCE(SUM(closing_value_paise) FILTER (WHERE closing_qty < 0), 0)::bigint
             AS negative_value,
           count(*) FILTER (
             WHERE reorder_level > 0 AND closing_qty <= reorder_level)::int AS low
      FROM stock_items WHERE company_id = $1`, [co.id]);

  const { rows: moved } = await query(`
    SELECT i.item_name,
           SUM(i.qty)::numeric AS qty,
           SUM(i.amount_paise)::bigint AS amount,
           max(v.vch_date) AS last_sold
      FROM voucher_items i JOIN vouchers v ON v.id = i.voucher_id
     WHERE v.company_id = $1 AND v.vch_date BETWEEN $2::date AND $3::date
       AND NOT v.is_cancelled AND NOT v.is_optional AND ${VT.SALES}
     GROUP BY i.item_name ORDER BY amount DESC`, [co.id, p.from, p.to]);

  const soldNames = new Set(moved.map((m) => m.item_name));

  /*
   * Dead stock is "held, worth something, and not sold once in the window".
   *
   * Deliberately not "not sold in 90 days": a seasonal business - fireworks,
   * umbrellas, woollens - would have its entire catalogue flagged every year,
   * and a report that is wrong every year is a report nobody opens.
   */
  const { rows: held } = await query(`
    SELECT name, closing_qty, closing_value_paise
      FROM stock_items
     WHERE company_id = $1 AND closing_value_paise > 0
     ORDER BY closing_value_paise DESC LIMIT 500`, [co.id]);

  const dead = held.filter((h) => !soldNames.has(h.name));
  const deadValue = dead.reduce((a, h) => a + Number(h.closing_value_paise), 0);
  const stockValue = Number(value[0].value);

  const cogsProxy = moved.reduce((a, m) => a + Number(m.amount), 0);

  return {
    period: p,
    stockValuePaise: stockValue,
    items: value[0].items,
    /*
     * Turnover against sales value, not cost of goods sold, because Munim does
     * not hold item cost. That makes it optimistic by the margin, so it is
     * named for what it is rather than called "stock turnover" flat.
     */
    turnsBySalesValue: stockValue ? Math.round((cogsProxy / stockValue) * 100) / 100 : null,
    turnoverNote: 'Sales value divided by closing stock value. Munim does not hold '
                + 'item cost, so this is higher than a true cost-based turnover.',
    daysOfStock: cogsProxy > 0
      ? Math.round(stockValue / (cogsProxy / Math.max(1,
          Math.round((new Date(p.to) - new Date(p.from)) / 86400000) + 1)))
      : null,
    fastMoving: moved.slice(0, 10).map((m) => ({
      item: m.item_name, qty: Number(m.qty), amountPaise: Number(m.amount),
      lastSold: m.last_sold,
    })),
    slowMoving: moved.slice(-10).reverse().map((m) => ({
      item: m.item_name, qty: Number(m.qty), amountPaise: Number(m.amount),
      lastSold: m.last_sold,
    })),
    deadStock: {
      count: dead.length,
      valuePaise: deadValue,
      sharePercent: stockValue ? Math.round((deadValue / stockValue) * 1000) / 10 : 0,
      items: dead.slice(0, 20).map((h) => ({
        item: h.name, qty: Number(h.closing_qty),
        valuePaise: Number(h.closing_value_paise),
      })),
      note: `Held, worth something, and not sold once in ${p.label}.`,
    },
    lowStock: value[0].low,
    negativeStock: {
      count: value[0].negative,
      valuePaise: Number(value[0].negative_value),
      /*
       * Negative stock is not a stock problem, it is a data problem: something
       * was sold that was never recorded as bought. Saying so saves the owner
       * looking for missing goods that are physically there.
       */
      note: value[0].negative
        ? 'Something was sold that was never entered as purchased. Check those '
          + 'items in Tally rather than on the shelf.'
        : '',
    },
  };
}

/** Profitability, with every approximation named. */
async function profitability(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'reports', 'read');
  const co = await companyFor(s, tallyGuid);
  const p = period(ctx);

  const { rows } = await query(`
    SELECT
      COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE ${VT.SALES}), 0)::bigint AS sales,
      COALESCE(SUM(abs(v.amount_paise)) FILTER (WHERE ${VT.PURCHASES}), 0)::bigint
        AS purchases
      FROM vouchers v
     WHERE v.company_id = $1 AND v.vch_date BETWEEN $2::date AND $3::date
       AND NOT v.is_cancelled AND NOT v.is_optional`, [co.id, p.from, p.to]);

  /*
   * Expenses and other income come from the ledger's group, which is how Tally
   * classifies them - not from guessing at ledger names.
   */
  const { rows: byGroup } = await query(`
    SELECT
      COALESCE(SUM(abs(e.amount_paise)) FILTER (
        WHERE l.parent_group ILIKE '%indirect exp%'), 0)::bigint AS indirect_expenses,
      -- Anchored, because '%direct exp%' also matches "Indirect Expenses" and
      -- every indirect expense was being counted twice - once in each bucket.
      COALESCE(SUM(abs(e.amount_paise)) FILTER (
        WHERE l.parent_group ILIKE 'direct exp%'), 0)::bigint AS direct_expenses,
      COALESCE(SUM(abs(e.amount_paise)) FILTER (
        WHERE l.parent_group ILIKE 'indirect inc%'), 0)::bigint AS other_income,
      -- Same trap on the income side: "Direct Income" must not swallow
      -- "Indirect Income".
      COALESCE(SUM(abs(e.amount_paise)) FILTER (
        WHERE l.parent_group ILIKE 'direct inc%'), 0)::bigint AS direct_income
      FROM voucher_entries e
      JOIN vouchers v ON v.id = e.voucher_id
      LEFT JOIN ledgers l ON l.company_id = v.company_id AND l.name = e.ledger_name
     WHERE v.company_id = $1 AND v.vch_date BETWEEN $2::date AND $3::date
       AND NOT v.is_cancelled AND NOT v.is_optional`, [co.id, p.from, p.to]);

  const sales = Number(rows[0].sales);
  const purch = Number(rows[0].purchases);
  const indirect = Number(byGroup[0].indirect_expenses);
  const directIncome = Number(byGroup[0].direct_income);
  const direct = Number(byGroup[0].direct_expenses);
  const otherIncome = Number(byGroup[0].other_income);

  const gross = sales - purch - direct;
  const net = gross + otherIncome - indirect;

  return {
    period: p,
    salesPaise: sales,
    purchasesPaise: purch,
    directExpensesPaise: direct,
    indirectExpensesPaise: indirect,
    otherIncomePaise: otherIncome,
    directIncomePaise: directIncome,

    grossProfitPaise: gross,
    grossMarginPercent: sales ? Math.round((gross / sales) * 1000) / 10 : null,
    netProfitPaise: net,
    netMarginPercent: sales ? Math.round((net / sales) * 1000) / 10 : null,
    expenseRatioPercent: sales
      ? Math.round(((direct + indirect) / sales) * 1000) / 10 : null,

    /*
     * The caveat is part of the answer, not a footnote.
     *
     * True gross profit needs opening and closing stock and item cost. This is
     * purchases against sales in the same window, which is trading margin -
     * accurate for a business that buys what it sells within the period, and
     * increasingly wrong the more stock moves between periods.
     */
    basis: 'Trading margin: sales less purchases and direct expenses in the same '
         + 'period. A true gross profit needs opening and closing stock, which '
         + 'Tally holds and Munim does not read. Expect a difference where stock '
         + 'levels changed a lot.',
    reliable: false,
  };
}

/** Everything, for one screen. */
async function all(ctx, tallyGuid) {
  const [s, c, pu, i, pr] = await Promise.all([
    sales(ctx, tallyGuid),
    collection(ctx, tallyGuid),
    purchases(ctx, tallyGuid),
    inventory(ctx, tallyGuid),
    profitability(ctx, tallyGuid),
  ]);
  return { sales: s, collection: c, purchases: pu, inventory: i, profitability: pr };
}

module.exports = { all, sales, collection, purchases, inventory, profitability, period };
