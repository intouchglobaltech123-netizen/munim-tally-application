import type { LucideIcon } from 'lucide-react';
import { initialsOf, toneIndex } from '../lib/initials';
import { TrendingUp, TrendingDown, Minus, WifiOff } from 'lucide-react';
import { offlineBar } from '../lib/offlineBar';
import { ageLabel } from '../lib/cache';
import { inr } from '../lib/api';

/**
 * The shared pieces every screen is built from.
 *
 * A few decisions that hold the whole product together:
 *
 * - One card, one border, one radius, one shadow. Several depths on one screen
 *   reads as indecision.
 * - Figures are tabular and tracked slightly tight. Money in a column that does
 *   not line up is the single clearest sign of an unfinished interface.
 * - Labels are small, uppercase and muted; the number is large and dark. The
 *   eye should land on the figure, never on the word above it.
 */

/**
 * Says the figures on screen are not current.
 *
 * The rule: never show stale numbers as if they were live. Somebody deciding
 * whether to chase a payment needs to know they are looking at this morning's
 * position, not this minute's - and a small grey line does not carry that.
 *
 * Nothing to dismiss. It goes when real data arrives, which is the only thing
 * that should make it go.
 */
/**
 * Shown only when the server genuinely cannot be reached.
 *
 * It used to appear whenever `ageMs` was set - and `ageMs` is set on EVERY
 * navigation, because the hook paints cached figures for the few hundred
 * milliseconds before the fresh ones land. So every single click flashed
 * "No connection" and then took it away again, which is worse than useless:
 * a warning that cries wolf on every click is one nobody reads when it is real.
 *
 * Being briefly on cached data is not an outage. It is the cache working. The
 * only thing worth interrupting somebody for is not being able to reach the
 * server at all - and then the age matters, because a stale figure presented as
 * current is how somebody chases the wrong customer.
 */
export function OfflineBar({ offline, ageMs }: { offline: boolean; ageMs: number | null }) {
  const bar = offlineBar(offline, ageMs, ageLabel);
  if (!bar.show) return null;
  return (
    <div className="mb-5 flex items-center gap-2.5 rounded-xl bg-negative-soft px-4
                    py-2.5 text-sm font-medium text-negative">
      <WifiOff size={15} strokeWidth={2.2} className="shrink-0" />
      {bar.text}
    </div>
  );
}

export function Card({ children, className = '' }: {
  children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-line bg-surface shadow-[0_1px_2px_rgba(6,53,31,0.04),0_8px_24px_-12px_rgba(6,53,31,0.10)] ${className}`}>
      {className.includes('p-0') ? children : <div className="p-5">{children}</div>}
    </div>
  );
}

export function SectionTitle({ children, note, icon: Icon }: {
  children: React.ReactNode; note?: string; icon?: LucideIcon;
}) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
        {Icon ? <Icon size={13} strokeWidth={2.25} className="text-faint" /> : null}
        {children}
      </h2>
      {note ? <span className="text-xs text-faint">{note}</span> : null}
    </div>
  );
}

export function PageTitle({ title, subtitle, right }: {
  title: string; subtitle?: string; right?: React.ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="truncate text-[27px] font-bold leading-tight tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1.5 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {right}
    </header>
  );
}

/**
 * The headline figure.
 *
 * Compact (L / Cr) because ₹1,15,13,410 is unreadable at a glance and these are
 * read at a glance. The exact value sits underneath for anyone who needs it -
 * an accountant always does.
 */
export function StatTile({ label, paise, sub, tone = 'neutral', icon: Icon }: {
  label: string; paise: number; sub?: React.ReactNode;
  tone?: 'good' | 'bad' | 'neutral'; icon?: LucideIcon;
}) {
  const toneClass = tone === 'good' ? 'text-positive'
    : tone === 'bad' ? 'text-negative' : 'text-ink';
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {label}
        </div>
        {Icon ? (
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-50">
            <Icon size={14} strokeWidth={2.25} className="text-brand-700" />
          </span>
        ) : null}
      </div>
      <div className={`figure mt-2 text-[26px] font-bold leading-none ${toneClass}`}>
        {inr(paise, { compact: true })}
      </div>
      <div className="figure mt-1.5 text-xs text-faint">{inr(paise)}</div>
      {sub ? <div className="mt-3 text-xs">{sub}</div> : null}
    </Card>
  );
}

export function CountTile({ label, value, sub, icon: Icon }: {
  label: string; value: string; sub?: string; icon?: LucideIcon;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {label}
        </div>
        {Icon ? (
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand-50">
            <Icon size={14} strokeWidth={2.25} className="text-brand-700" />
          </span>
        ) : null}
      </div>
      <div className="figure mt-2 text-[26px] font-bold leading-none">{value}</div>
      {sub ? <div className="mt-1.5 text-xs text-faint">{sub}</div> : null}
    </Card>
  );
}

/** Change against the previous period, with the arrow doing the explaining. */
export function Delta({ pct, label = 'vs last month' }: {
  pct: number | null | undefined; label?: string;
}) {
  if (pct === null || pct === undefined) {
    return <span className="text-faint">no earlier period</span>;
  }
  const flat = Math.abs(pct) < 0.05;
  const Icon = flat ? Minus : pct > 0 ? TrendingUp : TrendingDown;
  const tone = flat ? 'text-muted' : pct > 0 ? 'text-positive' : 'text-negative';
  return (
    <span className={`inline-flex items-center gap-1 font-semibold ${tone}`}>
      <Icon size={13} strokeWidth={2.5} />
      {flat ? 'flat' : `${pct > 0 ? '+' : ''}${pct}%`}
      <span className="font-normal text-faint">{label}</span>
    </span>
  );
}

export function Badge({ children, tone = 'ok' }: {
  children: React.ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'muted';
}) {
  const style = {
    ok:    'bg-positive-soft text-positive',
    warn:  'bg-warn-soft text-warn',
    bad:   'bg-negative-soft text-negative',
    muted: 'bg-line-soft text-muted',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1
                      text-xs font-semibold ${style}`}>
      {children}
    </span>
  );
}

export function Button({ children, variant = 'primary', icon: Icon, ...rest }: {
  children: React.ReactNode; variant?: 'primary' | 'ghost' | 'danger'; icon?: LucideIcon;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base = 'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 '
    + 'text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed';
  const style = {
    primary: 'bg-brand-700 text-white hover:bg-brand-800 active:bg-brand-900',
    ghost:   'border border-line bg-surface text-ink hover:border-faint hover:bg-canvas',
    danger:  'bg-negative text-white hover:opacity-90',
  }[variant];
  return (
    <button {...rest} className={`${base} ${style} ${rest.className ?? ''}`}>
      {Icon ? <Icon size={15} strokeWidth={2.25} /> : null}
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-16 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-brand-600" />
      {label ?? 'Loading…'}
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="border-negative-soft">
      <p className="text-sm text-negative">{message}</p>
      {onRetry ? (
        <button onClick={onRetry}
          className="mt-3 text-sm font-semibold text-brand-700 hover:underline">
          Try again
        </button>
      ) : null}
    </Card>
  );
}

/**
 * An empty state that says why it is empty.
 *
 * "No data" tells somebody nothing. Every one of these names the reason and,
 * where there is one, the next step.
 */
export function Empty({ title, hint, icon: Icon, action }: {
  title: string; hint?: string; icon?: LucideIcon; action?: React.ReactNode;
}) {
  return (
    <div className="grid place-items-center px-6 py-14 text-center">
      {Icon ? (
        <span className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-line-soft">
          <Icon size={19} strokeWidth={2} className="text-faint" />
        </span>
      ) : null}
      <p className="text-sm font-semibold">{title}</p>
      {hint ? <p className="mt-1 max-w-sm text-sm text-muted">{hint}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * A grey block the shape of what is coming.
 *
 * Used only where there is genuinely nothing to show yet. Once there IS data,
 * a refresh uses `Settling` instead — replacing figures somebody is reading
 * with grey blocks is a page load, and that is the thing being fixed.
 */
export function Skeleton({ w = '100%', h = 14, className = '' }: {
  w?: string | number; h?: string | number; className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`skeleton inline-block align-middle ${className}`}
      style={{ width: w, height: h }}
    />
  );
}

/** A tile-shaped skeleton, so the grid does not jump when figures land. */
export function TileSkeleton({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i}>
          <Skeleton w="55%" h={10} />
          <div className="mt-3"><Skeleton w="75%" h={26} /></div>
          <div className="mt-3"><Skeleton w="40%" h={10} /></div>
        </Card>
      ))}
    </>
  );
}

/**
 * Wraps content that is about to be replaced.
 *
 * The layout is untouched — same element, same size, same position — so
 * changing a filter reads as the numbers being rechecked rather than the screen
 * being rebuilt.
 */
export function Settling({ when, children }: {
  when: boolean; children: React.ReactNode;
}) {
  return (
    <div className={when ? 'settling' : 'settled'} aria-busy={when || undefined}>
      {children}
    </div>
  );
}

/* -------------------------------------------------------------- detailing --
 *
 * The pieces that make a list of rows read as a record rather than as text.
 * Indian accounting software is dense on purpose: a serial number on every
 * line, an icon that says what kind of thing this is, and a party you can pick
 * out of forty by its initials. None of it is decoration - it is how somebody
 * reads a column of forty names down a phone line without losing their place.
 */

/**
 * Initials in a coloured disc.
 *
 * The colour is derived from the name, not assigned, so the same customer is
 * the same colour on every screen for ever - which is what makes it useful for
 * finding a row rather than merely filling space. A random or rotating colour
 * would look identical and do nothing.
 *
 * The palette is fixed and muted: these sit behind text and must never compete
 * with a status colour, which is the only thing on the row that should shout.
 */
export { initialsOf };

const AVATAR_TONES = [
  'bg-emerald-100 text-emerald-800',
  'bg-sky-100 text-sky-800',
  'bg-amber-100 text-amber-800',
  'bg-violet-100 text-violet-800',
  'bg-rose-100 text-rose-800',
  'bg-teal-100 text-teal-800',
  'bg-indigo-100 text-indigo-800',
  'bg-orange-100 text-orange-800',
];

export function Avatar({ name, size = 'md' }: {
  name: string; size?: 'sm' | 'md' | 'lg';
}) {
  const px = size === 'sm' ? 'h-7 w-7 text-[10px]'
    : size === 'lg' ? 'h-12 w-12 text-base' : 'h-9 w-9 text-xs';
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-full font-bold
                  ${px} ${AVATAR_TONES[toneIndex(name, AVATAR_TONES.length)]}`}
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * The serial number every Indian ledger has down its left edge.
 *
 * Tabular figures and a fixed width so the column stays straight at 9 → 10,
 * which is exactly where a proportional font starts to wobble.
 */
export function Sno({ n }: { n: number }) {
  return (
    <span className="w-7 shrink-0 text-right text-[11px] tabular-nums text-faint">
      {n}
    </span>
  );
}

/**
 * A table with the conventions people expect from a ledger.
 *
 * `index` adds the serial column; `align` lets a column be right-aligned for
 * figures without every caller re-deriving "first column left, rest right",
 * which was the old rule and wrong the moment a table had two text columns.
 */
export function DataTable({ head, align = [], index = false, children, minWidth = 420 }: {
  head: (string | { label: string; icon?: LucideIcon })[];
  /** 'right' for money and counts. Defaults to left. */
  align?: ('left' | 'right')[];
  index?: boolean;
  children: React.ReactNode;
  minWidth?: number;
}) {
  return (
    <div className="relative -mx-5 overflow-x-auto px-5">
      <table className="w-full text-sm" style={{ minWidth }}>
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-line text-left">
            {index && (
              <th className="w-10 whitespace-nowrap pb-2.5 pt-1 text-right text-[11px]
                             font-semibold uppercase tracking-[0.07em] text-muted">
                #
              </th>
            )}
            {head.map((h, i) => {
              const label = typeof h === 'string' ? h : h.label;
              const Icon = typeof h === 'string' ? undefined : h.icon;
              return (
                <th key={label}
                  className={`whitespace-nowrap pb-2.5 pt-1 text-[11px] font-semibold
                              uppercase tracking-[0.07em] text-muted
                              ${align[i] === 'right' ? 'text-right' : ''}`}>
                  <span className={`inline-flex items-center gap-1.5 ${
                    align[i] === 'right' ? 'flex-row-reverse' : ''}`}>
                    {Icon && <Icon size={12} strokeWidth={2.2} className="text-faint" />}
                    {label}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">{children}</tbody>
      </table>
    </div>
  );
}

/** A row that lights up under the cursor, so the eye can follow it across. */
export function Tr({ children, onClick }: {
  children: React.ReactNode; onClick?: () => void;
}) {
  return (
    <tr
      onClick={onClick}
      className={`transition-colors hover:bg-canvas ${onClick ? 'cursor-pointer' : ''}`}
    >
      {children}
    </tr>
  );
}

/** The serial cell, to pair with `index` on DataTable. */
export const TdSno = ({ n }: { n: number }) => (
  <td className="py-2.5 pr-2 text-right text-[11px] tabular-nums text-faint">{n}</td>
);

/**
 * A list row for card-based lists, where a table would be too heavy.
 *
 * Carries the same three things a table row does — a position, something that
 * says what kind of thing it is, and the figure — so the two read as one system
 * rather than as two different products.
 */
export function ListRow({ n, avatar, icon: Icon, title, sub, right, rightSub, tone, onClick }: {
  n?: number;
  /** A name to draw initials from. Use for parties and people. */
  avatar?: string;
  /** An icon instead, for things that are not people. */
  icon?: LucideIcon;
  title: React.ReactNode;
  sub?: React.ReactNode;
  right?: React.ReactNode;
  rightSub?: React.ReactNode;
  tone?: 'good' | 'bad';
  onClick?: () => void;
}) {
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      onClick={onClick}
      className={`flex w-full items-center gap-3 border-b border-line-soft py-2.5
                  text-left last:border-0
                  ${onClick ? 'transition-colors hover:bg-canvas' : ''}`}
    >
      {n !== undefined && <Sno n={n} />}
      {avatar !== undefined && <Avatar name={avatar} size="sm" />}
      {Icon && (
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-canvas">
          <Icon size={14} strokeWidth={2.2} className="text-muted" />
        </span>
      )}

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{title}</span>
        {sub && <span className="block truncate text-xs text-muted">{sub}</span>}
      </span>

      {(right !== undefined || rightSub !== undefined) && (
        <span className="shrink-0 text-right">
          {right !== undefined && (
            <span className={`block text-sm font-semibold tabular-nums ${
              tone === 'good' ? 'text-positive'
                : tone === 'bad' ? 'text-negative' : 'text-ink'}`}>
              {right}
            </span>
          )}
          {rightSub !== undefined && (
            <span className="block text-xs text-faint">{rightSub}</span>
          )}
        </span>
      )}
    </Wrapper>
  );
}
