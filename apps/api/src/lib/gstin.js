'use strict';

/**
 * Reading and checking a GSTIN.
 *
 * A GSTIN is not an opaque string: it carries the state, the holder's PAN and
 * a check digit. Validating it locally costs nothing and catches the mistake
 * that matters - a typo in a customer's GSTIN means the buyer cannot claim the
 * credit, and nobody finds out until the return is filed and rejected.
 *
 * This checks structure and the check digit. It cannot tell you the number is
 * registered and active - only the GST portal knows that, and asking it needs
 * an API contract we do not have.
 */

/** State codes, so a GSTIN can name its state without a lookup elsewhere. */
const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', 10: 'Bihar', 11: 'Sikkim',
  12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur', 15: 'Mizoram',
  16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal',
  20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh',
  24: 'Gujarat', 25: 'Daman and Diu', 26: 'Dadra and Nagar Haveli',
  27: 'Maharashtra', 28: 'Andhra Pradesh (old)', 29: 'Karnataka',
  30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu',
  34: 'Puducherry', 35: 'Andaman and Nicobar Islands', 36: 'Telangana',
  37: 'Andhra Pradesh', 38: 'Ladakh', 97: 'Other Territory', 99: 'Centre Jurisdiction',
};

// The check digit is computed in base 36 over these symbols, in this order.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The 15th character, computed from the first fourteen.
 *
 * Weights alternate 2 and 1 from the right; each product is folded by adding
 * its quotient and remainder in base 36, and the check digit is whatever
 * brings the total to a multiple of 36.
 */
function checkDigit(first14) {
  const mod = ALPHABET.length;
  let factor = 2;
  let sum = 0;

  for (let i = first14.length - 1; i >= 0; i--) {
    const codePoint = ALPHABET.indexOf(first14[i]);
    if (codePoint < 0) return null;
    let digit = factor * codePoint;
    factor = factor === 2 ? 1 : 2;
    digit = Math.floor(digit / mod) + (digit % mod);
    sum += digit;
  }
  return ALPHABET[(mod - (sum % mod)) % mod];
}

/*
 * Structure: 2 state digits, a 10-character PAN, an entity number, a letter
 * (Z for ordinary registrations), then the check digit.
 */
const SHAPE = /^([0-9]{2})([A-Z]{5}[0-9]{4}[A-Z])([0-9A-Z])([A-Z])([0-9A-Z])$/;

/**
 * The PAN's fourth character says what kind of holder it is.
 *
 * Worth surfacing because it explains a surprise: a customer registered as a
 * partnership whose GSTIN says "Individual" has usually pasted the wrong
 * number.
 */
const HOLDER = {
  P: 'Individual', C: 'Company', H: 'Hindu Undivided Family', F: 'Firm',
  A: 'Association of Persons', T: 'Trust', B: 'Body of Individuals',
  L: 'Local Authority', J: 'Artificial Juridical Person', G: 'Government',
};

/**
 * Check a GSTIN and pull out what it says.
 *
 * Always returns a shape rather than throwing: this runs across every party in
 * a customer's books, and one bad row must not stop the report.
 */
function parseGstin(raw) {
  const value = String(raw || '').trim().toUpperCase();

  if (!value) {
    return { value: '', valid: false, reason: 'missing', message: 'No GSTIN.' };
  }
  if (value.length !== 15) {
    return {
      value, valid: false, reason: 'length',
      message: `A GSTIN is 15 characters; this is ${value.length}.`,
    };
  }

  const m = SHAPE.exec(value);
  if (!m) {
    return {
      value, valid: false, reason: 'shape',
      message: 'Not the shape of a GSTIN (2 digits, PAN, entity code, letter, check digit).',
    };
  }

  const [, state, pan, entity, z, check] = m;
  if (!STATES[state]) {
    return {
      value, valid: false, reason: 'state',
      message: `"${state}" is not a GST state code.`,
      stateCode: state,
    };
  }

  const expected = checkDigit(value.slice(0, 14));
  if (expected !== check) {
    return {
      value, valid: false, reason: 'checksum',
      // Naming the expected character makes a transcription error obvious.
      message: `Check digit is wrong — expected "${expected}", got "${check}". `
             + 'Usually a typo.',
      stateCode: state, stateName: STATES[state], pan,
    };
  }

  return {
    value,
    valid: true,
    stateCode: state,
    stateName: STATES[state],
    pan,
    entityNumber: entity,
    holderType: HOLDER[pan[3]] ?? 'Unknown',
    // Z is the ordinary case; anything else is unusual enough to mention.
    isRegular: z === 'Z',
    message: 'Valid.',
  };
}

const stateOf = (gstin) => STATES[String(gstin || '').slice(0, 2)] ?? '';

/** Same state means CGST + SGST; different states mean IGST. */
function placeOfSupply(sellerGstin, buyerGstin) {
  const a = String(sellerGstin || '').slice(0, 2);
  const b = String(buyerGstin || '').slice(0, 2);
  if (!a || !b || !STATES[a] || !STATES[b]) return null;
  return a === b ? 'intra' : 'inter';
}

module.exports = { parseGstin, checkDigit, stateOf, placeOfSupply, STATES, HOLDER };
