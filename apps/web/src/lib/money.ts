'use client';

import { useCallback } from 'react';
import { useAuth } from './auth';
import { inr } from './api';

/**
 * Money formatted the way the open company asked for it.
 *
 * A hook rather than a bare function because the answer depends on which book
 * is open, and every screen already knows that through useAuth. Calling `inr`
 * directly still works and still gives Indian grouping with no paise - this is
 * the version that respects the customer's choice.
 */
export function useMoney() {
  const { company } = useAuth();
  const s = company?.settings;

  return useCallback((paise: number, opts: { compact?: boolean } = {}) =>
    inr(paise, {
      compact: opts.compact,
      format: s?.numberFormat ?? 'indian',
      decimals: s?.decimals ?? 0,
      symbol: s?.currency || '₹',
    }), [s?.numberFormat, s?.decimals, s?.currency]);
}

/** The same idea for dates, which Tally users are equally particular about. */
export function useDateFormat() {
  const { company } = useAuth();
  const fmt = company?.settings?.dateFormat ?? 'dd-mm-yyyy';

  return useCallback((iso: string | null | undefined) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    if (fmt === 'yyyy-mm-dd') return `${yyyy}-${mm}-${dd}`;
    if (fmt === 'mm-dd-yyyy') return `${mm}-${dd}-${yyyy}`;
    return `${dd}-${mm}-${yyyy}`;
  }, [fmt]);
}
