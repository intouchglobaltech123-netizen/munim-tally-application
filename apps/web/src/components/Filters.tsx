'use client';

import { useState } from 'react';
import { Filter, X, ChevronDown, Search } from 'lucide-react';
import { type FilterSpec, type FilterValues, activeCount, isSet } from '../lib/filters';

export { matches, useFiltered, activeCount } from '../lib/filters';
export type { FilterSpec, FilterValues } from '../lib/filters';

/**
 * One filter strip, described rather than hand-built.
 *
 * Every list in Munim wants the same four or five things - find a name, limit
 * to a date range, limit to an amount range, pick from a set, show only the
 * unpaid ones - and before this each page grew its own. That is why the
 * outstanding screen searched on party name while the ledger searched on
 * narration and neither could do both: nobody was going to write it five more
 * times by hand.
 *
 * So a page declares what it can be filtered by and gets the strip, the active
 * chips, the clear-all and the matching logic from here.
 */

const field = 'rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink '
  + 'outline-none transition focus:border-brand-600';

export default function Filters<T>({ specs, values, onChange, children }: {
  specs: FilterSpec<T>[];
  values: FilterValues;
  onChange: (v: FilterValues) => void;
  /** Anything the page wants to sit on the same line, such as a view toolbar. */
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const set = (k: string, v: string) => onChange({ ...values, [k]: v });
  const n = activeCount(values);

  // The search box earns its place on the strip itself: it is used far more
  // than everything else put together, and burying it behind a disclosure
  // would cost a click on almost every visit.
  const search = specs.find((s) => s.kind === 'search');
  const rest = specs.filter((s) => s !== search);

  /** The chips, so an unexpectedly short list explains itself. */
  const chips: { key: string; text: string }[] = [];
  for (const s of specs) {
    if (s.kind === 'search' && isSet(values[s.key])) {
      chips.push({ key: s.key, text: `${s.label}: ${values[s.key]}` });
    } else if (s.kind === 'select' && isSet(values[s.key])) {
      const opt = s.options.find((o) => o.value === values[s.key]);
      chips.push({ key: s.key, text: `${s.label}: ${opt?.label ?? values[s.key]}` });
    } else if (s.kind === 'toggle' && values[s.key] === 'on') {
      chips.push({ key: s.key, text: s.label });
    } else if (s.kind === 'dateRange') {
      const f = values[`${s.key}From`]; const t = values[`${s.key}To`];
      if (isSet(f) || isSet(t)) {
        chips.push({ key: `${s.key}From`, text: `${s.label}: ${f || '…'} to ${t || '…'}` });
      }
    } else if (s.kind === 'amountRange') {
      const f = values[`${s.key}Min`]; const t = values[`${s.key}Max`];
      if (isSet(f) || isSet(t)) {
        chips.push({ key: `${s.key}Min`, text: `${s.label}: ₹${f || '0'} to ₹${t || '∞'}` });
      }
    }
  }

  const clearChip = (key: string) => {
    const next = { ...values };
    // A range is one chip but two values, so clear its partner too.
    for (const suffix of ['From', 'To', 'Min', 'Max']) {
      if (key.endsWith(suffix)) {
        const base = key.slice(0, -suffix.length);
        delete next[`${base}From`]; delete next[`${base}To`];
        delete next[`${base}Min`]; delete next[`${base}Max`];
      }
    }
    delete next[key];
    onChange(next);
  };

  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center gap-2">
        {search ? (
          <div className="relative min-w-52 flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={values[search.key] ?? ''}
              onChange={(e) => set(search.key, e.target.value)}
              placeholder={search.placeholder ?? `${search.label}…`}
              className={`${field} w-full pl-9`}
            />
          </div>
        ) : null}

        {rest.length > 0 ? (
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold
                        transition ${open || n > 0
                          ? 'border-brand-600 bg-brand-50 text-brand-800'
                          : 'border-line bg-surface text-body hover:bg-canvas'}`}
          >
            <Filter size={15} strokeWidth={2.25} />
            Filters
            {n > 0 ? (
              <span className="rounded-full bg-brand-700 px-1.5 text-xs font-bold text-white">{n}</span>
            ) : null}
            <ChevronDown size={14} className={open ? 'rotate-180 transition' : 'transition'} />
          </button>
        ) : null}

        {children}
      </div>

      {open && rest.length > 0 ? (
        <div className="mt-3 grid gap-3 rounded-xl border border-line bg-canvas p-4 sm:grid-cols-2 lg:grid-cols-3">
          {rest.map((s) => (
            <label key={s.key} className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-muted">
                {s.label}
              </span>

              {s.kind === 'select' ? (
                <select value={values[s.key] ?? ''} onChange={(e) => set(s.key, e.target.value)}
                  className={`${field} w-full`}>
                  <option value="">Any</option>
                  {s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : s.kind === 'toggle' ? (
                <button
                  onClick={() => set(s.key, values[s.key] === 'on' ? '' : 'on')}
                  className={`w-full rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                    values[s.key] === 'on'
                      ? 'border-brand-600 bg-brand-700 text-white'
                      : 'border-line bg-surface text-body hover:bg-canvas'}`}
                >
                  {values[s.key] === 'on' ? 'On' : 'Off'}
                </button>
              ) : s.kind === 'dateRange' ? (
                <div className="flex items-center gap-2">
                  <input type="date" value={values[`${s.key}From`] ?? ''}
                    onChange={(e) => set(`${s.key}From`, e.target.value)}
                    className={`${field} w-full`} />
                  <span className="text-xs text-muted">to</span>
                  <input type="date" value={values[`${s.key}To`] ?? ''}
                    onChange={(e) => set(`${s.key}To`, e.target.value)}
                    className={`${field} w-full`} />
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input type="number" inputMode="numeric" placeholder="Min ₹"
                    value={values[`${s.key}Min`] ?? ''}
                    onChange={(e) => set(`${s.key}Min`, e.target.value)}
                    className={`${field} w-full`} />
                  <span className="text-xs text-muted">to</span>
                  <input type="number" inputMode="numeric" placeholder="Max ₹"
                    value={values[`${s.key}Max`] ?? ''}
                    onChange={(e) => set(`${s.key}Max`, e.target.value)}
                    className={`${field} w-full`} />
                </div>
              )}
            </label>
          ))}
        </div>
      ) : null}

      {chips.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {chips.map((c) => (
            <button key={c.key} onClick={() => clearChip(c.key)}
              className="inline-flex items-center gap-1.5 rounded-full bg-line-soft px-3 py-1
                         text-xs font-semibold text-body transition hover:bg-brand-50">
              {c.text}
              <X size={12} strokeWidth={2.5} />
            </button>
          ))}
          <button onClick={() => onChange({})}
            className="text-xs font-semibold text-muted underline underline-offset-2 hover:text-ink">
            Clear all
          </button>
        </div>
      ) : null}
    </div>
  );
}
