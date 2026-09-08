'use strict';
const { query } = require('../db');
const VT = require('../lib/vouchertypes');
const { bad } = require('../lib/http');
const auth = require('../lib/auth');
const { companyFor } = require('./reports');

/**
 * The accounting statements: Day Book, Trial Balance, Profit & Loss, Balance
 * Sheet, plus the analysis reports.
 *
 * All of them are the same ledger tree rolled up different ways, so they share
 * one classification: account_nature(parent_group), defined in migration 004.
 *
 * Money stays integer paise all the way to the client. Debit is positive here,
 * matching how the connector normalises Tally (which signs Debit negative).
 */

const asOfDate = async (companyId) => {
  const { rows } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [companyId]);
  return rows[0].d;
};

/** Day Book - every voucher on one date, the way a shop owner checks the day. */
async function dayBook(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);
  const date = ctx.url.searchParams.get('date') || (await asOfDate(co.id));

  const { rows } = await query(
    `SELECT vch_no, vch_type, party, amount_paise, narration, is_cancelled
       FROM vouchers
      WHERE company_id = $1 AND vch_date = $2::date
      ORDER BY vch_type, vch_no`,
    [co.id, date],
  );

  const byType = {};
  for (const r of rows) {
    if (r.is_cancelled) continue;
    byType[r.vch_type] = (byType[r.vch_type] || 0) + Math.abs(Number(r.amount_paise));
  }

  return {
    date: typeof date === 'string' ? date : date.toISOString().slice(0, 10),
    totalsByType: byType,
    count: rows.length,
    vouchers: rows.map((r) => ({
      vchNo: r.vch_no, vchType: r.vch_type, party: r.party,
      amountPaise: Number(r.amount_paise), narration: r.narration,
      isCancelled: r.is_cancelled,
    })),
  };
}

/**
 * Trial Balance. Debit and credit columns must be equal - if they are not, the
 * sync is incomplete, and showing that plainly is more useful than hiding it.
 */
async function trialBalance(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);

  // Tally maintains "Profit & Loss A/c" itself, holding the same figure the
  // income groups already carry. Counting both double-counts the profit and
  // the trial balance never balances - Tally excludes it for the same reason.
  const { rows } = await query(
    `SELECT parent_group AS grp,
            account_nature(parent_group) AS nature,
            SUM(closing_paise) AS closing
       FROM ledgers
      WHERE company_id = $1
        AND lower(name) NOT IN ('profit & loss a/c', 'profit and loss a/c')
      GROUP BY parent_group
     HAVING SUM(closing_paise) <> 0
      ORDER BY parent_group`,
    [co.id],
  );

  let debit = 0, credit = 0;
  const groups = rows.map((r) => {
    const c = Number(r.closing);
    if (c >= 0) debit += c; else credit += -c;
    return { group: r.grp, nature: r.nature, closingPaise: c };
  });

  return {
    groups,
    totals: { debitPaise: debit, creditPaise: credit, differencePaise: debit - credit },
    balanced: debit === credit,
  };
}

/** Profit & Loss: income less expenses, from the ledger tree. */
async function profitAndLoss(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);

  const { rows } = await query(
    `SELECT account_nature(parent_group) AS nature, parent_group AS grp,
            SUM(closing_paise) AS closing
       FROM ledgers
      WHERE company_id = $1 AND account_nature(parent_group) IN ('income','expense')
      GROUP BY nature, parent_group ORDER BY nature, parent_group`,
    [co.id],
  );

  // Income sits credit-side, so its stored closing is negative. Flip it so the
  // report reads the way an owner expects: income positive, expenses positive.
  const income = [], expense = [];
  let totalIncome = 0, totalExpense = 0;
  for (const r of rows) {
    const v = Number(r.closing);
    if (r.nature === 'income') {
      const amt = -v;
      income.push({ group: r.grp, amountPaise: amt });
      totalIncome += amt;
    } else {
      expense.push({ group: r.grp, amountPaise: v });
      totalExpense += v;
    }
  }

  return {
    income, expense,
    totals: {
      incomePaise: totalIncome,
      expensePaise: totalExpense,
      profitPaise: totalIncome - totalExpense,
    },
  };
}

/** Balance Sheet: assets against liabilities, with profit carried in. */
async function balanceSheet(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);

  const { rows } = await query(
    `SELECT account_nature(parent_group) AS nature, parent_group AS grp,
            SUM(closing_paise) AS closing
       FROM ledgers
      WHERE company_id = $1 AND account_nature(parent_group) IN ('asset','liability')
      GROUP BY nature, parent_group ORDER BY nature, parent_group`,
    [co.id],
  );

  const assets = [], liabilities = [];
  let totalAssets = 0, totalLiabilities = 0;
  for (const r of rows) {
    const v = Number(r.closing);
    if (r.nature === 'asset') {
      assets.push({ group: r.grp, amountPaise: v });
      totalAssets += v;
    } else {
      liabilities.push({ group: r.grp, amountPaise: -v });
      totalLiabilities += -v;
    }
  }

  const pl = await profitAndLoss(ctx, guid);
  const profit = pl.totals.profitPaise;

  return {
    assets, liabilities,
    profitPaise: profit,
    totals: {
      assetsPaise: totalAssets,
      liabilitiesPaise: totalLiabilities + profit,
      differencePaise: totalAssets - (totalLiabilities + profit),
    },
  };
}

/** Expenses, largest first - the second thing an owner looks at after sales. */
async function expenses(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);
  const { rows } = await query(
    `SELECT name, parent_group, closing_paise
       FROM ledgers
      WHERE company_id = $1 AND account_nature(parent_group) = 'expense'
        AND closing_paise <> 0
      ORDER BY closing_paise DESC LIMIT 100`,
    [co.id],
  );
  return {
    items: rows.map((r) => ({
      name: r.name, group: r.parent_group, amountPaise: Number(r.closing_paise),
    })),
    totalPaise: rows.reduce((n, r) => n + Number(r.closing_paise), 0),
  };
}

/** Sales analysis, grouped by month, party or item. */
async function salesAnalysis(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);
  const groupBy = ctx.url.searchParams.get('groupBy') || 'month';

  let sql;
  if (groupBy === 'party') {
    sql = `SELECT party AS label, SUM(abs(amount_paise))::bigint AS amount,
                  count(*)::int AS count
             FROM vouchers
            WHERE company_id = $1 AND ${VT.sales('')}
              AND NOT is_cancelled AND party <> ''
            GROUP BY party ORDER BY amount DESC LIMIT 50`;
  } else if (groupBy === 'item') {
    sql = `SELECT i.item_name AS label, SUM(abs(i.amount_paise))::bigint AS amount,
                  count(*)::int AS count
             FROM voucher_items i JOIN vouchers v ON v.id = i.voucher_id
            WHERE v.company_id = $1 AND ${VT.sales('v')}
              AND NOT v.is_cancelled AND i.item_name <> ''
            GROUP BY i.item_name ORDER BY amount DESC LIMIT 50`;
  } else {
    sql = `SELECT to_char(vch_date,'YYYY-MM') AS label,
                  SUM(abs(amount_paise))::bigint AS amount, count(*)::int AS count
             FROM vouchers
            WHERE company_id = $1 AND ${VT.sales('')}
              AND NOT is_cancelled AND vch_date IS NOT NULL
            GROUP BY label ORDER BY label`;
  }

  const { rows } = await query(sql, [co.id]);
  return {
    groupBy,
    rows: rows.map((r) => ({ label: r.label, amountPaise: Number(r.amount), count: r.count })),
    totalPaise: rows.reduce((n, r) => n + Number(r.amount), 0),
  };
}

/**
 * Customers and items that have gone quiet. This is the report that turns a
 * dashboard into a reason to open the app: a customer who stopped buying is
 * revenue you can still win back.
 */
async function inactive(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);
  const days = Math.max(1, Number(ctx.url.searchParams.get('days')) || 90);
  const asOf = await asOfDate(co.id);

  const { rows: parties } = await query(
    `SELECT l.name, l.phone, l.closing_paise,
            (SELECT max(v.vch_date) FROM vouchers v
              WHERE v.company_id = $1 AND v.party = l.name AND NOT v.is_cancelled) AS last_seen
       FROM ledgers l
      WHERE l.company_id = $1 AND lower(l.parent_group) = 'sundry debtors'`,
    [co.id],
  );

  const { rows: items } = await query(
    `SELECT s.name,
            (SELECT max(v.vch_date)
               FROM voucher_items i JOIN vouchers v ON v.id = i.voucher_id
              WHERE v.company_id = $1 AND i.item_name = s.name AND NOT v.is_cancelled) AS last_sold
       FROM stock_items s WHERE s.company_id = $1`,
    [co.id],
  );

  const cutoff = new Date(asOf);
  cutoff.setDate(cutoff.getDate() - days);
  const daysSince = (d) => (d ? Math.floor((new Date(asOf) - new Date(d)) / 86400000) : null);

  return {
    days,
    asOf: typeof asOf === 'string' ? asOf : asOf.toISOString().slice(0, 10),
    parties: parties
      .filter((p) => !p.last_seen || new Date(p.last_seen) < cutoff)
      .map((p) => ({
        name: p.name, phone: p.phone || '',
        outstandingPaise: Number(p.closing_paise),
        lastSeen: p.last_seen, daysSince: daysSince(p.last_seen),
      }))
      .sort((a, b) => (b.daysSince ?? 1e9) - (a.daysSince ?? 1e9)),
    items: items
      .filter((i) => !i.last_sold || new Date(i.last_sold) < cutoff)
      .map((i) => ({ name: i.name, lastSold: i.last_sold, daysSince: daysSince(i.last_sold) }))
      .sort((a, b) => (b.daysSince ?? 1e9) - (a.daysSince ?? 1e9)),
  };
}

/** Stock summary - quantity and value on hand. */
async function stock(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);
  const { rows } = await query(
    `SELECT name, unit, closing_qty, closing_value_paise
       FROM stock_items WHERE company_id = $1
      ORDER BY closing_value_paise DESC LIMIT 200`,
    [co.id],
  );
  return {
    items: rows.map((r) => ({
      name: r.name, unit: r.unit, qty: Number(r.closing_qty),
      valuePaise: Number(r.closing_value_paise),
    })),
    totalValuePaise: rows.reduce((n, r) => n + Number(r.closing_value_paise), 0),
  };
}

/** Party-wise sales AND purchases side by side. */
async function partyWise(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);
  const { rows } = await query(
    `SELECT v.party AS name,
            SUM(abs(v.amount_paise)) FILTER (WHERE ${VT.sales('v')})::bigint     AS sales,
            SUM(abs(v.amount_paise)) FILTER (WHERE ${VT.purchases('v')})::bigint AS purchases,
            max(v.vch_date) AS last_txn
       FROM vouchers v
      WHERE v.company_id = $1 AND NOT v.is_cancelled AND v.party <> ''
      GROUP BY v.party ORDER BY COALESCE(SUM(abs(v.amount_paise)),0) DESC LIMIT 100`,
    [co.id],
  );
  return {
    rows: rows.map((r) => ({
      name: r.name,
      salesPaise: Number(r.sales || 0),
      purchasesPaise: Number(r.purchases || 0),
      lastTxn: r.last_txn,
    })),
  };
}


/**
 * Cash and bank, right now.
 *
 * "How much money do I actually have" is the first question a shop owner asks,
 * and no other report answers it: the Balance Sheet buries it under assets, and
 * the dashboard shows sales, which is not the same thing at all.
 *
 * Bank overdraft is a liability and carries the opposite sign, so it is listed
 * separately rather than netted silently into the total.
 */
async function cashAndBank(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);

  const { rows } = await query(
    `SELECT name, parent_group, closing_paise::bigint AS closing
       FROM ledgers
      WHERE company_id = $1
        AND (parent_group ILIKE '%cash%'
          OR parent_group ILIKE '%bank%')
      ORDER BY abs(closing_paise) DESC`,
    [co.id],
  );

  const isOverdraft = (g) => /od|overdraft/i.test(g);
  const accounts = rows.map((r) => ({
    name: r.name,
    group: r.parent_group.trim(),
    balancePaise: Number(r.closing),
    kind: /cash/i.test(r.parent_group) ? 'cash'
      : isOverdraft(r.parent_group) ? 'overdraft' : 'bank',
  }));

  const sum = (kind) => accounts.filter((a) => a.kind === kind)
    .reduce((n, a) => n + a.balancePaise, 0);

  return {
    asOf: await asOfDate(co.id),
    accounts,
    cashPaise: sum('cash'),
    bankPaise: sum('bank'),
    overdraftPaise: sum('overdraft'),
    // What is genuinely available, overdraft excluded.
    totalPaise: sum('cash') + sum('bank'),
  };
}

/**
 * Purchases, the mirror of sales analysis.
 *
 * Sales alone tell you turnover; a shop owner also needs to know where the
 * money went and which supplier holds the most of it.
 */
async function purchaseAnalysis(ctx, guid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, guid);
  const groupBy = ctx.url.searchParams.get('groupBy') || 'month';

  let sql;
  if (groupBy === 'party') {
    sql = `SELECT party AS label, SUM(abs(amount_paise))::bigint AS amount,
                  count(*)::int AS count
             FROM vouchers
            WHERE company_id = $1 AND ${VT.purchases('')}
              AND NOT is_cancelled AND party <> ''
            GROUP BY party ORDER BY amount DESC LIMIT 50`;
  } else if (groupBy === 'item') {
    sql = `SELECT i.item_name AS label, SUM(abs(i.amount_paise))::bigint AS amount,
                  count(*)::int AS count
             FROM voucher_items i JOIN vouchers v ON v.id = i.voucher_id
            WHERE v.company_id = $1 AND ${VT.purchases('v')}
              AND NOT v.is_cancelled AND i.item_name <> ''
            GROUP BY i.item_name ORDER BY amount DESC LIMIT 50`;
  } else {
    sql = `SELECT to_char(vch_date,'YYYY-MM') AS label,
                  SUM(abs(amount_paise))::bigint AS amount, count(*)::int AS count
             FROM vouchers
            WHERE company_id = $1 AND ${VT.purchases('')}
              AND NOT is_cancelled AND vch_date IS NOT NULL
            GROUP BY label ORDER BY label`;
  }

  const { rows } = await query(sql, [co.id]);
  return {
    groupBy,
    rows: rows.map((r) => ({ label: r.label, amountPaise: Number(r.amount), count: r.count })),
    totalPaise: rows.reduce((n, r) => n + Number(r.amount), 0),
  };
}

module.exports = {
  cashAndBank, purchaseAnalysis,
  dayBook, trialBalance, profitAndLoss, balanceSheet, expenses,
  salesAnalysis, inactive, stock, partyWise,
};
