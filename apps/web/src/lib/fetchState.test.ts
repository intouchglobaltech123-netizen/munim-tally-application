import { test } from 'node:test';
import assert from 'node:assert';
import { fetchState, shapeOf } from './fetchState.ts';

/**
 * What to show while a request is in flight.
 *
 * These three booleans decide whether pressing a filter feels instant or blanks
 * the page. The bug they exist to prevent: `data` was cleared the moment `path`
 * changed, so every filter press showed a spinner for a full round trip.
 */

test('a first load has nothing to show', () => {
  const s = fetchState(null, '/v1/companies/x/pulse?days=90', true);
  assert.equal(s.usable, false);
  assert.equal(s.loading, true, 'the only time a skeleton is right');
});

test('changing a filter keeps the figures on screen', () => {
  /*
   * The bug itself. Same endpoint, different parameter - the response has the
   * identical shape, so there is no reason to blank the page for it.
   */
  const s = fetchState(
    '/v1/companies/x/pulse?days=90', '/v1/companies/x/pulse?days=30', true);
  assert.equal(s.usable, true, 'the old figures stay up');
  assert.equal(s.loading, false, 'so no skeleton replaces them');
  assert.equal(s.refreshing, true, 'and they grey while the new ones come');
});

test('a settled request is neither loading nor refreshing', () => {
  const s = fetchState(
    '/v1/companies/x/pulse?days=30', '/v1/companies/x/pulse?days=30', false);
  assert.deepEqual(s, { usable: true, loading: false, refreshing: false });
});

test('a different report clears, because the shape differs', () => {
  /*
   * The reason the original code cleared so aggressively: rendering a Profit &
   * Loss screen over Trial Balance data crashes on a field that is not there.
   * That instinct was right - it was just applied to filters too.
   */
  const s = fetchState('/v1/companies/x/pnl', '/v1/companies/x/trial-balance', true);
  assert.equal(s.usable, false);
  assert.equal(s.loading, true);
});

test('switching company clears, even for the same report', () => {
  /*
   * The most important case here. The company id is in the PATH, so this
   * counts as a different endpoint - showing one business's figures while
   * another loads would be far worse than any flicker.
   */
  const s = fetchState(
    '/v1/companies/AAA/pulse?days=90', '/v1/companies/BBB/pulse?days=90', true);
  assert.equal(s.usable, false, 'one company\'s data must never render under another');
});

test('adding a query where there was none is still the same endpoint', () => {
  const s = fetchState(
    '/v1/companies/x/entries', '/v1/companies/x/entries?status=draft', true);
  assert.equal(s.usable, true);
  assert.equal(s.refreshing, true);
});

test('a null path shows nothing and asks for nothing', () => {
  // A screen with no company selected yet.
  const s = fetchState(null, null, false);
  assert.equal(s.loading, false, 'no spinner when there is nothing to fetch');
});

test('shapeOf ignores the query and nothing else', () => {
  assert.equal(shapeOf('/a/b?x=1&y=2'), '/a/b');
  assert.equal(shapeOf('/a/b'), '/a/b');
  assert.equal(shapeOf(null), null);
});
