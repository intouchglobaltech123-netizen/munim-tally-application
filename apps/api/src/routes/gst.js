'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const VT = require('../lib/vouchertypes');
const { parseGstin, placeOfSupply } = require('../lib/gstin');
const { companyFor } = require('./reports');
const { resolvePeriod, financialYear } = require('./dashboard');

/**
 * GST, read out of the books rather than filed from them.
 *
 * Munim does not file returns and does not talk to the GST portal - that needs
 * a GSP contract and the customer's credentials, and getting it wrong files a
 * wrong return in their name. What it does instead is assemble the figures a
 * return asks for, and check the data BEFORE it goes anywhere: a missing
 * GSTIN or a wrong tax split is cheap to fix this week and expensive to fix
 * after filing.
 */

/** How Tally names each tax, mapped to what a return calls it. */
function bucketOf(ledgerName) {
  const n = String(ledgerName || '').toLowerCase();
  if (/\bigst\b|integrated/.test(n)) return 'igst';
  if (/\bcgst\b|central/.test(n)) return 'cgst';
  if (/\bsgst\b|\butgst\b|state gst/.test(n)) return 'sgst';
  if (/cess/.test(n)) return 'cess';
  if (/gst|tax|vat/.test(n) && !/deduct|tds|tcs/.test(n)) return 'other';
  return null;
}

/**
 * Every voucher in the period with its tax legs already split out.
 *
 * One pass, because every report below is a different grouping of the same
 * rows - and running them separately would let the totals disagree.
 */
async function collect(companyId, from, to) {
  const { rows } = await query(
    `SELECT v.id, v.vch_no, v.vch_type, v.vch_date::text AS date, v.party,
            abs(v.amount_paise)::bigint AS gross,
            l.gstin AS party_gstin, l.state AS party_state,
            COALESCE(json_agg(json_build_object(
              'ledger', e.ledger_name, 'amount', abs(e.amount_paise)
            )) FILTER (WHERE e.ledger_name IS NOT NULL), '[]') AS entries
       FROM vouchers v
       LEFT JOIN ledgers l
         ON l.company_id = v.company_id AND lower(l.name) = lower(v.party)
       LEFT JOIN voucher_entries e ON e.voucher_id = v.id
      WHERE v.company_id = $1 AND ${VT.LIVE}
        AND v.vch_date BETWEEN $2::date AND $3::date
      GROUP BY v.id, l.gstin, l.state
      ORDER BY v.vch_date, v.vch_no`,
    [companyId, from, to]);

  return rows.map((r) => {
    const tax = { cgst: 0, sgst: 0, igst: 0, cess: 0, other: 0 };
    let taxable = 0;
    for (const e of r.entries) {
      const b = bucketOf(e.ledger);
      if (b) tax[b] += Number(e.amount);
      // A leg that is not tax and not the party is the taxable value: the
      // sales or purchase ledger the document posts to.
      else if (e.ledger && e.ledger.toLowerCase() !== String(r.party || '').toLowerCase()
               && !/round/i.test(e.ledger)) {
        taxable += Number(e.amount);
      }
    }
    const total = tax.cgst + tax.sgst + tax.igst + tax.cess + tax.other;
    return {
      id: r.id, no: r.vch_no, type: r.vch_type, date: r.date, party: r.party,
      grossPaise: Number(r.gross),
      // Falls back to gross-less-tax when the ledger legs are missing, which
      // happens on books that post through a single control account.
      taxablePaise: taxable > 0 ? taxable : Math.max(0, Number(r.gross) - total),
      tax, taxTotalPaise: total,
      partyGstin: r.party_gstin || '',
      partyState: r.party_state || '',
      isSale: VT.isSale(r.vch_type),
      isPurchase: VT.isPurchase(r.vch_type),
      isCreditNote: /credit note|sales return/i.test(r.vch_type),
      isDebitNote: /debit note|purchase return/i.test(r.vch_type),
    };
  });
}

const zeroTax = () => ({ cgst: 0, sgst: 0, igst: 0, cess: 0, other: 0 });
const addTax = (a, b) => {
  for (const k of Object.keys(a)) a[k] += b[k];
  return a;
};
const sumTax = (t) => t.cgst + t.sgst + t.igst + t.cess + t.other;

/**
 * The whole GST position for a period.
 *
 * Output tax on sales, input tax on purchases, and what nets out - which is
 * the only figure a business owner actually wants, and the one Tally makes
 * them assemble by hand.
 */
async function summary(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'reports', 'read');
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;

  const { rows: cos } = await query('SELECT * FROM companies WHERE id = $1', [co.id]);
  const company = cos[0];

  const { rows: last } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [co.id]);
  const asOf = new Date(last[0].d);
  const period = resolvePeriod(q.get('period') || 'fy', asOf, q.get('from'), q.get('to'));
  const iso = (d) => d.toISOString().slice(0, 10);

  const rows = await collect(co.id, iso(period.from), iso(period.to));

  const outward = { taxable: 0, tax: zeroTax(), count: 0 };
  const inward = { taxable: 0, tax: zeroTax(), count: 0 };
  const creditNotes = { taxable: 0, tax: zeroTax(), count: 0 };
  const debitNotes = { taxable: 0, tax: zeroTax(), count: 0 };

  // Rate-wise, which is how GSTR-1 wants outward supplies.
  const byRate = new Map();
  // B2B against B2C: the split the return is built on.
  const b2b = { taxable: 0, tax: zeroTax(), count: 0 };
  const b2c = { taxable: 0, tax: zeroTax(), count: 0 };

  for (const r of rows) {
    const target = r.isCreditNote ? creditNotes
      : r.isDebitNote ? debitNotes
      : r.isSale ? outward
      : r.isPurchase ? inward
      : null;
    if (!target) continue;

    target.taxable += r.taxablePaise;
    addTax(target.tax, r.tax);
    target.count += 1;

    if (r.isSale) {
      const dest = r.partyGstin ? b2b : b2c;
      dest.taxable += r.taxablePaise;
      addTax(dest.tax, r.tax);
      dest.count += 1;

      /*
       * The effective rate, derived rather than read.
       *
       * Tally holds the rate on the item, not on the voucher, and books that
       * post through a control account carry no item at all. Tax over taxable
       * value gives the rate that was actually applied, which is what a return
       * has to agree with.
       */
      const pct = r.taxablePaise > 0
        ? Math.round((r.taxTotalPaise / r.taxablePaise) * 100) : 0;
      const key = String(pct);
      const cur = byRate.get(key) ?? { ratePct: pct, taxable: 0, tax: zeroTax(), count: 0 };
      cur.taxable += r.taxablePaise;
      addTax(cur.tax, r.tax);
      cur.count += 1;
      byRate.set(key, cur);
    }
  }

  // Credit notes reduce output tax; debit notes reduce input tax.
  const outputTax = sumTax(outward.tax) - sumTax(creditNotes.tax);
  const inputTax = sumTax(inward.tax) - sumTax(debitNotes.tax);

  return {
    company: {
      name: company.name,
      gstin: company.gstin,
      gstinCheck: parseGstin(company.gstin),
      state: company.state,
    },
    period: { key: q.get('period') || 'fy', from: iso(period.from), to: iso(period.to),
              label: period.label },
    financialYear: financialYear(asOf).label,
    asOf: iso(asOf),

    outward: { ...outward, taxTotal: sumTax(outward.tax) },
    inward: { ...inward, taxTotal: sumTax(inward.tax) },
    creditNotes: { ...creditNotes, taxTotal: sumTax(creditNotes.tax) },
    debitNotes: { ...debitNotes, taxTotal: sumTax(debitNotes.tax) },

    b2b: { ...b2b, taxTotal: sumTax(b2b.tax) },
    b2c: { ...b2c, taxTotal: sumTax(b2c.tax) },

    byRate: [...byRate.values()].sort((a, b) => b.ratePct - a.ratePct)
      .map((r) => ({ ...r, taxTotal: sumTax(r.tax) })),

    position: {
      outputTaxPaise: outputTax,
      inputTaxPaise: inputTax,
      // Positive means owed to the government; negative is credit carried
      // forward, which is a completely different conversation.
      netPaise: outputTax - inputTax,
      direction: outputTax - inputTax > 0 ? 'payable'
        : outputTax - inputTax < 0 ? 'credit' : 'nil',
    },

    note: 'Assembled from your Tally books. Munim does not file returns — '
        + 'check these against the portal before filing.',
  };
}

/**
 * HSN-wise summary, which GSTR-1 asks for and nobody enjoys assembling.
 */
async function hsn(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'reports', 'read');
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;

  const { rows: last } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [co.id]);
  const period = resolvePeriod(q.get('period') || 'fy', new Date(last[0].d),
    q.get('from'), q.get('to'));
  const iso = (d) => d.toISOString().slice(0, 10);

  const { rows } = await query(
    `SELECT COALESCE(NULLIF(si.hsn, ''), NULLIF(si.sac, ''), '') AS hsn,
            si.unit,
            (si.gst_rate_bp / 100.0) AS rate_pct,
            SUM(vi.qty)::float AS qty,
            SUM(abs(vi.amount_paise))::bigint AS value,
            count(DISTINCT v.id)::int AS vouchers
       FROM voucher_items vi
       JOIN vouchers v ON v.id = vi.voucher_id
       LEFT JOIN stock_items si
         ON si.company_id = v.company_id AND lower(si.name) = lower(vi.item_name)
      WHERE v.company_id = $1 AND ${VT.LIVE} AND ${VT.SALES}
        AND v.vch_date BETWEEN $2::date AND $3::date
      GROUP BY 1, 2, 3
      ORDER BY value DESC`,
    [co.id, iso(period.from), iso(period.to)]);

  const withHsn = rows.filter((r) => r.hsn);
  const without = rows.filter((r) => !r.hsn);

  return {
    period: { from: iso(period.from), to: iso(period.to), label: period.label },
    rows: withHsn.map((r) => ({
      hsn: r.hsn, unit: r.unit || '', ratePct: Number(r.rate_pct),
      qty: Number(r.qty), valuePaise: Number(r.value), vouchers: r.vouchers,
    })),
    // Reported rather than hidden: a return needs HSN on every line above the
    // turnover threshold, and a missing one is a rejection.
    missingHsn: {
      lines: without.length,
      valuePaise: without.reduce((n, r) => n + Number(r.value), 0),
    },
    note: rows.length === 0
      ? 'No item lines in this period. Books that post without inventory carry no HSN.'
      : '',
  };
}

/** Sales and purchases by counterparty GSTIN, as a return groups them. */
async function byParty(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'reports', 'read');
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;

  const { rows: last } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [co.id]);
  const period = resolvePeriod(q.get('period') || 'fy', new Date(last[0].d),
    q.get('from'), q.get('to'));
  const iso = (d) => d.toISOString().slice(0, 10);

  const rows = await collect(co.id, iso(period.from), iso(period.to));
  const byName = new Map();

  for (const r of rows) {
    if (!r.isSale && !r.isPurchase) continue;
    const cur = byName.get(r.party) ?? {
      party: r.party, gstin: r.partyGstin, state: r.partyState,
      sales: 0, salesTax: 0, purchases: 0, purchasesTax: 0, count: 0,
    };
    if (r.isSale) { cur.sales += r.taxablePaise; cur.salesTax += r.taxTotalPaise; }
    else { cur.purchases += r.taxablePaise; cur.purchasesTax += r.taxTotalPaise; }
    cur.count += 1;
    byName.set(r.party, cur);
  }

  return {
    period: { from: iso(period.from), to: iso(period.to), label: period.label },
    parties: [...byName.values()]
      .map((p) => ({
        ...p,
        gstinCheck: p.gstin ? parseGstin(p.gstin) : null,
        kind: p.gstin ? 'b2b' : 'b2c',
      }))
      .sort((a, b) => (b.sales + b.purchases) - (a.sales + a.purchases)),
  };
}

/**
 * What would go wrong if these books were filed as they stand.
 *
 * The whole point of the module. Every finding here is cheap to fix this week
 * and expensive to fix after a return has gone in.
 */
async function health(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'reports', 'read');
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;

  const { rows: cos } = await query('SELECT * FROM companies WHERE id = $1', [co.id]);
  const company = cos[0];

  const { rows: last } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [co.id]);
  const period = resolvePeriod(q.get('period') || 'fy', new Date(last[0].d),
    q.get('from'), q.get('to'));
  const iso = (d) => d.toISOString().slice(0, 10);

  const rows = await collect(co.id, iso(period.from), iso(period.to));

  // --- parties whose GSTIN will not survive validation
  const { rows: parties } = await query(
    `SELECT name, gstin, parent_group, closing_paise FROM ledgers
      WHERE company_id = $1 AND gstin <> ''`, [co.id]);
  const badGstins = parties
    .map((p) => ({ name: p.name, gstin: p.gstin, check: parseGstin(p.gstin) }))
    .filter((p) => !p.check.valid);

  // --- tax charged the wrong way for the place of supply
  const wrongSplit = [];
  for (const r of rows) {
    if (!r.isSale || r.taxTotalPaise === 0 || !r.partyGstin || !company.gstin) continue;
    const expected = placeOfSupply(company.gstin, r.partyGstin);
    const actual = r.tax.igst > 0 ? 'inter'
      : (r.tax.cgst > 0 || r.tax.sgst > 0) ? 'intra' : null;
    if (expected && actual && expected !== actual) {
      wrongSplit.push({
        id: r.id, no: r.no, date: r.date, party: r.party,
        expected, actual, taxPaise: r.taxTotalPaise,
      });
    }
  }

  // --- CGST and SGST that do not match each other
  const unevenSplit = rows
    .filter((r) => (r.tax.cgst > 0 || r.tax.sgst > 0) && r.tax.cgst !== r.tax.sgst)
    .map((r) => ({
      id: r.id, no: r.no, date: r.date, party: r.party,
      cgst: r.tax.cgst, sgst: r.tax.sgst,
    }));

  // --- taxable sales to a party with no GSTIN recorded
  const missingBuyerGstin = rows
    .filter((r) => r.isSale && r.taxTotalPaise > 0 && !r.partyGstin && r.party)
    .reduce((m, r) => {
      const cur = m.get(r.party) ?? { party: r.party, count: 0, valuePaise: 0 };
      cur.count += 1;
      cur.valuePaise += r.taxablePaise;
      m.set(r.party, cur);
      return m;
    }, new Map());

  const findings = [
    {
      key: 'own-gstin',
      label: 'Your own GSTIN',
      count: company.gstin ? (parseGstin(company.gstin).valid ? 0 : 1) : 1,
      tone: 'bad',
      detail: !company.gstin
        ? 'Not set in Tally. Every invoice you print is missing it.'
        : parseGstin(company.gstin).message,
    },
    {
      key: 'party-gstin',
      label: 'Party GSTINs that fail the check digit',
      count: badGstins.length,
      tone: 'bad',
      detail: 'The buyer cannot claim credit against a wrong GSTIN.',
      items: badGstins.slice(0, 50),
    },
    {
      key: 'wrong-split',
      label: 'Wrong tax for the place of supply',
      count: wrongSplit.length,
      tone: 'bad',
      detail: 'IGST charged within a state, or CGST/SGST across states.',
      items: wrongSplit.slice(0, 50),
    },
    {
      key: 'uneven-split',
      label: 'CGST and SGST not equal',
      count: unevenSplit.length,
      tone: 'warn',
      detail: 'On an intra-state supply the two halves should match.',
      items: unevenSplit.slice(0, 50),
    },
    {
      key: 'missing-buyer-gstin',
      label: 'Taxable sales to a party with no GSTIN',
      count: missingBuyerGstin.size,
      tone: 'warn',
      detail: 'Treated as B2C. If they are registered, they lose the credit.',
      items: [...missingBuyerGstin.values()].slice(0, 50),
    },
  ];

  return {
    period: { from: iso(period.from), to: iso(period.to), label: period.label },
    findings,
    total: findings.reduce((n, f) => n + f.count, 0),
    note: 'Munim checks structure, not registration. Only the GST portal knows '
        + 'whether a number is live.',
  };
}

module.exports = { summary, hsn, byParty, health, bucketOf };
