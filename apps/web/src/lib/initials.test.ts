import { test } from 'node:test';
import assert from 'node:assert';
import { initialsOf, toneIndex } from '../lib/initials.ts';

/**
 * Initials for a party disc.
 *
 * The point of the disc is that somebody can pick one customer out of forty
 * without reading, so what it shows has to be stable and has to distinguish.
 */

test('two words give two initials', () => {
  assert.equal(initialsOf('Royal Tiles'), 'RT');
  assert.equal(initialsOf('New Deepak Agency'), 'ND');
});

test('one word gives its first two letters', () => {
  // "M" alone distinguishes nothing in a list where four names start with M.
  assert.equal(initialsOf('Munim'), 'MU');
});

test('a prefixed trade name uses the name, not the prefix', () => {
  /*
   * Indian ledgers are full of "M/s." — if the prefix counted, half the list
   * would read MS and the disc would be useless.
   */
  assert.equal(initialsOf('M/s. Verma & Sons'), 'MV');
});

test('extra spacing does not change the answer', () => {
  assert.equal(initialsOf('  R & K   Hardware '), initialsOf('R & K Hardware'));
});

test('an empty name is marked rather than blank', () => {
  // A blank disc looks like a rendering fault; a question mark looks deliberate.
  assert.equal(initialsOf(''), '?');
  assert.equal(initialsOf('   '), '?');
});

test('initials are always upper case', () => {
  assert.equal(initialsOf('anand traders'), 'AT');
});

test('a name always gets the same colour', () => {
  /*
   * The whole reason the disc is useful. A colour that changes when the list is
   * re-sorted is worse than none, because the eye has already learned the old
   * one.
   */
  for (const name of ['Royal Tiles', 'R & K Hardware', 'Anand Traders']) {
    const first = toneIndex(name, 8);
    for (let i = 0; i < 50; i++) assert.equal(toneIndex(name, 8), first);
  }
});

test('colours spread across the palette rather than clumping', () => {
  // All eight used by a realistic list, or the disc stops distinguishing.
  const names = ['Royal Tiles', 'R & K Hardware', 'Anand Traders', 'Laxmi Distributors',
                 'New Deepak Agency', 'Perfect Electricals', 'M/s. Verma & Sons',
                 'Shree Traders', 'Bharat Steel', 'Kumar Enterprises',
                 'Sunrise Hardware', 'Metro Supplies'];
  const used = new Set(names.map((n) => toneIndex(n, 8)));
  assert.ok(used.size >= 5, `only ${used.size} of 8 colours used across 12 names`);
});

test('the index is always inside the palette', () => {
  for (const name of ['', 'A', 'ZZZZZZZZZZZZZZZZZZZZ', '数字', '!!!']) {
    const i = toneIndex(name, 8);
    assert.ok(i >= 0 && i < 8, `${name} gave index ${i}`);
  }
});
