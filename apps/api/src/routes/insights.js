'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const VT = require('../lib/vouchertypes');
const { companyFor } = require('./reports');

/**
 * The numbers a shop owner acts on, as opposed to the numbers an accountant
 * reconciles.
 *
 * The statements answer "are the books right". These answer "what should I do
 * today" - who has gone quiet, what is about to come in, which customer matters
 * most, what is not selling. That is the difference between a product somebody
 * opens at month end and one they open every morning.
 */

const asOf = async (companyId) => {
  const { rows } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [companyId]);
  return rows[0].d;
};

/**
 * Receivables ageing, in the buckets Indian credit terms actually use.
 *
 * 45-day steps rather than 30: Indian trade credit is commonly 30, 45 or 60
 * days, so 30-day buckets split a single credit period across two columns and
 * make everything look overdue. The last bucket is open-ended because anything
 * past 225 days is the same conversation.
 */
const BUCKETS = [
  { key: '0-45', from: 0, to: 45 },
  { key: '45-90', from: 45, to: 90 },
  { key: '90-135', from: 90, to: 135 },
  { key: '135-180', from: 135, to: 180 },
  { key: '180-225', from: 180, to: 225 },
  { key: '225+', from: 225, to: null },
];

async function ageing(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const d = await asOf(co.id);

  // effective_due() falls back from the bill's own date to the party's credit
  // terms - Tally does not echo a credit period on every bill.
  const cases = BUCKETS.map((b, i) => {
    const age = `($1::date - effective_due(b.due_date, b.bill_date, l.credit_days))`;
    const cond = b.to === null ? `${age} > ${b.from}` : `${age} > ${b.from} AND ${age} <= ${b.to}`;
    return `COALESCE(SUM(b.amount_paise) FILTER (WHERE ${cond}), 0)::bigint AS b${i}`;
  }).join(',\n           ');

  const { rows } = await query(
    `SELECT ${cases},
            COALESCE(SUM(b.amount_paise), 0)::bigint AS total,
            COALESCE(SUM(b.amount_paise) FILTER (
              WHERE $1::date > effective_due(b.due_date, b.bill_date, l.credit_days)), 0)::bigint AS overdue
       FROM open_bills b
       LEFT JOIN ledgers l ON l.company_id = b.company_id AND l.name = b.party
      WHERE b.company_id = $2`,
    [d, co.id]);

  const r = rows[0];
  return {
    asOf: d,
    buckets: BUCKETS.map((b, i) => ({ label: b.key, amountPaise: Number(r[`b${i}`]) })),
    totalPaise: Number(r.total),
    overduePaise: Number(r.overdue),
  };
}

/**
 * What is due to arrive in the next 15 and 60 days.
 *
 * The figure that decides whether a shop can pay a supplier on Friday. Based on
 * each bill's effective due date, so it reflects the terms actually given
 * rather than an average.
 */
async function projections(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const d = await asOf(co.id);

  const { rows } = await query(
    `WITH due AS (
       SELECT b.amount_paise,
              effective_due(b.due_date, b.bill_date, l.credit_days) AS due
         FROM open_bills b
         LEFT JOIN ledgers l ON l.company_id = b.company_id AND l.name = b.party
        WHERE b.company_id = $2
     )
     SELECT COALESCE(SUM(amount_paise) FILTER (
              WHERE due > $1::date AND due <= $1::date + 15), 0)::bigint AS d15,
            COALESCE(SUM(amount_paise) FILTER (
              WHERE due > $1::date AND due <= $1::date + 60), 0)::bigint AS d60,
            COALESCE(SUM(amount_paise) FILTER (WHERE due <= $1::date), 0)::bigint AS overdue
       FROM due`,
    [d, co.id]);

  const r = rows[0];
  return {
    asOf: d,
    next15Paise: Number(r.d15),
    next60Paise: Number(r.d60),
    overduePaise: Number(r.overdue),
  };
}

/**
 * The things that need a decision.
 *
 * Deliberately a list of problems rather than a list of figures - a customer
 * who stopped buying, a bill that cannot be chased because there is no phone
 * number. Each one is revenue or effort leaking, and none of it shows up
 * anywhere else in the product.
 */
async function attention(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const d = await asOf(co.id);
  const quietDays = Math.min(Math.max(
    parseInt(ctx.url.searchParams.get('days') ?? '90', 10) || 90, 7), 365);

  const [quiet, noContact, deadStock, negative, overdue] = await Promise.all([
    // Customers who used to buy and have gone quiet.
    query(
      `SELECT count(*)::int AS n
         FROM ledgers l
        WHERE l.company_id = $1 AND lower(l.parent_group) = 'sundry debtors'
          AND EXISTS (SELECT 1 FROM vouchers v
                       WHERE v.company_id = l.company_id AND v.party = l.name)
          AND NOT EXISTS (SELECT 1 FROM vouchers v
                           WHERE v.company_id = l.company_id AND v.party = l.name
                             AND v.vch_date > $2::date - $3::int)`,
      [co.id, d, quietDays]),

    // Money owed by somebody there is no way to contact. A reminder feature is
    // worth nothing without these.
    query(
      `SELECT count(*)::int AS n,
              COALESCE(SUM(l.closing_paise),0)::bigint AS amount
         FROM ledgers l
        WHERE l.company_id = $1 AND lower(l.parent_group) = 'sundry debtors'
          AND l.closing_paise > 0 AND coalesce(l.phone,'') = ''`,
      [co.id]),

    // Stock sitting still: held, but not sold in the window.
    query(
      `SELECT count(*)::int AS n, COALESCE(SUM(si.closing_value_paise),0)::bigint AS value
         FROM stock_items si
        WHERE si.company_id = $1 AND si.closing_qty > 0
          AND NOT EXISTS (
            SELECT 1 FROM voucher_items vi
              JOIN vouchers v ON v.id = vi.voucher_id
             WHERE v.company_id = si.company_id AND vi.item_name = si.name
               AND v.vch_date > $2::date - $3::int)`,
      [co.id, d, quietDays]),

    query(
      `SELECT count(*)::int AS n FROM stock_items
        WHERE company_id = $1 AND closing_qty < 0`, [co.id]),

    query(
      `SELECT count(DISTINCT b.party)::int AS n,
              COALESCE(SUM(b.amount_paise),0)::bigint AS amount
         FROM open_bills b
         LEFT JOIN ledgers l ON l.company_id = b.company_id AND l.name = b.party
        WHERE b.company_id = $1
          AND $2::date > effective_due(b.due_date, b.bill_date, l.credit_days)`,
      [co.id, d]),
  ]);

  return {
    asOf: d,
    quietDays,
    items: [
      { key: 'overdue', label: 'Parties overdue',
        count: overdue.rows[0].n, amountPaise: Number(overdue.rows[0].amount),
        tone: overdue.rows[0].n > 0 ? 'bad' : 'ok',
        hint: 'Money past its due date. Chase these first.' },
      { key: 'quiet', label: 'Customers gone quiet',
        count: quiet.rows[0].n, amountPaise: null, tone: quiet.rows[0].n > 0 ? 'warn' : 'ok',
        hint: `Bought before, nothing in ${quietDays} days.` },
      { key: 'no-contact', label: 'Owed, but no phone number',
        count: noContact.rows[0].n, amountPaise: Number(noContact.rows[0].amount),
        tone: noContact.rows[0].n > 0 ? 'warn' : 'ok',
        hint: 'You cannot send a reminder without one.' },
      { key: 'dead-stock', label: 'Stock not moving',
        count: deadStock.rows[0].n, amountPaise: Number(deadStock.rows[0].value),
        tone: deadStock.rows[0].n > 0 ? 'warn' : 'ok',
        hint: `Held, but nothing sold in ${quietDays} days.` },
      { key: 'negative-stock', label: 'Negative stock',
        count: negative.rows[0].n, amountPaise: null,
        tone: negative.rows[0].n > 0 ? 'bad' : 'ok',
        hint: 'Sales recorded with no matching purchase.' },
    ],
  };
}

/**
 * Rankings: who and what actually makes the money.
 *
 * `by` chooses the dimension, so one endpoint answers "top customers", "top
 * items", "top suppliers" and "which voucher types" - the same reason the
 * transaction browser is one screen.
 */
async function top(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;
  const by = q.get('by') || 'customer';
  const limit = Math.min(Math.max(parseInt(q.get('limit') ?? '10', 10) || 10, 1), 50);
  const days = Math.min(Math.max(parseInt(q.get('days') ?? '365', 10) || 365, 7), 3650);
  const d = await asOf(co.id);

  const SHAPES = {
    customer: {
      label: 'Top customers',
      sql: `SELECT v.party AS label, SUM(abs(v.amount_paise))::bigint AS amount,
                   count(*)::int AS count
              FROM vouchers v
             WHERE v.company_id = $1 AND v.vch_date > $2::date - $3::int
               AND ${VT.SALES}
               AND NOT v.is_cancelled AND v.party <> ''
             GROUP BY v.party ORDER BY amount DESC LIMIT ${limit}`,
    },
    supplier: {
      label: 'Top suppliers',
      sql: `SELECT v.party AS label, SUM(abs(v.amount_paise))::bigint AS amount,
                   count(*)::int AS count
              FROM vouchers v
             WHERE v.company_id = $1 AND v.vch_date > $2::date - $3::int
               AND ${VT.PURCHASES}
               AND NOT v.is_cancelled AND v.party <> ''
             GROUP BY v.party ORDER BY amount DESC LIMIT ${limit}`,
    },
    item: {
      label: 'Top selling items',
      sql: `SELECT vi.item_name AS label, SUM(abs(vi.amount_paise))::bigint AS amount,
                   count(*)::int AS count
              FROM voucher_items vi JOIN vouchers v ON v.id = vi.voucher_id
             WHERE v.company_id = $1 AND v.vch_date > $2::date - $3::int
               AND ${VT.sales('v')} AND NOT v.is_cancelled
               AND vi.item_name <> ''
             GROUP BY vi.item_name ORDER BY amount DESC LIMIT ${limit}`,
    },
    group: {
      label: 'Sales by ledger group',
      sql: `SELECT COALESCE(NULLIF(l.parent_group,''),'Ungrouped') AS label,
                   SUM(abs(v.amount_paise))::bigint AS amount, count(*)::int AS count
              FROM vouchers v
              LEFT JOIN ledgers l ON l.company_id = v.company_id AND l.name = v.party
             WHERE v.company_id = $1 AND v.vch_date > $2::date - $3::int
               AND ${VT.sales('v')} AND NOT v.is_cancelled
             GROUP BY label ORDER BY amount DESC LIMIT ${limit}`,
    },
    'voucher-type': {
      label: 'By voucher type',
      sql: `SELECT v.vch_type AS label, SUM(abs(v.amount_paise))::bigint AS amount,
                   count(*)::int AS count
              FROM vouchers v
             WHERE v.company_id = $1 AND v.vch_date > $2::date - $3::int
               AND NOT v.is_cancelled
             GROUP BY v.vch_type ORDER BY amount DESC LIMIT ${limit}`,
    },
    debtor: {
      label: 'Who owes you most',
      sql: `SELECT l.name AS label, l.closing_paise::bigint AS amount, 0 AS count
              FROM ledgers l
             WHERE l.company_id = $1 AND lower(l.parent_group) = 'sundry debtors'
               AND l.closing_paise > 0
             ORDER BY l.closing_paise DESC LIMIT ${limit}`,
    },
  };

  const shape = SHAPES[by] ?? SHAPES.customer;
  const params = by === 'debtor' ? [co.id] : [co.id, d, days];
  const { rows } = await query(shape.sql, params);
  const total = rows.reduce((n, r) => n + Number(r.amount), 0);

  return {
    by, label: shape.label, days, asOf: d, totalPaise: total,
    rows: rows.map((r) => ({
      label: r.label, amountPaise: Number(r.amount), count: r.count,
      sharePct: total > 0 ? Math.round((Number(r.amount) / total) * 1000) / 10 : 0,
    })),
  };
}

/**
 * Sales this period against the one before, at three horizons.
 *
 * A single number tells nobody anything. Week, month and quarter together show
 * whether a bad week is a blip or a trend - which is the actual question.
 */
async function trends(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const d = await asOf(co.id);

  const windows = [7, 30, 90];
  const parts = windows.map((n, i) => `
    COALESCE(SUM(amt) FILTER (WHERE vch_date > $1::date - ${n}), 0)::bigint AS cur${i},
    COALESCE(SUM(amt) FILTER (WHERE vch_date <= $1::date - ${n}
                                AND vch_date > $1::date - ${n * 2}), 0)::bigint AS prev${i}`).join(',');

  const { rows } = await query(
    `WITH s AS (
       SELECT vch_date, abs(amount_paise) AS amt
         FROM vouchers
        WHERE company_id = $2 AND ${VT.sales('')}
          AND vch_type NOT ILIKE '%return%' AND NOT is_cancelled
     )
     SELECT ${parts} FROM s`, [d, co.id]);

  const r = rows[0];
  // null, not Infinity: a period with no prior sales has no percentage, and a
  // dashboard showing "Infinity%" is a bug report.
  const pct = (a, b) => (Number(b) === 0 ? (Number(a) === 0 ? 0 : null)
    : Math.round(((Number(a) - Number(b)) / Number(b)) * 1000) / 10);

  return {
    asOf: d,
    windows: windows.map((n, i) => ({
      days: n,
      amountPaise: Number(r[`cur${i}`]),
      prevPaise: Number(r[`prev${i}`]),
      changePct: pct(r[`cur${i}`], r[`prev${i}`]),
    })),
  };
}

module.exports = { ageing, projections, attention, top, trends };
