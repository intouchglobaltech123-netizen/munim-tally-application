/*
 * The camera, for scanning a code.
 *
 * Loaded at runtime for exactly the reason notify.ts explains: expo-camera is
 * native code, so on a build made before it was added a plain import takes the
 * whole app down as the bundle loads - before a single screen renders. Scanning
 * is a convenience; the books are the product.
 *
 * Two things get scanned in this app, and they are different problems:
 *
 *   - The pairing code the connector shows on the PC. Typing "int_" and twelve
 *     characters off one screen into another is where setup goes wrong.
 *   - A product barcode, to find that item in the stock list. A shopkeeper with
 *     the box in their hand knows the barcode and not the spelling of the name
 *     somebody typed into Tally three years ago.
 */

type CameraModule = typeof import('expo-camera');

let mod: CameraModule | null = null;
let looked = false;

export function camera(): CameraModule | null {
  if (looked) return mod;
  looked = true;
  try {
    /*
     * Ask whether the native side exists BEFORE loading the package, the same
     * way notify.ts does - so a module that throws at import time on an older
     * build is never evaluated at all.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const core = require('expo-modules-core');
    const native = core.requireOptionalNativeModule?.('ExpoCamera');
    if (!native) { mod = null; return mod; }

    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    mod = require('expo-camera') as CameraModule;
  } catch {
    mod = null;
  }
  return mod;
}

/** Whether this build can scan at all. Screens use it to hide the button. */
export const canScan = () => camera() !== null;

/**
 * Why it is unavailable, in words a shopkeeper can act on.
 *
 * "Scanning is not available" tells somebody nothing. Either their app is old
 * and an update fixes it, or they said no to the camera and can say yes.
 */
export const whyNot = () =>
  canScan()
    ? ''
    : 'Scanning needs a newer version of the app. Update from the Play Store and '
      + 'the button will appear.';

/**
 * A pairing code, out of whatever the QR actually contained.
 *
 * The connector's QR holds a full link so that scanning it with the phone's own
 * camera app does something sensible too. This accepts either that or a bare
 * code, because the two are indistinguishable to somebody holding a phone.
 */
export function pairingCodeFrom(raw: string): string | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const direct = text.match(/\b(int_[A-Za-z0-9_-]{8,})\b/);
  if (direct) return direct[1];

  try {
    const url = new URL(text);
    const fromQuery = url.searchParams.get('code') || url.searchParams.get('pair');
    if (fromQuery && /^int_/.test(fromQuery)) return fromQuery;
  } catch {
    // Not a URL. Falls through to null, which the caller reports plainly.
  }
  return null;
}

/**
 * A barcode, cleaned up.
 *
 * Scanners and printed labels disagree about leading zeros and about whether a
 * UPC-A is written as 12 or 13 digits, so the raw value is kept AND a normalised
 * form is offered for matching. Guessing one would miss the other.
 */
export function barcodeForms(raw: string): string[] {
  const text = String(raw ?? '').trim();
  if (!text) return [];

  const forms = new Set<string>([text]);
  const digits = text.replace(/\D/g, '');
  if (digits) {
    forms.add(digits);
    forms.add(digits.replace(/^0+/, ''));
    // A 12-digit UPC-A is the same product as the 13-digit EAN with a leading 0.
    if (digits.length === 12) forms.add(`0${digits}`);
    if (digits.length === 13 && digits.startsWith('0')) forms.add(digits.slice(1));
  }
  return [...forms].filter(Boolean);
}
