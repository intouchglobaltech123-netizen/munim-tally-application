'use strict';

/**
 * A rupee amount written out in words, the Indian way.
 *
 * Not decoration: an Indian tax invoice is expected to carry the amount in
 * words, and it is the line that stops a digit being added to a printed
 * figure. The grouping is lakh and crore, not thousand and million - writing
 * "one million two hundred thousand" on an invoice in Coimbatore marks the
 * document as foreign and, to an auditor, as wrong.
 */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
  'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy',
  'Eighty', 'Ninety'];

/** 0-99, which is the only span the Indian groups ever need except hundreds. */
function twoDigits(n) {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t} ${o}` : t;
}

function threeDigits(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/**
 * The whole-rupee part, grouped crore / lakh / thousand / hundred.
 *
 * Indian grouping is 2,2,3 from the right rather than 3,3,3, which is why this
 * cannot be a generic implementation with different labels.
 */
function rupeesInWords(n) {
  if (n === 0) return 'Zero';

  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;

  const parts = [];
  // Crores can exceed 99, so that group recurses rather than capping - a
  // ₹150 crore figure is rare but must not print as nonsense.
  if (crore) parts.push(`${crore > 99 ? rupeesInWords(crore) : twoDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));

  return parts.join(' ');
}

/**
 * The full line as it appears on an invoice.
 *
 * Paise are named separately because that is the convention, and rounding them
 * into the rupee figure would make the words disagree with the numerals
 * printed beside them - which is precisely what this line exists to prevent.
 */
function amountInWords(paise, currency = 'Rupees') {
  const negative = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;

  const parts = [];
  if (rupees || !p) parts.push(`${currency} ${rupeesInWords(rupees)}`);
  if (p) parts.push(`${rupees ? 'and ' : ''}${twoDigits(p)} Paise`);

  return `${negative ? 'Minus ' : ''}${parts.join(' ')} Only`;
}

module.exports = { amountInWords, rupeesInWords };
