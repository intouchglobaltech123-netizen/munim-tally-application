'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/useApi';
import { useMoney } from '../lib/money';
import { type SearchResults, type SearchHit, type SearchOptions } from '../lib/api';
import {
  Search, X, Users, Truck, Package, Receipt, ShoppingCart, FileText,
  Wallet, SlidersHorizontal, CornerDownLeft,
} from 'lucide-react';

/**
 * One box that finds anything.
 *
 * Opens on Ctrl-K, which is what anybody who uses software expects, and on a
 * click for everybody else. The results are grouped by kind because "Royal
 * Tiles the customer" and "the invoice mentioning Royal Tiles" are different
 * answers to the same three letters.
 */

const ICON: Record<string, typeof Users> = {
  customer: Users, supplier: Truck, ledger: Wallet, item: Package,
  invoice: Receipt, purchase: ShoppingCart, payment: Wallet,
  order: FileText, bill: Receipt,
};

function href(hit: SearchHit): string {
  const l = hit.link ?? {};
  if (l.screen === 'party') return `/parties/${encodeURIComponent(l.name ?? '')}`;
  if (l.screen === 'item') return `/items/${encodeURIComponent(l.name ?? '')}`;
  if (l.screen === 'voucher') return `/invoice/${l.id}`;
  return '/';
}

export default function GlobalSearch() {
  const { company } = useAuth();
  const money = useMoney();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState('');
  const [amount, setAmount] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [type, setType] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  /*
   * Debounced, because this fires a handful of queries per keystroke.
   *
   * 200ms is below what a person notices and above what a fast typist
   * generates - it turns "royal" from six searches into one.
   */
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 200);
    return () => clearTimeout(t);
  }, [term]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => input.current?.focus(), 10);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const qs = new URLSearchParams({ q: debounced, limit: '6' });
  if (kind) qs.set('kind', kind);
  if (amount) qs.set('amount', amount);
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (type) qs.set('type', type);

  const hasQuery = debounced.length >= 2 || !!from || !!to || !!type;
  const results = useApi<SearchResults>(
    open && company && hasQuery
      ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/search?${qs}` : null,
    [debounced, kind, amount, from, to, type]);
  const opts = useApi<SearchOptions>(
    open && company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/search-options` : null,
    [company?.tallyGuid]);

  // Flattened so arrow keys walk the whole list, not one group at a time.
  const flat = (results.data?.groups ?? []).flatMap((g) =>
    g.results.map((r) => ({ ...r, group: g.label })));

  useEffect(() => setCursor(0), [debounced, kind]);

  function go(hit: SearchHit) {
    setOpen(false);
    setTerm('');
    router.push(href(hit));
  }

  const filtered = !!(kind || amount || from || to || type);

  return (
    <>
      <button onClick={() => { setOpen(true); setTimeout(() => input.current?.focus(), 10); }}
        className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5
                   text-sm text-faint transition hover:border-line">
        <Search size={15} />
        <span className="hidden sm:inline">Search</span>
        <kbd className="ml-2 hidden rounded bg-line-soft px-1.5 py-0.5 text-[10px]
                        font-semibold text-muted sm:inline">Ctrl K</kbd>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-4 sm:pt-24"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-surface shadow-2xl">
            <div className="flex items-center gap-2 border-b border-line px-4">
              <Search size={17} className="shrink-0 text-faint" />
              <input ref={input} value={term} onChange={(e) => setTerm(e.target.value)}
                placeholder="A customer, an item, an invoice number, a GSTIN…"
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, flat.length - 1)); }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
                  if (e.key === 'Enter' && flat[cursor]) go(flat[cursor]);
                }}
                className="flex-1 py-3.5 text-sm outline-none placeholder:text-faint" />
              <button onClick={() => setShowFilters(!showFilters)}
                aria-label="Filters"
                className={`rounded p-1.5 transition ${
                  filtered ? 'bg-warn-soft text-warn' : 'text-faint hover:bg-line-soft'}`}>
                <SlidersHorizontal size={15} />
              </button>
              <button onClick={() => setOpen(false)} aria-label="Close"
                className="rounded p-1.5 text-faint hover:bg-line-soft">
                <X size={15} />
              </button>
            </div>

            {showFilters && (
              <div className="border-b border-line bg-canvas p-3">
                <div className="flex flex-wrap gap-1.5">
                  {(opts.data?.kinds ?? []).map((k) => (
                    <button key={k.key} onClick={() => setKind(k.key)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                        kind === k.key ? 'bg-brand-700 text-white'
                          : 'bg-surface text-body ring-1 ring-line hover:bg-line-soft'}`}>
                      {k.label}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input value={amount} onChange={(e) => setAmount(e.target.value)}
                    placeholder="Amount, e.g. >10000"
                    className="w-40 rounded-lg border border-line px-2.5 py-1.5 text-xs" />
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                    className="rounded-lg border border-line px-2.5 py-1.5 text-xs" />
                  <span className="text-xs text-faint">to</span>
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                    className="rounded-lg border border-line px-2.5 py-1.5 text-xs" />
                  <select value={type} onChange={(e) => setType(e.target.value)}
                    className="rounded-lg border border-line px-2.5 py-1.5 text-xs">
                    <option value="">Any voucher type</option>
                    {(opts.data?.voucherTypes ?? []).map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                  {filtered && (
                    <button onClick={() => { setKind(''); setAmount(''); setFrom(''); setTo(''); setType(''); }}
                      className="text-xs font-semibold text-negative">Clear</button>
                  )}
                </div>
              </div>
            )}

            <div className="max-h-[60vh] overflow-auto">
              {!hasQuery ? (
                <p className="px-4 py-10 text-center text-sm text-faint">
                  Type a name, a number, a GSTIN or a phone number.
                </p>
              ) : results.loading && !results.data ? (
                <p className="px-4 py-10 text-center text-sm text-faint">Looking…</p>
              ) : results.data?.total === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-faint">
                  {results.data.hint}
                </p>
              ) : (
                (results.data?.groups ?? []).map((g) => (
                  <div key={g.kind}>
                    <div className="sticky top-0 bg-canvas px-4 py-1.5 text-[11px]
                                    font-bold uppercase tracking-wide text-muted">
                      {g.label}
                    </div>
                    {g.results.map((r) => {
                      const idx = flat.findIndex((x) => x.title === r.title && x.group === g.label);
                      const I = ICON[g.kind] ?? Receipt;
                      return (
                        <button key={`${g.kind}-${r.title}`} onClick={() => go(r)}
                          onMouseEnter={() => setCursor(idx)}
                          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left
                                      transition ${idx === cursor ? 'bg-brand-50' : 'hover:bg-canvas'}`}>
                          <I size={15} className="shrink-0 text-faint" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-ink">{r.title}</div>
                            {r.subtitle && (
                              <div className="truncate text-xs text-muted">{r.subtitle}</div>
                            )}
                          </div>
                          <div className="shrink-0 text-sm font-semibold tabular-nums text-body">
                            {money(Math.abs(r.amountPaise))}
                          </div>
                          {idx === cursor && (
                            <CornerDownLeft size={13} className="shrink-0 text-faint" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
