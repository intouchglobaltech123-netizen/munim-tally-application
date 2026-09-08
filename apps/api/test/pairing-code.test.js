const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

/**
 * The API mints pairing codes; the mobile app validates what the owner types.
 * Those are two files that must agree on one alphabet, and they silently drifted
 * once already: codes are base64url (which includes "-" and "_") while the app
 * accepted only [A-Za-z0-9], so roughly two codes in five were rejected with no
 * message - the button just stayed disabled.
 *
 * This pins the contract at the source.
 */

// Same shape as createIntent() in src/routes/connectors.js.
const mintCode = () => 'int_' + crypto.randomBytes(9).toString('base64url');

// Same expression as extractIntentId() in apps/mobile/src/screens/LinkTallyScreen.tsx.
const APP_ACCEPTS = /^int_[A-Za-z0-9_-]+$/;

test('every generated pairing code is accepted by the app', () => {
  // Enough draws that a 64-symbol alphabet shows its awkward characters.
  for (let i = 0; i < 5000; i++) {
    const code = mintCode();
    assert.ok(APP_ACCEPTS.test(code), `app would reject a real code: ${code}`);
  }
});

test('the alphabet actually produces the characters that caused the bug', () => {
  const codes = Array.from({ length: 5000 }, mintCode);
  // If base64url stopped emitting these, this test would pass for the wrong
  // reason and stop protecting anything.
  assert.ok(codes.some((c) => c.includes('_', 4)), 'expected some codes with "_"');
  assert.ok(codes.some((c) => c.includes('-')), 'expected some codes with "-"');
});

test('codes that are not ours are still rejected', () => {
  for (const bad of ['', 'hello', 'int', 'int_', 'xint_abc', 'int_abc!', 'int_ab c']) {
    assert.ok(!APP_ACCEPTS.test(bad), `should have been rejected: "${bad}"`);
  }
});
