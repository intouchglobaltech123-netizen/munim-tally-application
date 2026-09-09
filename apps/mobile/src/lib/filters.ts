/**
 * What a list can be filtered by, and whether a row survives it.
 *
 * Kept apart from the component so it can be tested directly: the matching
 * rules are where the judgement calls live - magnitude for amounts, unset
 * versus zero - and those are worth pinning down in tests rather than
 * checking by eye through a browser.
 */

import { useMemo } from 'react';

export type FilterSpec<T> =
  | { key: string; label: string; kind: 'search'; on: (row: T) => string; placeholder?: string }
  | { key: string; label: string; kind: 'select'; options: { value: string; label: string }[];
      on: (row: T) => string | null | undefined }
  | { key: string; label: string; kind: 'toggle'; on: (row: T) => boolean }
  | { key: string; label: string; kind: 'dateRange'; on: (row: T) => string | null | undefined }
  /** Amounts arrive as integer paise; the box is in rupees, because people type rupees. */
  | { key: string; label: string; kind: 'amountRange'; on: (row: T) => number | null | undefined };

export type FilterValues = Record<string, string>;

/** Unset and empty are the same thing here; zero is not. */
export const isSet = (v: string | undefined) => v !== undefined && v !== '';

/**
 * Whether one row survives the current filters.
 *
 * Unset filters are skipped rather than treated as empty, which is the
 * difference between "no minimum" and "minimum of zero" - and with amounts
 * those are genuinely different questions once credit notes exist.
 */
export function matches<T>(row: T, specs: FilterSpec<T>[], values: FilterValues): boolean {
  for (const spec of specs) {
    if (spec.kind === 'search') {
      const q = values[spec.key];
      if (!isSet(q)) continue;
      if (!String(spec.on(row) ?? '').toLowerCase().includes(q.toLowerCase())) return false;
    } else if (spec.kind === 'select') {
      const want = values[spec.key];
      if (!isSet(want)) continue;
      if (String(spec.on(row) ?? '') !== want) return false;
    } else if (spec.kind === 'toggle') {
      if (values[spec.key] !== 'on') continue;
      if (!spec.on(row)) return false;
    } else if (spec.kind === 'dateRange') {
      const from = values[`${spec.key}From`];
      const to = values[`${spec.key}To`];
      if (!isSet(from) && !isSet(to)) continue;
      // Dates are ISO yyyy-mm-dd, so string comparison is date comparison.
      const d = String(spec.on(row) ?? '').slice(0, 10);
      if (!d) return false;
      if (isSet(from) && d < from) return false;
      if (isSet(to) && d > to) return false;
    } else {
      const min = values[`${spec.key}Min`];
      const max = values[`${spec.key}Max`];
      if (!isSet(min) && !isSet(max)) continue;
      const paise = Number(spec.on(row) ?? 0);
      // Compare on magnitude: a bill for -5,000 is still a five thousand
      // rupee bill, and someone filtering "over 1,000" means to see it.
      const abs = Math.abs(paise);
      if (isSet(min) && abs < Number(min) * 100) return false;
      if (isSet(max) && abs > Number(max) * 100) return false;
    }
  }
  return true;
}

/** Applies the whole strip to a list. */
export function useFiltered<T>(rows: T[], specs: FilterSpec<T>[], values: FilterValues): T[] {
  return useMemo(
    () => rows.filter((r) => matches(r, specs, values)),
    // specs are rebuilt each render by design; the values are what change.
    [rows, values], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** How many filters are actually doing something, for the badge on the button. */
export function activeCount(values: FilterValues): number {
  return Object.values(values).filter((v) => isSet(v)).length;
}
