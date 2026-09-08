import { test } from 'node:test';
import assert from 'node:assert';
import { offlineBar } from './offlineBar.ts';

const label = (ms: number) => `${Math.round(ms / 60000)} minutes ago`;

/**
 * When to interrupt somebody with a connection warning.
 *
 * The bug this pins down: the bar fired on every single click, because the hook
 * paints cached data before the fresh response lands and the bar keyed on the
 * age of that cache rather than on connectivity.
 */

test('an ordinary click shows nothing, even though it renders cached data first', () => {
  /*
   * The reported bug, exactly: connected, and briefly on cached figures. That
   * is the cache doing its job, not an outage worth a red bar.
   */
  assert.deepEqual(offlineBar(false, 120_000, label), { show: false });
});

test('a settled screen shows nothing', () => {
  assert.deepEqual(offlineBar(false, null, label), { show: false });
});

test('a real outage with no cached data says so plainly', () => {
  const bar = offlineBar(true, null, label);
  assert.equal(bar.show, true);
  assert.equal(bar.show && bar.text, 'No connection');
});

test('a real outage on cached data says how old the figures are', () => {
  /*
   * The age only matters here. A stale figure presented as current is how
   * somebody chases a customer who already paid.
   */
  const bar = offlineBar(true, 300_000, label);
  assert.equal(bar.show, true);
  assert.match(bar.show ? bar.text : '', /showing figures from 5 minutes ago/);
});

test('connectivity is the only trigger', () => {
  // Whatever the age, offline decides. Anything else reintroduces the flash.
  for (const age of [null, 0, 1_000, 60_000, 86_400_000]) {
    assert.equal(offlineBar(false, age, label).show, false, `age ${age} triggered it`);
    assert.equal(offlineBar(true, age, label).show, true, `age ${age} suppressed it`);
  }
});
