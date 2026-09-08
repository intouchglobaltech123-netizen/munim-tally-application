'use strict';

/**
 * What counts as a sale, a purchase, an order, and everything else.
 *
 * Written down once because getting it wrong is expensive and silent. Tally
 * names voucher types freely, and the obvious test - does the name contain
 * "sale" - also matches "Sales Order". An order is a commitment to trade, not
 * trade: counting one as revenue overstates sales, overstates profit, and
 * shows a customer money they have not earned.
 *
 * The same trap sits under "Purchase Order", "Delivery Note" and "Receipt
 * Note", none of which move money either.
 *
 * Every fragment below is a literal for interpolation into SQL. They contain
 * no user input - only these constants - and each is applied to the same
 * column, `v.vch_type`.
 */

/** Things that are not actual trade, however they are named. */
const NOT_TRADE = "v.vch_type NOT ILIKE '%order%' "
                + "AND v.vch_type NOT ILIKE '%quot%' "
                + "AND v.vch_type NOT ILIKE '%delivery note%' "
                + "AND v.vch_type NOT ILIKE '%receipt note%'";

/** A real sale: excludes returns, orders and quotations. */
const SALES = `v.vch_type ILIKE '%sale%' AND v.vch_type NOT ILIKE '%return%' AND ${NOT_TRADE}`;

/** A real purchase. */
const PURCHASES = `v.vch_type ILIKE '%purchase%' AND v.vch_type NOT ILIKE '%return%' AND ${NOT_TRADE}`;

/** Money actually received or paid. */
const RECEIPTS = "v.vch_type ILIKE '%receipt%' AND v.vch_type NOT ILIKE '%receipt note%'";
const PAYMENTS = "v.vch_type ILIKE '%payment%'";

/** Cancelled and optional entries are records, not transactions. */
const LIVE = 'NOT v.is_cancelled AND NOT v.is_optional';

/**
 * The same rules in JavaScript, for classifying a row already fetched.
 *
 * Kept beside the SQL so the two cannot drift - a voucher counted as a sale by
 * one and an order by the other is exactly the kind of disagreement nobody
 * finds until a customer does.
 */
const isOrder = (t) => /order|quot|delivery note|receipt note/i.test(t || '');
const isSale = (t) => /sale/i.test(t || '') && !/return/i.test(t || '') && !isOrder(t);
const isPurchase = (t) => /purchase/i.test(t || '') && !/return/i.test(t || '') && !isOrder(t);
const isReceipt = (t) => /receipt/i.test(t || '') && !/receipt note/i.test(t || '');
const isPayment = (t) => /payment/i.test(t || '');

/**
 * The same fragments for a query that names its table differently.
 *
 * Some queries alias vouchers as `v`, others select from it directly. Passing
 * the alias in beats hand-editing the SQL at each call site, which is how one
 * of these ends up subtly different from the rest.
 */
const withAlias = (frag, alias) =>
  alias ? frag : frag.replace(/\bv\./g, '');

const sales = (alias = 'v') => withAlias(SALES, alias === 'v');
const purchases = (alias = 'v') => withAlias(PURCHASES, alias === 'v');
const receipts = (alias = 'v') => withAlias(RECEIPTS, alias === 'v');
const payments = (alias = 'v') => withAlias(PAYMENTS, alias === 'v');
const live = (alias = 'v') => withAlias(LIVE.replace(/\bNOT is_/g, 'NOT v.is_'), alias === 'v');
const notTrade = (alias = 'v') => withAlias(NOT_TRADE, alias === 'v');

module.exports = {
  NOT_TRADE, SALES, PURCHASES, RECEIPTS, PAYMENTS, LIVE,
  sales, purchases, receipts, payments, live, notTrade,
  isOrder, isSale, isPurchase, isReceipt, isPayment,
};
