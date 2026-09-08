'use strict';
const crypto = require('crypto');

/**
 * Encryption at rest for the things worth encrypting.
 *
 * A Munim backup is a customer's entire book - every sale, every party, every
 * price they buy at. It sat in a bytea column in plaintext, which means anybody
 * who ever gets a copy of the database, a stray pg_dump, a snapshot on a laptop,
 * a support engineer with read access, has all of it. Transport security does
 * nothing about that, and neither does disk encryption, which only protects a
 * disk somebody physically walks away with.
 *
 * The scheme is deliberately ordinary:
 *
 *   - AES-256-GCM. Authenticated, so a tampered ciphertext fails to open rather
 *     than decrypting to something plausible.
 *   - One master key, held outside the database, in the environment.
 *   - A per-tenant key derived from it with HKDF. Deriving costs nothing and
 *     means one tenant's compromised key is not every tenant's.
 *   - A fresh random IV per record. GCM fails catastrophically on IV reuse -
 *     reusing one leaks the XOR of two plaintexts and, worse, the auth key.
 *
 * The master key never touches the database. That separation is the entire
 * point: a stolen database without the key is noise.
 */

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;              // 96 bits, the size GCM is defined for
const KEY_BYTES = 32;

/**
 * Read the master key.
 *
 * Returned as null rather than throwing when unset, so a developer running the
 * project for the first time is not blocked by key management. Production is a
 * different matter and is handled in assertConfigured() below - shipping a
 * customer's books unencrypted because an environment variable was forgotten is
 * exactly the failure this module exists to prevent.
 */
function masterKey() {
  const raw = process.env.MUNIM_ENCRYPTION_KEY;
  if (!raw) return null;

  // Accept hex or base64, because both get pasted into deployment consoles.
  let key;
  if (/^[0-9a-f]{64}$/i.test(raw.trim())) key = Buffer.from(raw.trim(), 'hex');
  else key = Buffer.from(raw.trim(), 'base64');

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `MUNIM_ENCRYPTION_KEY must be 32 bytes (64 hex characters or 44 base64), `
      + `got ${key.length}. Generate one with: openssl rand -hex 32`);
  }
  return key;
}

const enabled = () => masterKey() !== null;

/**
 * Refuse to start a production server that would write plaintext books.
 *
 * Called once at boot. A warning would be wrong here: nobody reads a warning in
 * a log, the server would run happily for months, and the damage is only
 * discovered when the data is already out.
 */
function assertConfigured() {
  if (enabled()) return { encryption: 'on' };

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'MUNIM_ENCRYPTION_KEY is not set.\n\n'
      + 'Backups contain the whole of a customer\'s books and are not written '
      + 'unencrypted in production.\n'
      + 'Generate a key with:  openssl rand -hex 32\n'
      + 'Then set MUNIM_ENCRYPTION_KEY and keep a copy somewhere safe - '
      + 'without it, existing backups cannot be opened again.');
  }

  console.warn(
    '  ⚠ MUNIM_ENCRYPTION_KEY is not set: backups will be stored unencrypted.\n'
    + '    Fine for local development. The server refuses to start like this '
    + 'with NODE_ENV=production.');
  return { encryption: 'off' };
}

/**
 * One tenant's key, derived from the master.
 *
 * HKDF with the tenant id as info: same master, different key per tenant, and
 * no key material to store or rotate per tenant. The salt is fixed and public -
 * HKDF does not need a secret salt, and a per-record salt would have to be
 * stored alongside for no gain here.
 */
function tenantKey(orgId) {
  const master = masterKey();
  if (!master) return null;
  return Buffer.from(crypto.hkdfSync(
    'sha256', master, Buffer.from('munim/backup/v1'), Buffer.from(String(orgId)), KEY_BYTES));
}

/**
 * Encrypt a buffer for one tenant.
 *
 * Returns the envelope rather than a bare buffer: the IV and the auth tag are
 * not secret, but they are required to open it, and keeping them together with
 * the ciphertext is what stops a future refactor from separating them.
 */
function seal(orgId, plain) {
  const key = tenantKey(orgId);
  if (!key) return { alg: 'none', iv: null, tag: null, data: plain };

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { alg: ALG, iv, tag: cipher.getAuthTag(), data };
}

/**
 * Open a sealed buffer.
 *
 * A record written before the key existed carries alg 'none' and is returned as
 * it is - otherwise turning encryption on would strand every backup taken
 * before that moment.
 */
function open(orgId, { alg, iv, tag, data }) {
  if (!alg || alg === 'none') return data;

  const key = tenantKey(orgId);
  if (!key) {
    throw new Error(
      'This record is encrypted and MUNIM_ENCRYPTION_KEY is not set. '
      + 'It cannot be opened without the key it was written with.');
  }

  const decipher = crypto.createDecipheriv(alg, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    /*
     * GCM's authentication failed. Either the ciphertext was altered or the key
     * is not the one it was written with - and the two are indistinguishable
     * from here, which is why the message names both.
     */
    throw new Error(
      'This record could not be decrypted. Either it was altered, or the '
      + 'encryption key is not the one it was written with.');
  }
}

/** A key somebody can paste into their deployment. */
const generateKey = () => crypto.randomBytes(KEY_BYTES).toString('hex');

module.exports = { seal, open, enabled, assertConfigured, generateKey, tenantKey, ALG };
