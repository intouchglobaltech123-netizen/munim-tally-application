'use strict';
const QR = require('qrcode');
const { HttpError } = require('./http');

/**
 * How a company's documents are laid out and what appears on them.
 *
 * The defaults are a complete, correct Indian tax invoice. Everything here is
 * a way to turn something off or add the shop's own words - not a blank canvas.
 * A drag-and-drop designer produces documents that fail an audit, and the
 * person using it has no way to know until it does.
 */

/** Page sizes in millimetres, portrait. */
const PAGES = {
  a4: { width: 210, height: 297, label: 'A4' },
  a5: { width: 148, height: 210, label: 'A5' },
  letter: { width: 216, height: 279, label: 'Letter' },
  // 80mm roll: the receipt printer on a shop counter. Height is open-ended,
  // so it is given a nominal value and the paper simply runs on.
  thermal: { width: 80, height: 200, label: 'Thermal (80mm)' },
};

/*
 * Blocks that can be turned off.
 *
 * Default true for everything a tax invoice needs, so a shop that never opens
 * this screen still prints a compliant document. `logo`, `bank`, `upiQr`,
 * `terms` and `footer` default true as well but simply do not render when the
 * underlying value is empty - an empty block is not the same as a hidden one.
 */
const BLOCKS = {
  logo:        { label: 'Logo', hint: 'Your logo at the top left.' },
  sellerGstin: { label: 'Your GSTIN', hint: 'Required on a tax invoice.' },
  sellerPan:   { label: 'Your PAN', hint: '' },
  buyerAddress:{ label: 'Customer address', hint: '' },
  buyerGstin:  { label: 'Customer GSTIN', hint: 'They need this to claim credit.' },
  shipping:    { label: 'Shipping address', hint: 'When goods go elsewhere.' },
  hsn:         { label: 'HSN/SAC column', hint: 'Required above the turnover threshold.' },
  discount:    { label: 'Discount column', hint: 'Only shows when a line has one.' },
  taxColumn:   { label: 'GST rate column', hint: 'Per-line tax rate.' },
  taxBreakup:  { label: 'Tax breakup', hint: 'CGST / SGST / IGST split.' },
  hsnSummary:  { label: 'HSN summary', hint: 'The table a GST return asks for.' },
  inWords:     { label: 'Amount in words', hint: 'Stops a digit being added later.' },
  bank:        { label: 'Bank details', hint: 'Where to pay you.' },
  upiQr:       { label: 'UPI QR code', hint: 'Point a phone at it and pay.' },
  terms:       { label: 'Terms', hint: 'Your standing terms.' },
  signature:   { label: 'Signature block', hint: '' },
  footer:      { label: 'Footer', hint: '' },
};

const DEFAULT_SHOW = Object.fromEntries(Object.keys(BLOCKS).map((k) => [k, true]));

/** Read the settings off a company row, with every default filled in. */
function templateOf(c) {
  const show = { ...DEFAULT_SHOW, ...(c.doc_show ?? {}) };
  const page = c.doc_page_size === 'custom'
    ? { width: c.doc_width_mm, height: c.doc_height_mm, label: 'Custom' }
    : PAGES[c.doc_page_size] ?? PAGES.a4;

  const landscape = c.doc_orientation === 'landscape';

  return {
    page: {
      size: c.doc_page_size,
      label: page.label,
      orientation: c.doc_orientation,
      // Swapped here rather than in every consumer, so nobody has to remember.
      widthMm: landscape ? page.height : page.width,
      heightMm: landscape ? page.width : page.height,
      marginMm: c.doc_margin_mm,
    },
    type: {
      font: c.doc_font,
      sizePt: c.doc_font_size,
      accent: c.doc_accent,
      borders: c.doc_borders,
      // A thermal roll is 80mm wide; anything but dense spills off the paper.
      dense: c.doc_dense || c.doc_page_size === 'thermal',
    },
    show,
    text: {
      terms: c.doc_terms || '',
      footer: c.doc_footer || '',
      signatory: c.doc_signatory || '',
    },
    bank: {
      name: c.bank_name || '',
      account: c.bank_account || '',
      ifsc: c.bank_ifsc || '',
      branch: c.bank_branch || '',
    },
    upiId: c.upi_id || '',
  };
}

/*
 * A UPI id looks like name@bank.
 *
 * Validated because a wrong one produces a QR that fails silently at the
 * counter - the customer scans, gets an error, and blames the shop.
 */
const UPI_SHAPE = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9.\-_]{1,63}$/;

/**
 * A UPI payment QR for one invoice.
 *
 * The amount is embedded, so the customer scans and confirms rather than
 * typing a figure they might mistype. Returns null rather than throwing when
 * there is no UPI id: an invoice without one is perfectly valid.
 */
async function upiQr({ upiId, payeeName, amountPaise, note }) {
  if (!upiId || !UPI_SHAPE.test(upiId)) return null;

  const params = new URLSearchParams({
    pa: upiId,
    pn: String(payeeName || '').slice(0, 50),
    // UPI wants rupees with two decimals, not paise.
    am: (Math.abs(amountPaise) / 100).toFixed(2),
    cu: 'INR',
  });
  if (note) params.set('tn', String(note).slice(0, 50));

  try {
    return {
      dataUri: await QR.toDataURL(`upi://pay?${params}`,
        { width: 220, margin: 1, errorCorrectionLevel: 'M' }),
      upiId,
      // Shown beside the code so somebody without a scanner can still pay.
      amount: (Math.abs(amountPaise) / 100).toFixed(2),
    };
  } catch {
    // A QR that will not render is not worth failing an invoice over.
    return null;
  }
}

/** Validate and normalise an update. Throws with something a person can act on. */
function validate(body) {
  const out = {};

  if (body.pageSize !== undefined) {
    if (!['a4', 'a5', 'letter', 'thermal', 'custom'].includes(body.pageSize)) {
      throw new HttpError(400, 'BAD_PAGE', 'Page must be A4, A5, Letter, Thermal or Custom.');
    }
    out.doc_page_size = body.pageSize;
  }
  if (body.orientation !== undefined) {
    if (!['portrait', 'landscape'].includes(body.orientation)) {
      throw new HttpError(400, 'BAD_ORIENTATION', 'Orientation must be portrait or landscape.');
    }
    out.doc_orientation = body.orientation;
  }
  for (const [key, col, lo, hi] of [
    ['widthMm', 'doc_width_mm', 40, 500],
    ['heightMm', 'doc_height_mm', 40, 900],
    ['marginMm', 'doc_margin_mm', 0, 40],
    ['fontSize', 'doc_font_size', 8, 18],
  ]) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isInteger(n) || n < lo || n > hi) {
      throw new HttpError(400, 'BAD_VALUE', `${key} must be a whole number between ${lo} and ${hi}.`);
    }
    out[col] = n;
  }
  if (body.font !== undefined) {
    if (!['sans', 'serif', 'mono'].includes(body.font)) {
      throw new HttpError(400, 'BAD_FONT', 'Font must be sans, serif or mono.');
    }
    out.doc_font = body.font;
  }
  if (body.accent !== undefined) {
    const c = String(body.accent).trim();
    // Hex only: this goes straight into a style attribute, and anything else
    // is either a mistake or an attempt to smuggle CSS into the page.
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) {
      throw new HttpError(400, 'BAD_COLOUR', 'Colour must be a hex value like #1F2937.');
    }
    out.doc_accent = c;
  }
  if (body.borders !== undefined) out.doc_borders = !!body.borders;
  if (body.dense !== undefined) out.doc_dense = !!body.dense;

  if (body.show !== undefined) {
    if (typeof body.show !== 'object' || Array.isArray(body.show)) {
      throw new HttpError(400, 'BAD_SHOW', 'Blocks must be an object.');
    }
    const clean = {};
    for (const [k, v] of Object.entries(body.show)) {
      if (!BLOCKS[k]) throw new HttpError(400, 'BAD_BLOCK', `There is no "${k}" block.`);
      clean[k] = !!v;
    }
    out.doc_show = JSON.stringify(clean);
  }

  for (const [key, col, max] of [
    ['terms', 'doc_terms', 2000],
    ['footer', 'doc_footer', 500],
    ['signatory', 'doc_signatory', 80],
    ['bankName', 'bank_name', 120],
    ['bankAccount', 'bank_account', 40],
    ['bankIfsc', 'bank_ifsc', 20],
    ['bankBranch', 'bank_branch', 120],
  ]) {
    if (body[key] === undefined) continue;
    out[col] = String(body[key]).slice(0, max);
  }

  if (body.upiId !== undefined) {
    const u = String(body.upiId).trim();
    if (u && !UPI_SHAPE.test(u)) {
      throw new HttpError(400, 'BAD_UPI',
        'That does not look like a UPI id. They look like name@bank.');
    }
    out.upi_id = u;
  }

  return out;
}

module.exports = { PAGES, BLOCKS, DEFAULT_SHOW, templateOf, upiQr, validate, UPI_SHAPE };
