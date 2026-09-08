'use client';

import { use } from 'react';
import Link from 'next/link';
import { useAuth } from '../../../lib/auth';
import { useApi } from '../../../lib/useApi';
import { useMoney, useDateFormat } from '../../../lib/money';
import { type ItemDetail } from '../../../lib/api';
import {
  Badge, Card, Empty, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../../components/ui';
import { TrendChart, RankBars } from '../../../components/charts';
import ShareButton from '../../../components/ShareButton';
import {
  Package, ArrowDownLeft, ArrowUpRight, Users, Hash, CalendarClock, Layers,
} from 'lucide-react';

/** One item: what it is, how it moves, and who buys it. */
export default function ItemPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const { company } = useAuth();
  const money = useMoney();
  const date = useDateFormat();

  const decoded = decodeURIComponent(name);
  const { data, error, loading, reload } = useApi<ItemDetail>(
    company
      ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/items/${encodeURIComponent(decoded)}`
      : null,
    [company?.tallyGuid, decoded]);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner label="Loading…" />;
  if (!data) return <Empty title="Not found" hint="No such item in this company." />;

  const i = data.item;

  return (
    <>
      <PageTitle title={i.name}
        subtitle={[i.group, i.category].filter(Boolean).join(' · ') || 'Ungrouped'}
        right={
          <div className="flex items-center gap-2">
            <ShareButton kind="item" subject={i.name} label="Share" compact />
            <Link href="/items" className="text-sm font-semibold text-brand-700 hover:underline">
              All items
            </Link>
          </div>
        } />

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label="In stock" value={`${i.closingQty.toLocaleString('en-IN')} ${i.unit}`}
          tone={i.closingQty < 0 ? 'bad' : undefined} />
        <Stat label="Value" value={money(i.closingValuePaise)} />
        <Stat label="Rate per unit" value={i.ratePaise ? money(i.ratePaise) : '—'} />
        <Stat label="Reorder at"
          value={i.reorderLevel > 0 ? `${i.reorderLevel} ${i.unit}` : 'Not set'} />
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card>
          <SectionTitle icon={Hash}>Classification</SectionTitle>
          <Row k="Unit" v={i.unit} />
          <Row k="Alternate unit" v={i.altUnit} />
          <Row k="HSN" v={i.hsn} mono />
          <Row k="SAC" v={i.sac} mono />
          <Row k="GST rate" v={i.gstRatePct > 0 ? `${i.gstRatePct}%` : ''} />
          <Row k="Group" v={i.group} />
          <Row k="Category" v={i.category} />
        </Card>
        <Card>
          <SectionTitle icon={Layers}>Levels</SectionTitle>
          <Row k="Opening stock" v={`${i.openingQty} ${i.unit}`} />
          <Row k="Opening value" v={money(i.openingValuePaise)} />
          <Row k="Minimum" v={i.minLevel > 0 ? `${i.minLevel} ${i.unit}` : ''} />
          <Row k="Maximum" v={i.maxLevel > 0 ? `${i.maxLevel} ${i.unit}` : ''} />
          <Row k="Reorder level" v={i.reorderLevel > 0 ? `${i.reorderLevel} ${i.unit}` : ''} />
        </Card>
      </div>

      {data.batches.length > 0 && (
        <>
          <SectionTitle icon={CalendarClock}>Batches</SectionTitle>
          <Card className="mb-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase
                               tracking-wide text-slate-400">
                  <th className="pb-2 pr-3 font-semibold">Batch</th>
                  <th className="pb-2 pr-3 font-semibold">Godown</th>
                  <th className="pb-2 pr-3 text-right font-semibold">Qty</th>
                  <th className="pb-2 font-semibold">Expiry</th>
                </tr>
              </thead>
              <tbody>
                {data.batches.map((b) => {
                  const expiring = b.expiryDate
                    && new Date(b.expiryDate).getTime() - Date.now() < 60 * 86_400_000;
                  return (
                    <tr key={`${b.name}-${b.godown}`} className="border-b border-slate-50 last:border-0">
                      <td className="py-2.5 pr-3 font-medium text-slate-800">{b.name}</td>
                      <td className="py-2.5 pr-3 text-slate-500">{b.godown || '—'}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{b.qty}</td>
                      <td className="py-2.5">
                        {b.expiryDate
                          ? <Badge tone={expiring ? 'bad' : 'ok'}>{date(b.expiryDate)}</Badge>
                          : <span className="text-slate-400">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {data.monthly.length > 1 && (
        <>
          <SectionTitle icon={Package} note="quantity sold, month by month">Movement</SectionTitle>
          <Card className="mb-6">
            <TrendChart data={data.monthly.map((m) => ({ at: m.at, value: m.sold }))}
              money={(v) => String(v)} />
          </Card>
        </>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle icon={Users}>Who buys it</SectionTitle>
          {data.buyers.length === 0
            ? <Empty title="No buyers yet" icon={Users} hint="No sales recorded with this item." />
            : <RankBars data={data.buyers.map((b) => ({
                label: `${b.label} (${b.qty})`, value: b.amountPaise }))} money={money} />}
        </Card>
        <Card>
          <SectionTitle icon={ArrowUpRight}>Recent movement</SectionTitle>
          {data.movement.length === 0 ? (
            <Empty title="No movement" icon={Package}
              hint="This item has not appeared on a voucher yet." />
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.movement.map((m) => (
                    <tr key={m.id} className="border-b border-slate-50 last:border-0">
                      <td className="py-2 pr-2">
                        {m.direction === 'in'
                          ? <ArrowDownLeft size={13} className="text-emerald-600" />
                          : <ArrowUpRight size={13} className="text-rose-600" />}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="text-xs font-medium text-slate-800">{m.party || m.type}</div>
                        <div className="text-[11px] text-slate-400">
                          {m.no} · {date(m.date)}
                        </div>
                      </td>
                      <td className="py-2 text-right tabular-nums text-xs">
                        <div className="font-semibold text-slate-800">{m.qty}</div>
                        <div className="text-[11px] text-slate-400">{money(m.amountPaise)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-50 py-2 last:border-0">
      <span className="text-sm text-slate-500">{k}</span>
      <span className={`text-sm ${v ? 'font-semibold text-slate-800' : 'text-slate-300'} ${
        mono ? 'font-mono' : ''}`}>
        {v || 'Not set in Tally'}
      </span>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <Card>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${
        tone === 'bad' ? 'text-rose-700' : 'text-slate-900'}`}>{value}</div>
    </Card>
  );
}
