'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const VT = require('../lib/vouchertypes');
const { bad, notFound } = require('../lib/http');
const { companyFor } = require('./reports');

/**
 * Browsing transactions.
 *
 * Sales, Purchase, Credit Note, Debit Note, Receipt, Payment, Cash and Bank are
 * not eight features - they are one screen with a different filter. Each is a
 * list of vouchers you roll up (by month, by party, by type), drill into, and
 * finally open one of. Writing that eight times would guarantee eight slightly
 * different behaviours.
 *
 * So this is one endpoint with a voucher-type filter, and the navigation
 * decides which filter to send.
 */

/**
 * Which Tally voucher types belong to each section.
 *
 * Matched with ILIKE because Tally lets a company rename and duplicate voucher
 * types - "Sales", "GST Sales", "Retail Sales" all exist in real books, and a
 * customer whose type is called "Tax Invoice" should still see their sales.
 */
const SECTIONS = {
  sales:        { label: 'Sales',        match: ['%sale%'],
                  exclude: ['%return%', '%order%', '%quot%'] },
  'credit-note':{ label: 'Credit Note',  match: ['%credit note%', '%sales return%'] },
  purchase:     { label: 'Purchase',     match: ['%purchase%'],
                  exclude: ['%return%', '%order%'] },
  'debit-note': { label: 'Debit Note',   match: ['%debit note%', '%purchase return%'] },
  receipt:      { label: 'Receipt',      match: ['%receipt%'], exclude: ['%receipt note%'] },
  payment:      { label: 'Payment',      match: ['%payment%'] },
  contra:       { label: 'Contra',       match: ['%contra%'] },
  journal:      { label: 'Journal',      match: ['%journal%'] },

  /*
   * Commitments, not trade.
   *
   * Kept as their own sections rather than folded into Sales and Purchase,
   * because an order is a promise and an invoice is money. A screen that mixes
   * them tells an owner they have earned something they have not.
   */
  quotation:      { label: 'Quotation',      match: ['%quot%'] },
  'sales-order':  { label: 'Sales Order',    match: ['%sales order%', '%sale order%'] },
  'purchase-order': { label: 'Purchase Order', match: ['%purchase order%'] },
  'delivery-note':{ label: 'Delivery Note',  match: ['%delivery note%'] },
  'receipt-note': { label: 'Receipt Note',   match: ['%receipt note%'] },

  all:          { label: 'All vouchers', match: ['%'] },
};

/** Which sections are commitments rather than completed trade. */
const COMMITMENT = new Set([
  'quotation', 'sales-order', 'purchase-order', 'delivery-note', 'receipt-note',
]);

const sectionList = () =>
  Object.entries(SECTIONS).map(([key, v]) => ({
    key, label: v.label, commitment: COMMITMENT.has(key),
  }));

/** Builds the WHERE fragment for a section, plus its parameters. */
function sectionWhere(section, params) {
  const s = SECTIONS[section];
  if (!s) throw bad('BAD_SECTION', 'No such section.');

  const ors = s.match.map((m) => { params.push(m); return `v.vch_type ILIKE $${params.length}`; });
  let sql = `(${ors.join(' OR ')})`;

  // "Sales" must not silently include "Sales Return" - they move money the
  // other way, and a total that mixes them is wrong rather than approximate.
  for (const ex of s.exclude ?? []) {
    params.push(ex);
    sql += ` AND v.vch_type NOT ILIKE $${params.length}`;
  }
  return sql;
}

/** The financial year a date falls in. India runs 1 April - 31 March. */
function financialYear(d = new Date()) {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
}

function range(ctx) {
  const q = ctx.url.searchParams;
  const fy = financialYear();
  const from = q.get('from') || fy.from;
  const to = q.get('to') || fy.to;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw bad('BAD_DATE', 'Dates must look like 2026-04-01.');
  }
  return { from, to };
}

/**
 * A section, rolled up or listed flat.
 *
 * groupBy=month|party|type gives the summary a shop owner opens first;
 * groupBy=none gives the vouchers themselves. Same filters either way, so the
 * totals always agree with the list underneath them - which is the bug that
 * separate endpoints would eventually produce.
 */
async function list(ctx, tallyGuid, section) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;

  const { from, to } = range(ctx);
  const groupBy = q.get('groupBy') || 'month';
  const search = (q.get('q') || '').trim();
  const limit = Math.min(Math.max(parseInt(q.get('limit') ?? '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q.get('offset') ?? '0', 10) || 0, 0);

  const params = [co.id, from, to];
  let where = `v.company_id = $1 AND v.vch_date BETWEEN $2 AND $3
               AND NOT v.is_cancelled AND NOT v.is_optional`;
  where += ' AND ' + sectionWhere(section, params);

  if (search) {
    params.push(`%${search}%`);
    where += ` AND (v.party ILIKE $${params.length} OR v.vch_no ILIKE $${params.length}
                    OR v.narration ILIKE $${params.length})`;
  }

  // One total for the whole section, independent of paging - a header that
  // changes as you turn pages is a header nobody trusts.
  const { rows: totals } = await query(
    `SELECT COALESCE(SUM(abs(v.amount_paise)),0)::bigint AS total,
            count(*)::int AS count
       FROM vouchers v WHERE ${where}`, params);

  if (groupBy === 'none') {
    const { rows } = await query(
      `SELECT v.id, v.vch_no, v.vch_date::text AS date, v.party, v.vch_type,
              abs(v.amount_paise)::bigint AS amount, v.narration
         FROM vouchers v WHERE ${where}
        ORDER BY v.vch_date DESC, v.vch_no DESC
        LIMIT ${limit} OFFSET ${offset}`, params);

    return {
      section, label: SECTIONS[section].label, groupBy, from, to,
      totalPaise: Number(totals[0].total), count: totals[0].count,
      rows: rows.map((r) => ({
        id: r.id, vchNo: r.vch_no, date: r.date, party: r.party,
        vchType: r.vch_type, amountPaise: Number(r.amount), narration: r.narration,
      })),
      page: { limit, offset, hasMore: offset + rows.length < totals[0].count },
    };
  }

  const by = {
    month: { sql: "to_char(v.vch_date,'YYYY-MM')", order: 'label DESC' },
    party: { sql: 'v.party', order: 'amount DESC' },
    type:  { sql: 'v.vch_type', order: 'amount DESC' },
  }[groupBy];
  if (!by) throw bad('BAD_GROUP', 'Group by month, party, type or none.');

  const { rows } = await query(
    `SELECT ${by.sql} AS label,
            COALESCE(SUM(abs(v.amount_paise)),0)::bigint AS amount,
            count(*)::int AS count
       FROM vouchers v WHERE ${where}
      GROUP BY label HAVING ${by.sql} <> ''
      ORDER BY ${by.order}
      LIMIT ${limit} OFFSET ${offset}`, params);

  return {
    section, label: SECTIONS[section].label, groupBy, from, to,
    totalPaise: Number(totals[0].total), count: totals[0].count,
    rows: rows.map((r) => ({
      label: r.label, amountPaise: Number(r.amount), count: r.count,
    })),
    page: { limit, offset, hasMore: rows.length === limit },
  };
}

/**
 * One voucher, in full.
 *
 * Items come from Tally's inventory lines; the tax breakup is derived from the
 * ledger legs rather than stored separately, because that is where Tally
 * actually keeps it - a voucher's CGST is a posting to a ledger named CGST, and
 * reading it any other way means guessing.
 */
async function detail(ctx, tallyGuid, voucherId) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);

  const { rows } = await query(
    `SELECT v.*, v.vch_date::text AS date_text
       FROM vouchers v WHERE v.id = $1 AND v.company_id = $2`,
    [voucherId, co.id]);
  if (!rows.length) throw notFound('No such voucher.');
  const v = rows[0];

  const [items, entries, bills, settlement] = await Promise.all([
    query(`SELECT item_name, qty, rate_paise, amount_paise
             FROM voucher_items WHERE voucher_id = $1 ORDER BY item_name`, [v.id]),
    query(`SELECT ledger_name, amount_paise
             FROM voucher_entries WHERE voucher_id = $1`, [v.id]),
    query(`SELECT ref, bill_date::text AS bill_date, due_date::text AS due_date,
                  amount_paise, bill_type
             FROM bills WHERE voucher_id = $1`, [v.id]),

    /*
     * How much of this invoice has actually been paid.
     *
     * Tally records a receipt as an "Agst Ref" bill row against the SAME
     * reference, carrying a negative amount. So the outstanding balance for an
     * invoice is the sum of every bill row sharing its reference - the
     * original plus every settlement against it.
     *
     * Computed here rather than left to the client because "is this paid" is
     * the first question asked of any invoice, and every screen must answer it
     * the same way.
     */
    query(
      `SELECT b.ref,
              COALESCE(SUM(all_b.amount_paise), 0)::bigint AS outstanding
         FROM bills b
         JOIN bills all_b ON all_b.company_id = b.company_id AND all_b.ref = b.ref
        WHERE b.voucher_id = $1
        GROUP BY b.ref`, [v.id]),
  ]);

  // A ledger leg is tax when it posts to a ledger named like one. Crude, and
  // exactly how a person reads a Tally voucher.
  const isTax = (n) => /gst|tax|cess|vat/i.test(n);
  const isRound = (n) => /round/i.test(n);

  const taxes = entries.rows
    .filter((e) => isTax(e.ledger_name))
    .map((e) => ({ label: e.ledger_name, amountPaise: Math.abs(Number(e.amount_paise)) }));

  const roundOff = entries.rows
    .filter((e) => isRound(e.ledger_name))
    .reduce((n, e) => n + Number(e.amount_paise), 0);

  /*
   * Paid, part paid, or unpaid.
   *
   * Only meaningful for a voucher that raises a bill. A contra or a journal
   * has no payment status, and inventing one ("unpaid") would put a red mark
   * against entries that can never be paid.
   */
  const billed = bills.rows.reduce((n, b) => n + Math.abs(Number(b.amount_paise)), 0);
  const outstanding = settlement.rows.reduce((n, r) => n + Number(r.outstanding), 0);

  let paymentStatus = null;
  if (bills.rows.length && billed > 0) {
    paymentStatus = outstanding <= 0 ? 'paid'
      : outstanding < billed ? 'part-paid'
      : 'unpaid';
  }

  /*
   * What a receipt or payment was actually for.
   *
   * A receipt carrying an "Agst Ref" settles a named invoice; one carrying
   * "New Ref" or nothing is money taken before any bill exists. A shop owner
   * chasing a balance needs to tell the two apart, because an advance is not
   * a debt being cleared.
   */
  let against = null;
  if (VT.isReceipt(v.vch_type) || VT.isPayment(v.vch_type)) {
    const refs = bills.rows.filter((b) => /agst|against/i.test(b.bill_type || ''));
    against = {
      kind: refs.length ? 'against-invoice' : 'advance',
      invoices: refs.map((b) => b.ref),
      // Several bills settled by one receipt is normal and worth naming: it
      // explains why the amount matches no single invoice.
      multiple: refs.length > 1,
    };
  }

  /*
   * Which way money moved in a contra.
   *
   * Tally records cash-to-bank and bank-to-cash identically apart from the
   * sign on each leg, and the direction is the only thing anyone reads a
   * contra to find out.
   */
  let contra = null;
  if (/contra/i.test(v.vch_type)) {
    /*
     * Money leaves the credited account and arrives in the debited one.
     *
     * With positive meaning debit, the destination is the positive leg and the
     * source is the negative one - the opposite of what this read before, which
     * printed every contra backwards.
     */
    const legs = entries.rows.map((e) => ({
      ledger: e.ledger_name,
      amount: Number(e.amount_paise),
    }));
    const from = legs.find((l) => l.amount < 0)?.ledger ?? '';
    const to = legs.find((l) => l.amount > 0)?.ledger ?? '';
    contra = { from, to, label: from && to ? `${from} → ${to}` : '' };
  }

  return {
    id: v.id,
    vchNo: v.vch_no,
    // A commitment is not trade, and the screen has to say so.
    isCommitment: VT.isOrder(v.vch_type),
    paymentStatus,
    outstandingPaise: paymentStatus ? Math.max(0, outstanding) : null,
    paidPaise: paymentStatus ? Math.max(0, billed - Math.max(0, outstanding)) : null,
    against,
    contra,
    vchType: v.vch_type,
    date: v.date_text,
    party: v.party,
    narration: v.narration,
    amountPaise: Math.abs(Number(v.amount_paise)),
    isCancelled: v.is_cancelled,
    items: items.rows.map((i) => ({
      name: i.item_name,
      qty: Number(i.qty),
      ratePaise: Number(i.rate_paise),
      amountPaise: Math.abs(Number(i.amount_paise)),
    })),
    entries: entries.rows.map((e) => ({
      ledger: e.ledger_name,
      amountPaise: Number(e.amount_paise),
      /*
       * Positive is a DEBIT.
       *
       * Tally sends debit as negative and the connector negates it on the way
       * in, so by the time a leg reaches here the sign is the ordinary
       * accounting one: money into this ledger is positive. Verified against
       * a receipt, where Cash is positive and the debtor negative.
       */
      side: Number(e.amount_paise) > 0 ? 'debit' : 'credit',
    })),
    taxes,
    roundOffPaise: roundOff,
    bills: bills.rows.map((b) => ({
      ref: b.ref, billDate: b.bill_date, dueDate: b.due_date,
      amountPaise: Number(b.amount_paise), type: b.bill_type,
    })),
  };
}

/**
 * One box that finds anything.
 *
 * A shop owner looking for "Royal Tiles" does not know whether that is a party,
 * a voucher or an item - and should not have to. Three small queries beat one
 * clever union: each is indexed, and the results stay labelled by what they are.
 */
async function search(ctx, tallyGuid) {
  const s = auth.requireUser(ctx);
  const co = await companyFor(s, tallyGuid);
  const q = (ctx.url.searchParams.get('q') || '').trim();
  if (q.length < 2) return { q, parties: [], vouchers: [], items: [] };

  const like = `%${q}%`;
  const [parties, vouchers, items] = await Promise.all([
    query(`SELECT name, parent_group, closing_paise, phone
             FROM ledgers WHERE company_id = $1 AND name ILIKE $2
            ORDER BY abs(closing_paise) DESC LIMIT 8`, [co.id, like]),
    query(`SELECT id, vch_no, vch_date::text AS date, party, vch_type,
                  abs(amount_paise)::bigint AS amount
             FROM vouchers
            WHERE company_id = $1 AND NOT is_cancelled
              AND (party ILIKE $2 OR vch_no ILIKE $2 OR narration ILIKE $2)
            ORDER BY vch_date DESC LIMIT 8`, [co.id, like]),
    query(`SELECT name, unit, closing_qty, closing_value_paise
             FROM stock_items WHERE company_id = $1 AND name ILIKE $2
            ORDER BY closing_value_paise DESC LIMIT 8`, [co.id, like]),
  ]);

  return {
    q,
    parties: parties.rows.map((r) => ({
      name: r.name, group: r.parent_group,
      balancePaise: Number(r.closing_paise), phone: r.phone,
    })),
    vouchers: vouchers.rows.map((r) => ({
      id: r.id, vchNo: r.vch_no, date: r.date, party: r.party,
      vchType: r.vch_type, amountPaise: Number(r.amount),
    })),
    items: items.rows.map((r) => ({
      name: r.name, unit: r.unit,
      qty: Number(r.closing_qty), valuePaise: Number(r.closing_value_paise),
    })),
  };
}

module.exports = { list, detail, search, sectionList, SECTIONS };
