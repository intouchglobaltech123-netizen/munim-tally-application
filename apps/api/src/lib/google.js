'use strict';
/**
 * Verifies Google ID tokens (Sign in with Google).
 *
 * Separate from firebase.js because these are different tokens: a Google ID
 * token is issued by accounts.google.com to an OAuth *client*, while a Firebase
 * ID token is issued by securetoken.google.com to a *project*. The signing keys
 * live at different URLs and the claim rules differ, so sharing one verifier
 * would mean a function that accepts either - and a token meant for one system
 * being honoured by the other is exactly the confusion to avoid.
 *
 * Why not go through Firebase on mobile too? Google blocks OAuth inside
 * embedded WebViews (disallowed_useragent, enforced since July 2023), so the
 * phone has to use the system browser and gets a Google token back directly.
 * Verifying it here avoids pulling the Firebase SDK into the app for one call.
 *
 * No dependencies: this is standard RS256 verification against Google's
 * published certificates.
 */

const crypto = require('crypto');

// Google's OAuth signing certificates, in the same x509 form as Firebase's.
const CERT_URL = 'https://www.googleapis.com/oauth2/v1/certs';

// Google issues with and without the scheme; both are documented as valid.
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

const CLOCK_SKEW_SECONDS = 60;

let cache = { certs: null, expiresAt: 0 };

async function getCerts(fetchImpl = fetch) {
  if (cache.certs && Date.now() < cache.expiresAt) return cache.certs;

  const res = await fetchImpl(CERT_URL);
  if (!res.ok) throw new Error(`could not fetch Google certificates (HTTP ${res.status})`);
  const certs = await res.json();

  // Honour Google's own cache lifetime: re-fetching per sign-in adds latency
  // and invites rate limiting, caching forever breaks on key rotation.
  const cc = res.headers.get('cache-control') || '';
  const maxAge = Number((cc.match(/max-age=(\d+)/) || [])[1]) || 3600;
  cache = { certs, expiresAt: Date.now() + maxAge * 1000 };
  return certs;
}

/** Only for tests: inject certificates and skip the network. */
function _setCerts(certs, ttlMs = 60_000) {
  cache = { certs, expiresAt: Date.now() + ttlMs };
}

const b64urlToBuf = (s) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const decodeJson = (part) => JSON.parse(b64urlToBuf(part).toString('utf8'));

class GoogleAuthError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_GOOGLE_TOKEN';
  }
}

/**
 * Verifies a Google ID token and returns its claims.
 *
 * @param {string}   idToken     the token from the app
 * @param {string[]} clientIds   every OAuth client that may legitimately have
 *                               issued it - Android, iOS and web are separate
 *                               client ids for the same product
 */
async function verifyIdToken(idToken, clientIds, deps = {}) {
  const allowed = (Array.isArray(clientIds) ? clientIds : [clientIds])
    .filter((c) => typeof c === 'string' && c);
  if (!allowed.length) {
    throw new GoogleAuthError('Google sign-in is not configured on this server.');
  }
  if (typeof idToken !== 'string' || idToken.length < 20) {
    throw new GoogleAuthError('That sign-in token is not valid.');
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) throw new GoogleAuthError('That sign-in token is malformed.');

  let header, payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    throw new GoogleAuthError('That sign-in token could not be read.');
  }

  // --- header ---------------------------------------------------------------
  // Refusing anything but RS256 is what stops "alg: none" and HMAC confusion,
  // where a forged token names an algorithm we would verify with a public value.
  if (header.alg !== 'RS256') throw new GoogleAuthError('Unexpected token algorithm.');
  if (!header.kid) throw new GoogleAuthError('Token is missing a key id.');

  // --- claims ---------------------------------------------------------------
  const now = Math.floor(Date.now() / 1000);

  // The audience check is what stops a token minted for a different app being
  // replayed against ours. Without it, any Google token would sign anyone in.
  if (!allowed.includes(payload.aud)) {
    throw new GoogleAuthError('Token was issued for another app.');
  }
  if (!ISSUERS.includes(payload.iss)) {
    throw new GoogleAuthError('Token has the wrong issuer.');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new GoogleAuthError('Token has no subject.');
  }
  if (typeof payload.exp !== 'number' || payload.exp < now - CLOCK_SKEW_SECONDS) {
    throw new GoogleAuthError('That sign-in has expired. Please try again.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > now + CLOCK_SKEW_SECONDS) {
    throw new GoogleAuthError('Token was issued in the future.');
  }

  // --- signature ------------------------------------------------------------
  const certs = await getCerts(deps.fetch ?? fetch);
  const cert = certs[header.kid];
  if (!cert) throw new GoogleAuthError('Token was signed with an unknown key.');

  const ok = crypto.createVerify('RSA-SHA256')
    .update(`${parts[0]}.${parts[1]}`)
    .verify(cert, b64urlToBuf(parts[2]));
  if (!ok) throw new GoogleAuthError('Token signature is not valid.');

  return {
    uid: payload.sub,
    email: payload.email || null,
    // Google sets this itself; an unverified address must never identify an
    // account, or anyone could claim someone else's by typing it.
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    name: payload.name || '',
    claims: payload,
  };
}

/**
 * The email a token CLAIMS, read WITHOUT verifying anything.
 *
 * Only ever for counting failed attempts against an address. The signature did
 * not check out, so nothing in here is true - it must never be used to find,
 * create or authorise an account. Named to make misuse obvious at the call
 * site.
 */
function unsafeEmailFromToken(idToken) {
  try {
    const part = String(idToken || '').split('.')[1];
    if (!part) return '';
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const email = String(json.email || '').trim().toLowerCase();
    // Shape check only, so a junk token cannot write junk into the log.
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.slice(0, 200) : '';
  } catch {
    return '';
  }
}

module.exports = {
  unsafeEmailFromToken, verifyIdToken, GoogleAuthError, _setCerts, CERT_URL, ISSUERS };
