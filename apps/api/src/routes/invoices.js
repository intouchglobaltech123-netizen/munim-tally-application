'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const VT = require('../lib/vouchertypes');
const { HttpError } = require('../lib/http');
const { amountInWords } = require('../lib/words');
const { companyFor } = require('./reports');
const doc = require('../lib/doctemplate');

/**
 * Invoices, as documents rather than as rows.
 *
 * Everything here is derived from what Tally already holds. Munim does not
 * number invoices, does not raise them and does not cancel them - those happen
 * in Tally. What it can do, and what nobody does by hand, is check that the
 * numbering is sound: a duplicate invoice number is a compliance problem that
 * surfaces at assessment, months after it could have been fixed cheaply.
 */

/** The first two characters of a GSTIN are the state code. */
const stateCode = (gstin) => String(gstin || '').trim().slice(0, 2);

/**
 * What kind of document this is, in GST terms.
 *
 * The distinction matters on the printed page: a Bill of Supply must NOT be
 * headed "Tax Invoice", and a composition dealer issuing one has to say so.
 * Getting the heading wrong is the kind of error a customer's auditor finds.
 */
function classify({ companyGstin, partyGstin, taxTotal, isReturn, isCommitment }) {
  if (isCommitment) return { kind: 'proforma', title: 'Proforma Invoice', taxable: false };
  if (isReturn) return { kind: 'credit-note', title: 'Credit Note', taxable: taxTotal > 0 };
  if (!companyGstin) return { kind: 'non-gst', title: 'Invoice', taxable: false };
  if (taxTotal > 0) return { kind: 'tax-invoice', title: 'Tax Invoice', taxable: true };
  // Registered, but no tax charged: exempt, nil-rated, or a composition
  // dealer. All of them are a Bill of Supply, never a Tax Invoice.
  return {
    kind: 'bill-of-supply',
    title: 'Bill of Supply',
    taxable: false,
    note: 'No tax charged on this document.',
  };
}

/**
 * Split the tax legs into CGST/SGST or IGST.
 *
 * Which pair applies is decided by place of supply: same state means the tax
 * splits into central and state halves, different states means a single
 * integrated tax. Tally already posts to the right ledgers, so this reads them
 * rather than recomputing - but it reports the expectation too, because a
 * mismatch between the two is a real and expensive error.
 */
function taxBreakup(taxes, companyGstin, partyGstin) {
  const bucket = { cgst: 0, sgst: 0, igst: 0, cess: 0, other: 0 };
  for (const t of taxes) {
    const n = t.label.toLowerCase();
    if (/\bigst\b|integrated/.test(n)) bucket.igst += t.amountPaise;
    else if (/\bcgst\b|central/.test(n)) bucket.cgst += t.amountPaise;
    else if (/\bsgst\b|\butgst\b|state/.test(n)) bucket.sgst += t.amountPaise;
    else if (/cess/.test(n)) bucket.cess += t.amountPaise;
    else bucket.other += t.amountPaise;
  }

  const a = stateCode(companyGstin);
  const b = stateCode(partyGstin);
  // Only claimed when both GSTINs are known; guessing the place of supply from
  // an address would be worse than saying nothing.
  const expected = a && b ? (a === b ? 'intra' : 'inter') : null;
  const actual = bucket.igst > 0 ? 'inter'
    : (bucket.cgst > 0 || bucket.sgst > 0) ? 'intra' : null;

  return {
    ...bucket,
    total: bucket.cgst + bucket.sgst + bucket.igst + bucket.cess + bucket.other,
    supply: actual,
    expectedSupply: expected,
    // Flagged rather than corrected: the books are Tally's, and a wrong tax
    // split is something a human has to fix at the source.
    mismatch: !!(expected && actual && expected !== actual),
  };
}

/**
 * Pull an invoice number apart into prefix, sequence and suffix.
 *
 * Shops number invoices as INV/2026-27/0042, GST-101, or just 7. The sequence
 * is the last run of digits, which is what actually increments; everything
 * around it is the series it belongs to.
 */
function parseNumber(vchNo) {
  const raw = String(vchNo || '').trim();
  const m = raw.match(/^(.*?)(\d+)([^\d]*)$/);
  if (!m) return { raw, prefix: raw, seq: null, suffix: '', series: raw };
  return {
    raw,
    prefix: m[1],
    seq: Number(m[2]),
    /*
     * Zero padding is recorded but deliberately NOT part of the series key.
     *
     * A shop that writes 8, 9, then 010 has one series with sloppy padding,
     * not two - and splitting on width would invent a gap in each half. The
     * cost is that a business genuinely running "7" and "007" as separate
     * series sees them merged, which is much rarer and shows up as a
     * duplicate rather than as silence.
     */
    width: m[2].length,
    suffix: m[3],
    series: `${m[1]}#${m[3]}`,
  };
}

/** Everything needed to print one invoice. */
async function document(ctx, tallyGuid, voucherId) {
  const s = perms.require(auth.requireUser(ctx), 'sales', 'read');
  const co = await companyFor(s, tallyGuid);

  const { rows: cos } = await query('SELECT * FROM companies WHERE id = $1', [co.id]);
  const company = cos[0];

  const { rows } = await query(
    `SELECT v.*, v.vch_date::text AS date_text
       FROM vouchers v WHERE v.id = $1 AND v.company_id = $2`, [voucherId, co.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such voucher.');
  const v = rows[0];

  const [items, entries, bills, party] = await Promise.all([
    query(`SELECT vi.item_name, vi.qty, vi.rate_paise, vi.amount_paise,
                  si.hsn, si.sac, si.unit, si.gst_rate_bp
             FROM voucher_items vi
             LEFT JOIN stock_items si
               ON si.company_id = $2 AND lower(si.name) = lower(vi.item_name)
            WHERE vi.voucher_id = $1 ORDER BY vi.item_name`, [v.id, co.id]),
    query(`SELECT ledger_name, amount_paise FROM voucher_entries WHERE voucher_id = $1`, [v.id]),
    query(`SELECT ref, bill_date::text AS bill_date, due_date::text AS due_date,
                  amount_paise, bill_type FROM bills WHERE voucher_id = $1`, [v.id]),
    query(`SELECT * FROM ledgers WHERE company_id = $1 AND lower(name) = lower($2)`,
      [co.id, v.party]),
  ]);

  const isTax = (n) => /gst|tax|cess|vat/i.test(n) && !/deduct/i.test(n);
  const isRound = (n) => /round/i.test(n);

  const taxes = entries.rows
    .filter((e) => isTax(e.ledger_name))
    .map((e) => ({ label: e.ledger_name, amountPaise: Math.abs(Number(e.amount_paise)) }));
  const roundOff = entries.rows
    .filter((e) => isRound(e.ledger_name))
    .reduce((n, e) => n + Number(e.amount_paise), 0);

  const p = party.rows[0] ?? {};
  const tax = taxBreakup(taxes, company.gstin, p.gstin);
  const template = doc.templateOf(company);
  const kind = classify({
    companyGstin: company.gstin,
    partyGstin: p.gstin,
    taxTotal: tax.total,
    isReturn: /return|credit note/i.test(v.vch_type),
    isCommitment: VT.isOrder(v.vch_type),
  });

  const lines = items.rows.map((i) => {
    const qty = Number(i.qty);
    const rate = Number(i.rate_paise);
    const amount = Math.abs(Number(i.amount_paise));
    /*
     * Discount, derived rather than stored.
     *
     * Tally holds a per-line discount but the connector does not carry it yet.
     * Quantity times rate less the line amount is the same number, and it is
     * available today. Rounded to the rupee before comparing: floating rates
     * routinely leave a paisa of noise that would show as a ₹0.01 discount on
     * every line.
     */
    const gross = Math.round(qty * rate);
    const discount = gross - amount;
    return {
      name: i.item_name,
      hsn: i.hsn || i.sac || '',
      unit: i.unit || '',
      qty,
      ratePaise: rate,
      grossPaise: gross,
      discountPaise: Math.abs(discount) >= 100 && discount > 0 ? discount : 0,
      amountPaise: amount,
      gstRatePct: (i.gst_rate_bp ?? 0) / 100,
    };
  });

  const subtotal = lines.reduce((n, l) => n + l.amountPaise, 0);
  const totalDiscount = lines.reduce((n, l) => n + l.discountPaise, 0);

  /**
   * HSN summary, which a GST return needs and nobody enjoys assembling.
   */
  const hsnMap = new Map();
  for (const l of lines) {
    if (!l.hsn) continue;
    const cur = hsnMap.get(l.hsn) ?? { hsn: l.hsn, qty: 0, valuePaise: 0, gstRatePct: l.gstRatePct };
    cur.qty += l.qty;
    cur.valuePaise += l.amountPaise;
    hsnMap.set(l.hsn, cur);
  }

  const gross = Math.abs(Number(v.amount_paise));
  const qr = template.show.upiQr
    ? await doc.upiQr({
        upiId: template.upiId,
        payeeName: company.formal_name || company.name,
        amountPaise: gross,
        note: v.vch_no,
      })
    : null;

  return {
    document: {
      ...kind,
      // Marked so the printed page can carry the warning rather than passing
      // a draft off as the real thing.
      isCommitment: VT.isOrder(v.vch_type),
      isCancelled: v.is_cancelled,
    },
    seller: {
      name: company.formal_name || company.name,
      address: company.address,
      state: company.state,
      pincode: company.pincode,
      phone: company.phone,
      email: company.email,
      gstin: company.gstin,
      pan: company.pan,
      logoDataUri: company.logo_data_uri || '',
      bank: {
        name: company.bank_name || '',
        account: company.bank_account || '',
        ifsc: company.bank_ifsc || '',
        branch: company.bank_branch || '',
      },
    },
    // How this company wants its documents laid out.
    template,
    // Present only when the company has a UPI id: an invoice without one is
    // perfectly valid, and a broken QR is worse than none.
    upiQr: qr,
    buyer: {
      name: v.party,
      address: p.address ?? '',
      state: p.state ?? '',
      pincode: p.pincode ?? '',
      phone: p.phone ?? '',
      email: p.email ?? '',
      gstin: p.gstin ?? '',
      pan: p.pan ?? '',
      shippingAddress: p.shipping_address ?? '',
    },
    invoice: {
      id: v.id,
      number: v.vch_no,
      numbering: parseNumber(v.vch_no),
      date: v.date_text,
      type: v.vch_type,
      narration: v.narration,
      placeOfSupply: p.state ?? '',
      terms: p.credit_days ? `${p.credit_days} days` : '',
      dueDate: bills.rows[0]?.due_date ?? null,
    },
    lines,
    hsnSummary: [...hsnMap.values()],
    totals: {
      subtotalPaise: subtotal,
      discountPaise: totalDiscount,
      taxes,
      tax,
      roundOffPaise: roundOff,
      grossPaise: gross,
      // The line that stops a digit being added to a printed figure.
      inWords: amountInWords(gross, 'Rupees'),
    },
    bills: bills.rows.map((b) => ({
      ref: b.ref, billDate: b.bill_date, dueDate: b.due_date,
      amountPaise: Number(b.amount_paise), type: b.bill_type,
    })),
  };
}

/**
 * The health of an invoice series.
 *
 * Three things nobody checks by hand and every assessment asks about: numbers
 * issued twice, numbers missing from the middle of a run, and numbers dated
 * out of order. All three are read-only findings - the fix is in Tally.
 */
async function numbering(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'sales', 'read');
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;
  const from = q.get('from');
  const to = q.get('to');

  const args = [co.id];
  let range = '';
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) range += ` AND v.vch_date >= $${args.push(from)}`;
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) range += ` AND v.vch_date <= $${args.push(to)}`;

  const { rows } = await query(
    `SELECT v.id, v.vch_no, v.vch_date::text AS date, v.party,
            abs(v.amount_paise)::bigint AS amount, v.is_cancelled
       FROM vouchers v
      WHERE v.company_id = $1 AND ${VT.SALES}${range}
      ORDER BY v.vch_date, v.vch_no`, args);

  const parsed = rows.map((r) => ({ ...r, n: parseNumber(r.vch_no) }));

  // --- duplicates: the same number issued twice in the same series
  const seen = new Map();
  for (const r of parsed) {
    const key = `${r.n.series}|${r.n.raw}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(r);
  }
  const duplicates = [...seen.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      number: g[0].vch_no,
      count: g.length,
      vouchers: g.map((r) => ({
        id: r.id, date: r.date, party: r.party,
        amountPaise: Number(r.amount), cancelled: r.is_cancelled,
      })),
    }));

  // --- gaps and out-of-order dates, per series
  const bySeries = new Map();
  for (const r of parsed) {
    if (r.n.seq == null) continue;
    if (!bySeries.has(r.n.series)) bySeries.set(r.n.series, []);
    bySeries.get(r.n.series).push(r);
  }

  const series = [];
  for (const [key, list] of bySeries) {
    list.sort((a, b) => a.n.seq - b.n.seq);
    const nums = list.map((r) => r.n.seq);
    const min = nums[0];
    const max = nums[nums.length - 1];

    const present = new Set(nums);
    const missing = [];
    // Capped: a series numbered 1 and 900000 is a data quirk, not 899,998
    // missing invoices, and listing them would bury the real findings.
    for (let i = min; i <= max && missing.length < 200; i++) {
      if (!present.has(i)) missing.push(i);
    }

    const outOfOrder = [];
    for (let i = 1; i < list.length; i++) {
      if (new Date(list[i].date) < new Date(list[i - 1].date)) {
        outOfOrder.push({
          number: list[i].vch_no, date: list[i].date,
          after: list[i - 1].vch_no, afterDate: list[i - 1].date,
        });
      }
    }

    series.push({
      series: key === '#' ? '(plain numbers)' : key.replace('#', '…'),
      prefix: list[0].n.prefix,
      suffix: list[0].n.suffix,
      count: list.length,
      first: list[0].vch_no,
      last: list[list.length - 1].vch_no,
      from: min,
      to: max,
      missing,
      missingCount: missing.length,
      outOfOrder,
    });
  }

  return {
    invoices: rows.length,
    series: series.sort((a, b) => b.count - a.count),
    duplicates,
    findings: {
      duplicates: duplicates.length,
      gaps: series.reduce((n, x) => n + x.missingCount, 0),
      outOfOrder: series.reduce((n, x) => n + x.outOfOrder.length, 0),
    },
    // Said plainly: this is a report, not a repair.
    note: 'Munim reads these from Tally and never changes them. '
        + 'Fix any problem in Tally and it updates here on the next sync.',
  };
}

module.exports = { document, numbering, classify, taxBreakup, parseNumber };
