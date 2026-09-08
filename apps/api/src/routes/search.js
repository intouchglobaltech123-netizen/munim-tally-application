'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const VT = require('../lib/vouchertypes');
const { companyFor } = require('./reports');

/**
 * One box that finds anything.
 *
 * The thing that makes a search useful is not how much it covers but how it
 * ranks: an exact match for "Royal Tiles" must beat a voucher whose narration
 * happens to mention it. Everything here is ordered by how well it matched
 * first and by size second, because a shop owner types three letters and
 * expects the obvious answer at the top.
 *
 * What comes back is filtered by permission, not just hidden afterwards - a
 * salesperson searching "cement" must not learn what the shop pays for it.
 */

/**
 * How well a value matched.
 *
 * 0 exact, 1 starts with, 2 contains. Used as the first sort key everywhere,
 * so ranking is one idea rather than a different ORDER BY per query.
 */
/*
 * The column is interpolated and the term is bound.
 *
 * It has to be that way round: a column name is not a value, and binding it
 * compares the literal string "l.name" against the search term - which is
 * always false, so everything ranks equal and the ordering silently does
 * nothing. Every column passed here is a constant in this file.
 */
const rank = (col) => `CASE
  WHEN lower(${col}) = lower($2) THEN 0
  WHEN lower(${col}) LIKE lower($2) || '%' THEN 1
  ELSE 2 END`;

/**
 * Parse an amount filter like "5000", ">10000" or "1,50,000".
 *
 * Returns the operator and the value separately so the caller can bind the
 * number rather than paste it. Only the operator reaches the SQL text, and it
 * is chosen from a fixed set - never taken from the input.
 */
function amountFilter(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const m = /^([<>]=?)?\s*([\d.,]+)$/.exec(t);
  if (!m) return null;
  const paise = Math.round(Number(m[2].replace(/,/g, '')) * 100);
  if (!Number.isFinite(paise)) return null;

  const op = ['<', '<=', '>', '>='].includes(m[1]) ? m[1] : '>=';
  return { op, paise };
}

async function find(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;

  const term = (q.get('q') || '').trim();
  const only = q.get('kind') || '';          // narrow to one kind
  const limit = Math.min(Math.max(parseInt(q.get('limit') ?? '8', 10) || 8, 1), 50);

  // Filters, applied where they make sense for each kind.
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') || '') ? q.get('from') : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.get('to') || '') ? q.get('to') : '';
  const vchType = (q.get('type') || '').trim();
  const status = q.get('status') || '';      // paid | unpaid
  const party = (q.get('party') || '').trim();

  if (term.length < 2 && !from && !to && !vchType && !party) {
    return { q: term, groups: [], total: 0, hint: 'Type at least two letters.' };
  }

  const like = `%${term}%`;
  const can = (m) => perms.can(s, m, 'read');
  const wanted = (kind) => !only || only === kind;

  /*
   * Voucher filters, as SQL plus the values to bind.
   *
   * Built once because a filter that applies to sales but silently not to
   * purchases is worse than one that does not exist - and bound rather than
   * pasted, because every one of these arrives from a query string. Only the
   * comparison operator is ever interpolated, and it comes from a fixed set.
   */
  const amount = amountFilter(q.get('amount'));
  const vchWhere = (args) => {
    let sql = '';
    if (from) sql += ` AND v.vch_date >= $${args.push(from)}::date`;
    if (to) sql += ` AND v.vch_date <= $${args.push(to)}::date`;
    if (vchType) sql += ` AND v.vch_type ILIKE $${args.push(`%${vchType}%`)}`;
    if (party) sql += ` AND v.party ILIKE $${args.push(`%${party}%`)}`;
    if (amount) sql += ` AND abs(v.amount_paise) ${amount.op} $${args.push(amount.paise)}`;
    return sql;
  };

  const jobs = [];

  // --- parties: customers, suppliers, everything else
  if (can('ledgers') && wanted('party')) {
    jobs.push(query(
      `SELECT l.name, l.parent_group, l.closing_paise, l.phone, l.gstin,
              ${rank('l.name')} AS rank,
              CASE WHEN lower(l.parent_group) = 'sundry debtors' THEN 'customer'
                   WHEN lower(l.parent_group) = 'sundry creditors' THEN 'supplier'
                   ELSE 'ledger' END AS kind
         FROM ledgers l
        WHERE l.company_id = $1
          AND (l.name ILIKE $3 OR l.gstin ILIKE $3 OR l.phone ILIKE $3)
        ORDER BY rank, abs(l.closing_paise) DESC LIMIT $4`,
      [co.id, term, like, limit]).then((r) => ({ kind: 'party', rows: r.rows })));
  }

  // --- items
  if (can('inventory') && wanted('item')) {
    jobs.push(query(
      `SELECT i.name, i.unit, i.closing_qty, i.closing_value_paise, i.hsn,
              ${rank('i.name')} AS rank
         FROM stock_items i
        WHERE i.company_id = $1 AND (i.name ILIKE $3 OR i.hsn ILIKE $3)
        ORDER BY rank, i.closing_value_paise DESC LIMIT $4`,
      [co.id, term, like, limit]).then((r) => ({ kind: 'item', rows: r.rows })));
  }

  /*
   * Vouchers, split by what the caller may see.
   *
   * A single query filtered afterwards would leak: a salesperson would get
   * fewer results and could infer the rest existed. Two queries, each gated,
   * cannot.
   */
  const voucherKinds = [
    { kind: 'invoice', module: 'sales', match: VT.SALES },
    { kind: 'purchase', module: 'purchase', match: VT.PURCHASES },
    { kind: 'payment', module: 'cashbank',
      match: `(${VT.RECEIPTS} OR ${VT.PAYMENTS} OR v.vch_type ILIKE '%contra%')` },
    { kind: 'order', module: 'sales',
      match: "(v.vch_type ILIKE '%order%' OR v.vch_type ILIKE '%quot%')" },
  ];

  for (const vk of voucherKinds) {
    if (!can(vk.module) || !wanted(vk.kind)) continue;
    // Each query gets its own argument list, since the filter placeholders
    // continue from wherever the fixed ones ended.
    const args = [co.id, term, like, limit];
    const filters = vchWhere(args);
    jobs.push(query(
      `SELECT v.id, v.vch_no, v.vch_type, v.vch_date::text AS date, v.party,
              abs(v.amount_paise)::bigint AS amount, v.narration,
              ${rank('v.vch_no')} AS rank
         FROM vouchers v
        WHERE v.company_id = $1 AND ${VT.LIVE} AND ${vk.match}
          AND ($3 = '%%' OR v.vch_no ILIKE $3 OR v.party ILIKE $3
               OR v.narration ILIKE $3 OR v.vch_type ILIKE $3)
          ${filters}
        ORDER BY rank, v.vch_date DESC LIMIT $4`, args)
      .then((r) => ({ kind: vk.kind, rows: r.rows })));
  }

  // --- bills, searched by reference and filtered by whether they are settled
  if (can('outstanding') && wanted('bill')) {
    let sql = `SELECT b.ref, b.party, b.bill_date::text AS date,
                      b.due_date::text AS due, b.amount_paise,
                      ${rank('b.ref')} AS rank
                 FROM open_bills b
                WHERE b.company_id = $1 AND (b.ref ILIKE $3 OR b.party ILIKE $3)`;
    // open_bills holds only what is unpaid, so "paid" can match nothing here.
    if (status === 'paid') sql += ' AND false';
    sql += ' ORDER BY rank, b.amount_paise DESC LIMIT $4';
    jobs.push(query(sql, [co.id, term, like, limit])
      .then((r) => ({ kind: 'bill', rows: r.rows })));
  }

  const results = await Promise.all(jobs);

  const money = (p) => Number(p);
  const groups = [];

  for (const r of results) {
    if (!r.rows.length) continue;

    if (r.kind === 'party') {
      // Split into the three things a person actually looks for.
      for (const [kind, label] of [['customer', 'Customers'], ['supplier', 'Suppliers'],
        ['ledger', 'Other ledgers']]) {
        const rows = r.rows.filter((x) => x.kind === kind);
        if (!rows.length) continue;
        groups.push({
          kind, label,
          results: rows.map((x) => ({
            title: x.name,
            subtitle: [x.parent_group, x.gstin, x.phone].filter(Boolean).join(' · '),
            amountPaise: money(x.closing_paise),
            link: { screen: 'party', name: x.name },
          })),
        });
      }
    } else if (r.kind === 'item') {
      groups.push({
        kind: 'item', label: 'Items',
        results: r.rows.map((x) => ({
          title: x.name,
          subtitle: [`${Number(x.closing_qty)} ${x.unit || ''}`.trim(),
            x.hsn && `HSN ${x.hsn}`].filter(Boolean).join(' · '),
          amountPaise: money(x.closing_value_paise),
          link: { screen: 'item', name: x.name },
        })),
      });
    } else if (r.kind === 'bill') {
      groups.push({
        kind: 'bill', label: 'Unpaid bills',
        results: r.rows.map((x) => ({
          title: `${x.ref} — ${x.party}`,
          subtitle: x.due ? `due ${x.due}` : x.date,
          amountPaise: money(x.amount_paise),
          link: { screen: 'party', name: x.party },
        })),
      });
    } else {
      const label = { invoice: 'Sales', purchase: 'Purchases',
        payment: 'Receipts & payments', order: 'Orders & quotations' }[r.kind];
      groups.push({
        kind: r.kind, label,
        results: r.rows.map((x) => ({
          title: `${x.vch_type} ${x.vch_no}`.trim(),
          subtitle: [x.party, x.date, x.narration].filter(Boolean).join(' · ').slice(0, 90),
          amountPaise: money(x.amount),
          link: { screen: 'voucher', id: x.id },
        })),
      });
    }
  }

  const total = groups.reduce((n, g) => n + g.results.length, 0);

  return {
    q: term,
    groups,
    total,
    // Said plainly rather than showing an empty box, which reads as broken.
    hint: total === 0
      ? (term
        ? `Nothing matches "${term}" in what you can see.`
        : 'Nothing matches those filters.')
      : '',
    filters: {
      from, to, type: vchType, status, party,
      amount: q.get('amount') || '',
    },
  };
}

/** The voucher types this company actually uses, for the filter dropdown. */
async function options(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);

  const { rows } = await query(
    `SELECT DISTINCT vch_type AS v FROM vouchers
      WHERE company_id = $1 AND vch_type <> '' ORDER BY 1`, [co.id]);

  return {
    // Offered from the books rather than a fixed list: a shop with a
    // "Counter Sale" voucher type should be able to filter by it.
    voucherTypes: rows.map((r) => r.v),
    kinds: [
      { key: '', label: 'Everything' },
      { key: 'customer', label: 'Customers' },
      { key: 'supplier', label: 'Suppliers' },
      { key: 'item', label: 'Items' },
      { key: 'invoice', label: 'Sales' },
      { key: 'purchase', label: 'Purchases' },
      { key: 'payment', label: 'Receipts & payments' },
      { key: 'order', label: 'Orders & quotations' },
      { key: 'bill', label: 'Unpaid bills' },
    ],
  };
}

module.exports = { find, options, amountFilter };
