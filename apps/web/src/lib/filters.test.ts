import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matches, activeCount, isSet, type FilterSpec } from './filters.ts';

type Bill = { party: string; date: string; amount: number; kind: string; overdue: boolean };

const bill = (over: Partial<Bill> = {}): Bill => ({
  party: 'M/s. Verma & Sons',
  date: '2026-04-15',
  amount: 250000,          // Rs 2,500 in paise
  kind: 'sales',
  overdue: false,
  ...over,
});

const specs: FilterSpec<Bill>[] = [
  { key: 'q', label: 'Party', kind: 'search', on: (b) => b.party },
  { key: 'kind', label: 'Type', kind: 'select', on: (b) => b.kind,
    options: [{ value: 'sales', label: 'Sales' }, { value: 'purchase', label: 'Purchase' }] },
  { key: 'overdue', label: 'Overdue only', kind: 'toggle', on: (b) => b.overdue },
  { key: 'date', label: 'Date', kind: 'dateRange', on: (b) => b.date },
  { key: 'amt', label: 'Amount', kind: 'amountRange', on: (b) => b.amount },
];

test('no filters means everything passes', () => {
  assert.equal(matches(bill(), specs, {}), true);
});

test('search is case-insensitive and matches inside the name', () => {
  assert.equal(matches(bill(), specs, { q: 'verma' }), true);
  assert.equal(matches(bill(), specs, { q: 'VERMA' }), true);
  assert.equal(matches(bill(), specs, { q: 'sons' }), true);
  assert.equal(matches(bill(), specs, { q: 'gupta' }), false);
});

test('an empty filter is not a filter', () => {
  // Typing into the search box and deleting it again must not hide every row.
  assert.equal(matches(bill(), specs, { q: '' }), true);
  assert.equal(matches(bill(), specs, { kind: '' }), true);
});

test('a toggle only filters when it is on', () => {
  assert.equal(matches(bill({ overdue: false }), specs, {}), true);
  assert.equal(matches(bill({ overdue: false }), specs, { overdue: 'on' }), false);
  assert.equal(matches(bill({ overdue: true }), specs, { overdue: 'on' }), true);
});

test('date range is inclusive at both ends', () => {
  const b = bill({ date: '2026-04-15' });
  assert.equal(matches(b, specs, { dateFrom: '2026-04-15' }), true);
  assert.equal(matches(b, specs, { dateTo: '2026-04-15' }), true);
  assert.equal(matches(b, specs, { dateFrom: '2026-04-16' }), false);
  assert.equal(matches(b, specs, { dateTo: '2026-04-14' }), false);
});

test('a date arriving with a time on it still compares by day', () => {
  // Postgres hands back timestamps often enough that this is worth pinning.
  const b = bill({ date: '2026-04-15T18:30:00.000Z' });
  assert.equal(matches(b, specs, { dateFrom: '2026-04-15', dateTo: '2026-04-15' }), true);
});

test('amounts are typed in rupees but held in paise', () => {
  const b = bill({ amount: 250000 });                 // Rs 2,500
  assert.equal(matches(b, specs, { amtMin: '2500' }), true);
  assert.equal(matches(b, specs, { amtMin: '2501' }), false);
  assert.equal(matches(b, specs, { amtMax: '2500' }), true);
  assert.equal(matches(b, specs, { amtMax: '2499' }), false);
});

test('a credit note is filtered on its size, not its sign', () => {
  // Someone asking for bills over Rs 1,000 means to see a Rs 5,000 credit
  // note. Comparing the raw negative would silently drop every one of them.
  const refund = bill({ amount: -500000 });
  assert.equal(matches(refund, specs, { amtMin: '1000' }), true);
});

test('a zero minimum is a real filter, not an absent one', () => {
  assert.equal(isSet('0'), true);
  assert.equal(isSet(''), false);
  assert.equal(isSet(undefined), false);
});

test('filters combine with and, not or', () => {
  const b = bill({ kind: 'sales', overdue: true });
  assert.equal(matches(b, specs, { kind: 'sales', overdue: 'on' }), true);
  assert.equal(matches(b, specs, { kind: 'purchase', overdue: 'on' }), false);
});

test('a row missing the field it is filtered on drops out', () => {
  const undated = bill({ date: '' });
  assert.equal(matches(undated, specs, { dateFrom: '2026-01-01' }), false);
  // ...but survives when that filter is not being applied.
  assert.equal(matches(undated, specs, { q: 'verma' }), true);
});

test('the badge counts what is actually set', () => {
  assert.equal(activeCount({}), 0);
  assert.equal(activeCount({ q: '', kind: '' }), 0);
  assert.equal(activeCount({ q: 'verma', kind: 'sales' }), 2);
  // A range that is half-filled is one active filter, not two.
  assert.equal(activeCount({ amtMin: '100', amtMax: '' }), 1);
});
