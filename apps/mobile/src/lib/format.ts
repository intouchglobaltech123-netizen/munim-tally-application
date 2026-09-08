/** Indian digit grouping: 25,48,000 - never 2,548,000. Money is integer paise. */
/**
 * Money, the way this company asked to see it.
 *
 * `format` and `decimals` come from the company's settings rather than being
 * fixed: an Indian retailer wants 12,34,567 with no paise, and an exporter
 * billing abroad wants 1,234,567.00. Both are correct - for different people -
 * so neither can be hard-coded.
 *
 * Compact form (L / Cr) stays Indian in both cases, because "1.2 Cr" is what
 * anyone reading a rupee figure expects, whatever the grouping.
 */
export function inr(paise: number, opts: {
  compact?: boolean;
  format?: 'indian' | 'international';
  decimals?: number;
  symbol?: string;
} = {}): string {
  const rupees = (paise ?? 0) / 100;
  const decimals = opts.decimals ?? 0;
  const symbol = opts.symbol ?? '\u20b9';

  if (opts.compact) {
    const abs = Math.abs(rupees);
    const sign = rupees < 0 ? '-' : '';
    if (abs >= 1e7) return `${sign}${symbol}${(abs / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `${sign}${symbol}${(abs / 1e5).toFixed(2)} L`;
  }

  const locale = opts.format === 'international' ? 'en-US' : 'en-IN';
  const body = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(rupees);

  // Built by hand rather than with style:'currency', so a company whose base
  // currency is not the rupee still gets its own symbol in front.
  return rupees < 0 ? `-${symbol}${body.slice(1)}` : `${symbol}${body}`;
}

export function shortDate(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN',
    { day: '2-digit', month: 'short', year: '2-digit' });
}

/** A figure with no freshness label is a figure nobody trusts. */
export function ago(iso?: string | null): string {
  if (!iso) return 'never';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} hr ago`;
  return `${Math.floor(secs / 86400)} days ago`;
}

/** Hide every figure with one tap: owners open this app in front of staff. */
export const mask = (s: string) => s.replace(/[0-9]/g, '•');
