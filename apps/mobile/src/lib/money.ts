import { useCallback } from 'react';
import { useApp } from './store';
import { inr } from './format';

/**
 * Money formatted the way the open company asked for it.
 *
 * Mirrors the web hook exactly, so a figure reads identically on the phone and
 * in the browser. A customer comparing the two and finding different grouping
 * assumes one of them is wrong.
 */
export function useMoney() {
  const { company, privacy } = useApp();
  const s = company?.settings;

  return useCallback((paise: number, opts: { compact?: boolean } = {}) => {
    const text = inr(paise, {
      compact: opts.compact,
      format: s?.numberFormat ?? 'indian',
      decimals: s?.decimals ?? 0,
      symbol: s?.currency || '₹',
    });
    // Privacy is applied here rather than at each call site, so a screen added
    // later cannot forget it and leak a figure over the owner's shoulder.
    return privacy ? text.replace(/[\d.,]/g, '•') : text;
  }, [s?.numberFormat, s?.decimals, s?.currency, privacy]);
}
