'use strict';

/**
 * The arithmetic behind a bill.
 *
 * Separated from the routes because every one of these has an exact right
 * answer that somebody can check against a calculator, and because getting GST
 * wrong on your own invoices is the kind of mistake that ends in a notice.
 *
 * Integers throughout. Money in paise, tax rates in basis points, and never a
 * float anywhere in between - 0.1 + 0.2 is a rounding error that becomes a
 * rupee that becomes a customer proving your invoice does not add up.
 */

/** SaaS in India is 18%, as CGST+SGST within a state or IGST across one. */
const GST_BPS = 1800;

/** Munim's own place of business, which decides which pair of taxes applies. */
const HOME_STATE = process.env.MUNIM_STATE || 'Tamil Nadu';
const HOME_STATE_CODE = process.env.MUNIM_STATE_CODE || '33';

/**
 * Round half up, which is what an accountant expects.
 *
 * Math.round() rounds -0.5 towards zero, so a credit note comes out a paisa
 * different from the invoice it reverses. Nothing in this file is ever allowed
 * to disagree with its own reversal by a paisa.
 */
function roundHalfUp(n) {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/**
 * Apply a coupon.
 *
 * The discount is capped at the subtotal: a ₹500 coupon on a ₹499 plan makes
 * the bill zero, never minus one rupee, and certainly never a refund.
 */
function applyCoupon(subtotalPaise, coupon) {
  if (!coupon) return { discountPaise: 0, label: '' };

  const raw = coupon.percent_off != null
    ? roundHalfUp((subtotalPaise * coupon.percent_off) / 100)
    : Number(coupon.amount_off_paise ?? 0);

  const discountPaise = Math.max(0, Math.min(subtotalPaise, raw));
  return {
    discountPaise,
    label: coupon.percent_off != null
      ? `${coupon.percent_off}% off`
      : `₹${(Number(coupon.amount_off_paise) / 100).toLocaleString('en-IN')} off`,
  };
}

/**
 * Tax on what is actually being charged.
 *
 * Computed on the amount AFTER the discount, which is what the law says and
 * also what a customer expects: nobody accepts paying tax on money they did not
 * pay.
 *
 * Within Tamil Nadu it is CGST + SGST, half each; anywhere else in India it is
 * IGST at the full rate. Splitting a rate in half can leave an odd paisa, so
 * SGST takes the remainder and the two always add back to the total exactly.
 */
function gstFor(taxablePaise, buyerState) {
  const total = roundHalfUp((taxablePaise * GST_BPS) / 10000);
  const sameState = normaliseState(buyerState) === normaliseState(HOME_STATE);

  if (!sameState) return { cgst: 0, sgst: 0, igst: total, total, kind: 'IGST' };

  const cgst = Math.floor(total / 2);
  return { cgst, sgst: total - cgst, igst: 0, total, kind: 'CGST+SGST' };
}

const normaliseState = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * One whole bill, from list price to what is owed.
 *
 * Returned as its parts rather than a total, because a GST invoice has to show
 * each of them and recomputing tax from a total loses a rupee.
 */
function quote({ pricePaise, coupon = null, buyerState = '', quantity = 1 }) {
  const subtotal = Math.max(0, Math.round(pricePaise * quantity));
  const { discountPaise, label } = applyCoupon(subtotal, coupon);
  const taxable = subtotal - discountPaise;
  const gst = gstFor(taxable, buyerState);

  return {
    subtotalPaise: subtotal,
    discountPaise,
    discountLabel: label,
    taxablePaise: taxable,
    cgstPaise: gst.cgst,
    sgstPaise: gst.sgst,
    igstPaise: gst.igst,
    taxPaise: gst.total,
    taxKind: gst.kind,
    taxRateBps: GST_BPS,
    totalPaise: taxable + gst.total,
  };
}

/**
 * What a mid-term plan change costs.
 *
 * Charge for the part of the period they have not used yet, credit what they
 * already paid for the same days. Anything else either bills twice for one week
 * or gives a month away, and both get noticed.
 */
function prorate({ fromPaise, toPaise, periodFrom, periodUntil, at = new Date() }) {
  const start = new Date(periodFrom).getTime();
  const end = new Date(periodUntil).getTime();
  const now = new Date(at).getTime();

  const span = end - start;
  if (span <= 0) return { chargePaise: Math.max(0, toPaise), creditPaise: 0, daysLeft: 0 };

  // Clamped: a change requested after the period ended prorates nothing rather
  // than producing a negative fraction and a credit nobody is owed.
  const remaining = Math.max(0, Math.min(span, end - now));
  const fraction = remaining / span;

  const charge = roundHalfUp(toPaise * fraction);
  const credit = roundHalfUp(fromPaise * fraction);

  return {
    chargePaise: charge,
    creditPaise: credit,
    // Never negative: a downgrade owes nothing rather than paying money back.
    // Refunds are a deliberate, human decision, not an arithmetic side effect.
    duePaise: Math.max(0, charge - credit),
    daysLeft: Math.ceil(remaining / 86400000),
    fraction,
  };
}

/** The Indian financial year a date falls in: 1 April to 31 March. */
function financialYear(d = new Date()) {
  const date = new Date(d);
  const y = date.getFullYear();
  // Before April, the year started the previous calendar year.
  const start = date.getMonth() < 3 ? y - 1 : y;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Rupees, grouped the Indian way, for display. */
const rupees = (paise) =>
  `₹${(Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

module.exports = {
  GST_BPS, HOME_STATE, HOME_STATE_CODE,
  applyCoupon, gstFor, quote, prorate, financialYear, rupees, roundHalfUp,
};
