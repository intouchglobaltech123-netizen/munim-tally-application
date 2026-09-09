'use client';

import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { inr, type Pulse, type Payer, type Mover } from '../../lib/api';
import Filters, { type FilterSpec, type FilterValues, matches } from '../../components/Filters';
import {
  Badge, Card, Empty, ErrorNote, PageTitle, SectionTitle, Settling, Spinner,
  TileSkeleton,
} from '../../components/ui';
import {
  Activity, Clock, TrendingUp, TrendingDown, UserPlus, UserMinus,
  CalendarDays, Fuel, Info, AlertTriangle,
} from 'lucide-react';

/**
 * The questions the totals do not answer.
 *
 * Everything else in Munim reports magnitude — what is biggest, what the total
 * is. This screen is the four things an owner asks that a total cannot answer:
 * who is slow, what moved, when the shop actually sells, and how long the money
 * lasts.
 */
export default function PulsePage() {
  const { company, loading } = useAuth();
  const [window, setWindow] = useState(90);
  const [pf, setPf] = useState<FilterValues>({});

  /*
   * Payers, narrowed.
   *
   * The verdict is already computed server-side from days against terms, so
   * filtering on it rather than re-deriving one here keeps the table and the
   * filter telling the same story.
   */
  const payerSpecs: FilterSpec<Payer>[] = [
    { key: 'q', label: 'Party', kind: 'search', on: (x) => x.party,
      placeholder: 'Search party…' },
    { key: 'val', label: 'Business done', kind: 'amountRange', on: (x) => x.valuePaise },
    { key: 'late', label: 'Has paid late', kind: 'toggle', on: (x) => x.lateBills > 0 },
    { key: 'terms', label: 'Over their terms', kind: 'toggle',
      on: (x) => x.daysAgainstTerms != null && x.daysAgainstTerms > 0 },
    { key: 'speed', label: 'How they pay', kind: 'select',
      on: (x) => (x.averageDays <= 30 ? 'fast' : x.averageDays <= 60 ? 'ok' : 'slow'),
      options: [
        { value: 'fast', label: 'Within 30 days' },
        { value: 'ok', label: '31 to 60 days' },
        { value: 'slow', label: 'Over 60 days' },
      ] },
  ];

  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;
  const p = useApi<Pulse>(base && `${base}/pulse?days=${window}`,
    [company?.tallyGuid, window]);

  if (loading) return <Spinner />;
  if (!company) {
    return <Empty title="No company yet" icon={Activity}
      hint="Connect Tally and these fill in on their own." />;
  }
  if (p.error) return <ErrorNote message={p.error} onRetry={p.reload} />;

  /*
   * The skeleton only on a genuine first load. Changing the window keeps the
   * page and greys the figures instead - see Settling below.
   */
  if (!p.data) {
    return (
      <>
        <PageTitle title="Pulse"
          subtitle="Who is slow, what moved, when you sell, and how long the money lasts." />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TileSkeleton count={4} />
        </div>
      </>
    );
  }

  const { payers, movers, rhythm, runway } = p.data;

  return (
    <>
      <PageTitle title="Pulse"
        subtitle="Who is slow, what moved, when you sell, and how long the money lasts."
        right={
          <div className="inline-flex rounded-lg border border-line p-0.5">
            {[30, 90, 365].map((d) => (
              <button key={d} onClick={() => setWindow(d)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  window === d ? 'bg-ink text-white' : 'text-muted hover:text-ink'}`}>
                {d === 365 ? '1 year' : `${d} days`}
              </button>
            ))}
          </div>
        } />

      <Settling when={p.refreshing}>
      {/* Runway first: it is the only one that can be an emergency. */}
      <SectionTitle icon={Fuel} note="cash against what it costs to keep going">
        How long the money lasts
      </SectionTitle>
      <Card className={`mb-6 ${
        runway.tone === 'bad' ? 'border-rose-200 bg-rose-50'
          : runway.tone === 'warn' ? 'border-amber-200 bg-amber-50' : ''}`}>
        <div className="grid gap-4 sm:grid-cols-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Runway
            </div>
            <div className={`figure mt-1 text-3xl font-bold ${
              runway.tone === 'bad' ? 'text-rose-700'
                : runway.tone === 'warn' ? 'text-amber-700' : 'text-ink'}`}>
              {runway.months === null ? 'Unknown' : `${runway.months} mo`}
            </div>
            {runway.monthsWithReceivables !== null && (
              <div className="mt-1 text-xs text-muted">
                {runway.monthsWithReceivables} months if everything owed comes in
              </div>
            )}
          </div>
          <Figure label="Cash & bank" value={inr(runway.liquidPaise)} />
          <Figure label="Monthly spend"
            value={runway.monthlyBurnPaise ? inr(runway.monthlyBurnPaise) : '—'} />
          <Figure label="Owed to you" value={inr(runway.receivablePaise)} />
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted">
          <Info size={12} className="mt-0.5 shrink-0" /> {runway.basis}
        </p>
      </Card>

      {/* Who pays late. */}
      <SectionTitle icon={Clock} note={payers.basis}>How your customers pay</SectionTitle>
      {payers.payers.length === 0 ? (
        <Card className="mb-6">
          <p className="text-sm text-muted">
            Nothing has been settled in this window yet, so there is no pattern to read.
          </p>
        </Card>
      ) : (
        <>
          <div className="mb-3 grid gap-4 lg:grid-cols-2">
            <Card>
              <SectionTitle icon={AlertTriangle}>Slowest to pay</SectionTitle>
              {payers.worst.length === 0
                ? <p className="text-sm text-muted">Nobody is consistently late.</p>
                : payers.worst.map((x) => <PayerRow key={x.party} p={x} />)}
            </Card>
            <Card>
              <SectionTitle icon={TrendingUp}>Pays early</SectionTitle>
              {payers.best.length === 0
                ? <p className="text-sm text-muted">Nobody pays ahead of terms.</p>
                : payers.best.map((x) => <PayerRow key={x.party} p={x} />)}
            </Card>
          </div>
          <Card className="mb-2">
            <div className="overflow-x-auto">
              <Filters specs={payerSpecs} values={pf} onChange={setPf} />
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase
                                 tracking-wide text-slate-400">
                    <th className="pb-2 pr-3 font-semibold">Customer</th>
                    <th className="pb-2 pr-3 text-right font-semibold">Bills</th>
                    <th className="pb-2 pr-3 text-right font-semibold">Avg days</th>
                    <th className="pb-2 pr-3 text-right font-semibold">vs terms</th>
                    <th className="pb-2 pr-3 text-right font-semibold">On time</th>
                    <th className="pb-2 font-semibold">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {payers.payers.filter((x) => matches(x, payerSpecs, pf)).map((x) => (
                    <tr key={x.party} className="border-b border-slate-50 last:border-0">
                      <td className="py-2 pr-3 text-ink">{x.party}</td>
                      <td className="py-2 pr-3 text-right text-muted tabular-nums">
                        {x.bills}
                      </td>
                      <td className="py-2 pr-3 text-right text-ink tabular-nums">
                        {x.averageDays}
                      </td>
                      <td className={`py-2 pr-3 text-right tabular-nums font-medium ${
                        (x.daysAgainstTerms ?? 0) > 3 ? 'text-rose-600'
                          : (x.daysAgainstTerms ?? 0) < -3 ? 'text-emerald-700'
                          : 'text-muted'}`}>
                        {x.daysAgainstTerms === null ? '—'
                          : x.daysAgainstTerms > 0 ? `+${x.daysAgainstTerms}`
                          : x.daysAgainstTerms}
                      </td>
                      <td className="py-2 pr-3 text-right text-muted tabular-nums">
                        {x.onTimePercent}%
                      </td>
                      <td className="py-2 text-xs text-muted">{x.verdict}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="mb-6 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                        text-xs text-slate-500">
            <Info size={13} className="mt-0.5 shrink-0" /> {payers.note}
          </p>
        </>
      )}

      {/* What moved. */}
      <SectionTitle icon={Activity} note={`against ${movers.comparedWith}`}>
        What changed
      </SectionTitle>
      <div className="mb-3 grid gap-4 lg:grid-cols-2">
        <MoverCard title="Buying more" icon={TrendingUp} rows={movers.grew} tone="good" />
        <MoverCard title="Buying less" icon={TrendingDown} rows={movers.shrank} tone="bad" />
        <MoverCard title="New customers" icon={UserPlus} rows={movers.won} tone="good"
          field="nowPaise" />
        <MoverCard title="Stopped buying" icon={UserMinus} rows={movers.lost} tone="bad"
          field="beforePaise" />
      </div>
      <p className="mb-6 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                    text-xs text-slate-500">
        <Info size={13} className="mt-0.5 shrink-0" /> {movers.note}
      </p>

      {/* When you sell. */}
      <SectionTitle icon={CalendarDays} note={rhythm.summary}>When you sell</SectionTitle>
      <Card className="mb-6">
        <DayBars days={rhythm.byDay} />
        {rhythm.closedOn.length > 0 && (
          <p className="mt-3 text-xs text-muted">
            No trading recorded on {rhythm.closedOn.join(', ')}.
          </p>
        )}
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted">
          <Info size={12} className="mt-0.5 shrink-0" /> {rhythm.note}
        </p>
      </Card>
      </Settling>
    </>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className="figure mt-1 text-xl font-bold text-ink">{value}</div>
    </div>
  );
}

function PayerRow({ p }: { p: Payer }) {
  return (
    <div className="flex items-center justify-between border-b border-slate-50 py-2
                    text-sm last:border-0">
      <div>
        <div className="text-ink">{p.party}</div>
        <div className="text-xs text-muted">
          {p.bills} bills · {p.averageDays} days on average
        </div>
      </div>
      <Badge tone={(p.daysAgainstTerms ?? 0) > 3 ? 'bad'
        : (p.daysAgainstTerms ?? 0) < -3 ? 'ok' : 'muted'}>
        {p.daysAgainstTerms === null ? 'no terms'
          : p.daysAgainstTerms > 0 ? `${p.daysAgainstTerms}d late`
          : `${Math.abs(p.daysAgainstTerms)}d early`}
      </Badge>
    </div>
  );
}

function MoverCard({ title, icon: Icon, rows, tone, field = 'changePaise' }: {
  title: string; icon: typeof TrendingUp; rows: Mover[];
  tone: 'good' | 'bad'; field?: 'changePaise' | 'nowPaise' | 'beforePaise';
}) {
  return (
    <Card>
      <SectionTitle icon={Icon}>{title}</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nobody.</p>
      ) : rows.map((r) => (
        <div key={r.party} className="flex items-center justify-between border-b
                                      border-slate-50 py-2 text-sm last:border-0">
          <span className="truncate text-ink">{r.party}</span>
          <span className={`shrink-0 font-medium tabular-nums ${
            tone === 'good' ? 'text-emerald-700' : 'text-rose-700'}`}>
            {field === 'changePaise' && r.changePaise > 0 ? '+' : ''}
            {inr(Math.abs(r[field]))}
            {r.changePercent !== null && field === 'changePaise' && (
              <span className="ml-1 text-xs font-normal text-muted">
                {r.changePercent > 0 ? '+' : ''}{r.changePercent}%
              </span>
            )}
          </span>
        </div>
      ))}
    </Card>
  );
}

/**
 * Sales by day of the week.
 *
 * Averages per trading day, not totals — a shop open six days would otherwise
 * show Sunday as its worst day when it simply does not open.
 */
function DayBars({ days }: { days: RhythmDayView[] }) {
  const max = Math.max(...days.map((d) => d.averagePaise), 1);
  return (
    <div className="space-y-2">
      {days.map((d) => (
        <div key={d.day} className="flex items-center gap-3">
          <span className="w-10 shrink-0 text-xs font-medium text-muted">{d.short}</span>
          <div className="h-6 flex-1 overflow-hidden rounded bg-slate-50">
            {d.daysOpen > 0 && (
              <div className="h-full rounded bg-brand-500/85"
                style={{ width: `${Math.max(2, (d.averagePaise / max) * 100)}%` }} />
            )}
          </div>
          <span className="w-28 shrink-0 text-right text-xs tabular-nums text-ink">
            {d.daysOpen === 0 ? <span className="text-faint">closed</span>
              : inr(d.averagePaise)}
          </span>
        </div>
      ))}
    </div>
  );
}

type RhythmDayView = {
  day: string; short: string; averagePaise: number; daysOpen: number;
};
