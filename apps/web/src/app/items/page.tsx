'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { useMoney } from '../../lib/money';
import { type ItemsPayload } from '../../lib/api';
import {
  Badge, Card, Empty, ErrorNote, OfflineBar, PageTitle, Spinner,
} from '../../components/ui';
import {
  Package, Search, AlertTriangle, ArrowUpDown, Info, ChevronRight,
  PackageX, PackageMinus, TrendingDown, Boxes,
} from 'lucide-react';

/**
 * What you hold, and what needs doing about it.
 *
 * The four counts at the top are the whole point: negative stock is a
 * bookkeeping fault, below-reorder is a purchasing decision, and an owner
 * needs to see both without reading a list of three hundred items.
 */

const STATUSES = [
  { key: '', label: 'Everything', icon: Boxes },
  { key: 'ok', label: 'In stock', icon: Package },
  { key: 'reorder', label: 'Below reorder', icon: TrendingDown },
  { key: 'out', label: 'Out of stock', icon: PackageX },
  { key: 'negative', label: 'Negative', icon: PackageMinus },
];

const SORTS = [
  { key: 'value', label: 'Highest value' },
  { key: 'qty', label: 'Most stock' },
  { key: 'name', label: 'Name' },
];

const TONE: Record<string, { badge: 'ok' | 'warn' | 'bad'; label: string }> = {
  ok: { badge: 'ok', label: 'In stock' },
  out: { badge: 'warn', label: 'Out of stock' },
  reorder: { badge: 'warn', label: 'Below reorder' },
  negative: { badge: 'bad', label: 'Negative' },
};

export default function ItemsPage() {
  const { company } = useAuth();
  const money = useMoney();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [group, setGroup] = useState('');
  const [sort, setSort] = useState('value');

  const qs = new URLSearchParams({ sort });
  if (q.trim()) qs.set('q', q.trim());
  if (status) qs.set('status', status);
  if (group) qs.set('group', group);

  const { data, error, loading, reload, stale, offline } = useApi<ItemsPayload>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/items?${qs}` : null,
    [company?.tallyGuid, q, status, group, sort]);

  if (error) return <ErrorNote message={error} onRetry={reload} />;

  return (
    <>
      <PageTitle title="Items & stock" subtitle="What you hold, and what needs reordering." />
      <OfflineBar offline={offline} ageMs={stale} />

      {data && (
        <div className="mb-5 grid gap-3 sm:grid-cols-4">
          <Stat label="Stock value" value={money(data.totals.valuePaise)}
            sub={`${data.totals.count} items`} />
          <Stat label="Below reorder" value={String(data.totals.belowReorder)}
            sub="need buying" tone={data.totals.belowReorder ? 'warn' : undefined} />
          <Stat label="Out of stock" value={String(data.totals.outOfStock)}
            sub="nothing on hand" tone={data.totals.outOfStock ? 'warn' : undefined} />
          <Stat label="Negative" value={String(data.totals.negative)}
            sub="sold more than bought" tone={data.totals.negative ? 'bad' : undefined} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {STATUSES.map((s) => (
          <button key={s.key} onClick={() => setStatus(s.key)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs
                        font-semibold transition ${
              status === s.key ? 'bg-brand-700 text-white'
                               : 'bg-line-soft text-body hover:bg-line'}`}>
            <s.icon size={13} /> {s.label}
          </button>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or HSN"
            className="w-full rounded-lg border border-line py-2 pl-9 pr-3 text-sm
                       outline-none focus:border-brand-500" />
        </div>
        {data && data.groups.length > 0 && (
          <select value={group} onChange={(e) => setGroup(e.target.value)}
            className="rounded-lg border border-line px-3 py-2 text-sm outline-none
                       focus:border-brand-500">
            <option value="">All groups</option>
            {data.groups.map((g) => (
              <option key={g.name} value={g.name}>{g.name} ({g.count})</option>
            ))}
          </select>
        )}
        <div className="flex items-center gap-1.5">
          <ArrowUpDown size={14} className="text-faint" />
          {SORTS.map((s) => (
            <button key={s.key} onClick={() => setSort(s.key)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                sort === s.key ? 'bg-ink text-white'
                               : 'bg-line-soft text-body hover:bg-line'}`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? <Spinner label="Counting your stock…" />
        : !data?.items.length ? (
          <Empty title="Nothing here" icon={Package}
            hint={q ? `No item matches "${q}".` : 'Items appear as Tally syncs them.'} />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase
                                 tracking-wide text-faint">
                    <th className="pb-2 pr-3 font-semibold">Item</th>
                    <th className="pb-2 pr-3 font-semibold">HSN</th>
                    <th className="pb-2 pr-3 text-right font-semibold">GST</th>
                    <th className="pb-2 pr-3 text-right font-semibold">Stock</th>
                    <th className="pb-2 pr-3 text-right font-semibold">Rate</th>
                    <th className="pb-2 pr-3 text-right font-semibold">Value</th>
                    <th className="pb-2 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((i) => (
                    <tr key={i.name} className="border-b border-line-soft last:border-0
                                                hover:bg-canvas">
                      <td className="py-2.5 pr-3">
                        <Link href={`/items/${encodeURIComponent(i.name)}`}
                          className="font-medium text-ink hover:text-brand-700">
                          {i.name}
                        </Link>
                        {(i.group || i.category) && (
                          <div className="text-[11px] text-faint">
                            {[i.group, i.category].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-xs text-muted">
                        {i.hsn || '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-muted">
                        {i.gstRatePct > 0 ? `${i.gstRatePct}%` : '—'}
                      </td>
                      <td className={`py-2.5 pr-3 text-right tabular-nums font-semibold ${
                        i.closingQty < 0 ? 'text-negative' : 'text-ink'}`}>
                        {i.closingQty.toLocaleString('en-IN')}
                        <span className="ml-1 text-[11px] font-normal text-faint">{i.unit}</span>
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-muted">
                        {i.ratePaise ? money(i.ratePaise) : '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums font-semibold text-ink">
                        {money(i.closingValuePaise)}
                      </td>
                      <td className="py-2.5">
                        <Badge tone={TONE[i.status].badge}>{TONE[i.status].label}</Badge>
                        {i.status === 'reorder' && (
                          <div className="text-[11px] text-faint">
                            reorder at {i.reorderLevel}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

      {data && (
        <p className="mt-5 flex items-start gap-2 rounded-lg bg-canvas px-3 py-2
                      text-xs text-muted">
          <Info size={13} className="mt-0.5 shrink-0" />
          {data.readOnly} Munim never writes to your books.
        </p>
      )}
    </>
  );
}

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub: string; tone?: 'warn' | 'bad';
}) {
  return (
    <Card>
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${
        tone === 'bad' ? 'text-negative' : tone === 'warn' ? 'text-warn' : 'text-ink'}`}>
        {value}
      </div>
      <div className="text-[11px] text-faint">{sub}</div>
    </Card>
  );
}
