'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import {
  ChevronRight, Search, FileText, CalendarDays, Users, Layers,
} from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { useApi } from '../../../lib/useApi';
import { inr, shortDate } from '../../../lib/api';
import {
  Card, PageTitle, Spinner, ErrorNote, Empty, OfflineBar, Badge,
} from '../../../components/ui';

/**
 * Browsing a section of the books.
 *
 * Sales, Purchase, Receipts and the rest are one screen with a different
 * filter, so there is one page for all of them. It follows the shape an
 * accountant already works in: a roll-up first, then the vouchers inside it,
 * then one voucher in full.
 *
 * Grouping by month is the default because "how did August go" is the question
 * people actually open this to answer.
 */

type Row = { label?: string; amountPaise: number; count?: number;
             id?: string; vchNo?: string; date?: string; party?: string;
             vchType?: string; narration?: string };

type Result = {
  section: string; label: string; groupBy: string;
  from: string; to: string;
  totalPaise: number; count: number;
  rows: Row[];
  page: { limit: number; offset: number; hasMore: boolean };
};

const GROUPS = [
  { id: 'month', label: 'Month', icon: CalendarDays },
  { id: 'party', label: 'Party', icon: Users },
  { id: 'type', label: 'Type', icon: Layers },
  { id: 'none', label: 'All entries', icon: FileText },
] as const;

/** India's financial year, which is what every Indian report is cut to. */
function financialYear(offset = 0) {
  const now = new Date();
  const y = (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1) + offset;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31`, label: `FY ${y}-${String(y + 1).slice(2)}` };
}

export default function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = use(params);
  const { company } = useAuth();

  const [groupBy, setGroupBy] = useState<string>('month');
  const [fyOffset, setFyOffset] = useState(0);
  const [q, setQ] = useState('');
  const [drill, setDrill] = useState<{ label: string; from: string; to: string } | null>(null);

  const fy = financialYear(fyOffset);
  // Drilling into a month narrows the range rather than adding a filter, so the
  // header total and the list below it can never disagree.
  const from = drill?.from ?? fy.from;
  const to = drill?.to ?? fy.to;
  const effectiveGroup = drill ? 'none' : groupBy;

  const path = company
    ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/txn/${section}`
      + `?groupBy=${effectiveGroup}&from=${from}&to=${to}`
      + (q.trim() ? `&q=${encodeURIComponent(q.trim())}` : '')
    : null;

  const { data, error, loading, reload, stale, offline } =
    useApi<Result>(path, [section, effectiveGroup, from, to, q]);

  if (!company) {
    return <Empty title="No company yet" hint="Connect the computer that runs Tally first." />;
  }

  return (
    <>
      <PageTitle
        title={data?.label ?? sectionLabel(section)}
        subtitle={drill ? `${monthLabel(drill.label)} · drill-down` : fy.label}
        right={
          data ? (
            <div className="text-right">
              <div className="figure text-2xl font-bold leading-none">
                {inr(data.totalPaise, { compact: true })}
              </div>
              <div className="mt-1 text-xs text-muted">
                {data.count.toLocaleString('en-IN')} entries · {inr(data.totalPaise)}
              </div>
            </div>
          ) : null
        }
      />
      <OfflineBar offline={offline} ageMs={stale} />

      {/* Controls: how it is grouped, which year, and a search within it. */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        {drill ? (
          <button onClick={() => setDrill(null)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line
                       bg-surface px-3 py-1.5 text-sm font-semibold hover:bg-canvas">
            ← Back to {groupBy === 'month' ? 'months' : groupBy}
          </button>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {GROUPS.map((g) => {
              const Icon = g.icon;
              return (
                <button key={g.id} onClick={() => setGroupBy(g.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5
                              text-sm font-semibold transition ${
                    groupBy === g.id
                      ? 'bg-brand-700 text-white'
                      : 'text-muted hover:bg-line-soft hover:text-ink'}`}>
                  <Icon size={14} strokeWidth={2.2} />
                  {g.label}
                </button>
              );
            })}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {!drill ? (
            <div className="flex items-center rounded-lg border border-line bg-surface">
              <button onClick={() => setFyOffset((n) => n - 1)}
                className="px-2.5 py-1.5 text-muted hover:text-ink">‹</button>
              <span className="px-2 text-sm font-semibold tabular-nums">{fy.label}</span>
              <button onClick={() => setFyOffset((n) => n + 1)}
                disabled={fyOffset >= 0}
                className="px-2.5 py-1.5 text-muted hover:text-ink disabled:opacity-30">›</button>
            </div>
          ) : null}

          <div className="relative">
            <Search size={14} strokeWidth={2.2}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Party, voucher no…"
              className="w-52 rounded-lg border border-line bg-surface py-1.5 pl-8 pr-3
                         text-sm outline-none focus:border-brand-600" />
          </div>
        </div>
      </div>

      {error ? <ErrorNote message={error} onRetry={reload} />
        : loading || !data ? <Spinner label="Reading your books…" />
        : data.rows.length === 0 ? (
          <Card>
            <Empty icon={FileText}
              title={q ? 'Nothing matches that search' : `No ${sectionLabel(section).toLowerCase()} in this period`}
              hint={q ? 'Try a different name or voucher number.'
                      : 'Change the year above, or check the entries exist in Tally.'} />
          </Card>
        ) : effectiveGroup === 'none' ? (
          <VoucherList rows={data.rows} section={section} guid={company.tallyGuid} />
        ) : (
          <GroupList rows={data.rows} groupBy={effectiveGroup}
            total={data.totalPaise}
            onDrill={(label) => {
              if (effectiveGroup !== 'month') { setGroupBy('none'); setQ(label); return; }
              setDrill({ label, ...monthRange(label) });
            }} />
        )}
    </>
  );
}

/** The roll-up: one line per month, party or type, with a share bar. */
function GroupList({ rows, groupBy, total, onDrill }: {
  rows: Row[]; groupBy: string; total: number; onDrill: (label: string) => void;
}) {
  const max = Math.max(...rows.map((r) => r.amountPaise), 1);
  return (
    <Card className="p-0">
      <ul className="divide-y divide-line-soft">
        {rows.map((r) => (
          <li key={r.label}>
            <button onClick={() => onDrill(r.label!)}
              className="flex w-full items-center gap-4 px-5 py-3.5 text-left transition hover:bg-canvas">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">
                  {groupBy === 'month' ? monthLabel(r.label!) : r.label}
                </div>
                {/* A share bar turns a column of numbers into a shape you can
                    read at a glance - which month was big, which party matters. */}
                <div className="mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-line-soft">
                  <div className="h-full rounded-full bg-brand-500"
                    style={{ width: `${(r.amountPaise / max) * 100}%` }} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="figure font-bold">{inr(r.amountPaise, { compact: true })}</div>
                <div className="text-xs text-muted">
                  {r.count} {r.count === 1 ? 'entry' : 'entries'}
                  {total > 0 ? ` · ${Math.round((r.amountPaise / total) * 100)}%` : ''}
                </div>
              </div>
              <ChevronRight size={16} strokeWidth={2.2} className="shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The vouchers themselves. */
function VoucherList({ rows, section, guid }: {
  rows: Row[]; section: string; guid: string;
}) {
  return (
    <Card className="p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="border-b border-line">
            <tr className="text-left text-[11px] uppercase tracking-[0.07em] text-muted">
              <th className="px-5 py-2.5 font-semibold">Date</th>
              <th className="px-5 py-2.5 font-semibold">Party</th>
              <th className="px-5 py-2.5 font-semibold">Voucher</th>
              <th className="px-5 py-2.5 text-right font-semibold">Amount</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {rows.map((r) => (
              <tr key={r.id} className="transition hover:bg-canvas">
                <td className="whitespace-nowrap px-5 py-3 text-muted">{shortDate(r.date!)}</td>
                <td className="px-5 py-3">
                  <Link href={`/txn/${section}/${r.id}`} className="font-medium hover:underline">
                    {r.party || <span className="text-faint">—</span>}
                  </Link>
                  {r.narration ? (
                    <div className="truncate text-xs text-faint">{r.narration}</div>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-5 py-3">
                  <span className="rounded-md bg-line-soft px-1.5 py-0.5 text-[10px]
                                   font-semibold uppercase tracking-wide text-muted">
                    {r.vchType}
                  </span>
                  <span className="ml-2 text-xs text-muted">#{r.vchNo}</span>
                </td>
                <td className="figure whitespace-nowrap px-5 py-3 text-right font-semibold">
                  {inr(r.amountPaise)}
                </td>
                <td className="pr-4">
                  <Link href={`/txn/${section}/${r.id}`}>
                    <ChevronRight size={15} strokeWidth={2.2} className="text-faint" />
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function monthRange(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

function sectionLabel(s: string): string {
  return s.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}
