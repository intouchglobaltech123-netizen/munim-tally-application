import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buttonWidth, friendlyGoogleError } from './google.ts';

/**
 * The sizing that broke sign-in on phones.
 *
 * Google draws its button inside an iframe of exactly the number of pixels it
 * is given and ignores CSS from outside, so getting this number wrong does not
 * make the button look odd - it puts part of the tap target off the screen.
 */

test('a narrow phone gets a button that fits', () => {
  // 360px screen, less the page padding and the card padding, is what the
  // button actually has. 320 - the old hard-coded value - did not fit.
  const available = 360 - 48 - 56;
  assert.equal(available, 256);
  assert.equal(buttonWidth(available), 256);
  assert.ok(buttonWidth(available) <= available, 'the button must fit its container');
});

test('the smallest common phone still gets a usable button', () => {
  // An iPhone SE is 320 CSS pixels wide, leaving 216.
  const available = 320 - 48 - 56;
  assert.equal(available, 216);
  assert.equal(buttonWidth(available), 216);
});

test('Google’s own bounds are respected', () => {
  // Outside 200-400 Google refuses to render at all, so clamp rather than
  // pass a number through and get nothing drawn.
  assert.equal(buttonWidth(120), 200, 'below the minimum clamps up');
  assert.equal(buttonWidth(900), 400, 'above the maximum clamps down');
  assert.equal(buttonWidth(200), 200);
  assert.equal(buttonWidth(400), 400);
});

test('a container that has not been measured yet still renders something', () => {
  // clientWidth is 0 before layout. Passing 0 through would draw nothing at
  // all, which looks exactly like the failure this was meant to fix.
  assert.equal(buttonWidth(0), 280);
  assert.equal(buttonWidth(-10), 280);
  assert.equal(buttonWidth(NaN), 280);
});

test('a fractional width is floored, never rounded up past the container', () => {
  assert.equal(buttonWidth(255.9), 255);
});

test('an origin failure names the address the browser is on', () => {
  // The old message said to authorise http://localhost:3000 whatever site you
  // were on, which sent people to add the wrong origin.
  const msg = friendlyGoogleError(new Error('The given origin is not allowed'));
  assert.match(msg, /Authorised JavaScript origins/);
  assert.doesNotMatch(msg, /localhost:3000/,
    'the message must not name a hard-coded address');
});

test('a network failure is not dressed up as a configuration problem', () => {
  assert.equal(friendlyGoogleError(new Error('Could not reach Google')),
    'No internet connection.');
});
