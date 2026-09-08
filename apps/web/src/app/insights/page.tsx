'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { inr, shortDate, type Attention, type Ageing, type Projections, type Top, type Trends } from '../../lib/api';
import {
  Card, ErrorNote, OfflineBar, PageTitle, SectionTitle, Spinner, Empty,
} from '../../components/ui';
import {
  AlertTriangle, CheckCircle2, TrendingUp, TrendingDown, Minus, Trophy,
  CalendarClock, ChevronRight, Hourglass,
} from 'lucide-react';

/** Rankings the switcher offers. Same endpoint, different dimension. */
const DIMENSIONS = [
  { key: 'customer', label: 'Customers' },
  { key: 'item', label: 'Items' },
  { key: 'debtor', label: 'Who owes most' },
  { key: 'supplier', label: 'Suppliers' },
  { key: 'group', label: 'Ledger groups' },
  { key: 'voucher-type', label: 'Voucher types' },
];

const PERIODS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

export default function InsightsPage() {
  const { company, loading } = useAuth();
  const [by, setBy] = useState('customer');
  const [days, setDays] = useState(365);

  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;
  const attn = useApi<Attention>(base && `${base}/attention`, [company?.tallyGuid]);
  const age = useApi<Ageing>(base && `${base}/ageing`, [company?.tallyGuid]);
  const proj = useApi<Projections>(base && `${base}/projections`, [company?.tallyGuid]);
  const trend = useApi<Trends>(base && `${base}/trends`, [company?.tallyGuid]);
  const top = useApi<Top>(base && `${base}/top?by=${by}&days=${days}&limit=10`,
    [company?.tallyGuid, by, days]);

  if (loading) return <Spinner />;
  if (!company) {
    return <Empty title="No company yet" icon={Trophy}
      hint="Connect the computer running Tally and these fill in on their own." />;
  }
  if (attn.error) return <ErrorNote message={attn.error} onRetry={attn.reload} />;

  return (
    <>
      <PageTitle
        title="Business insights"
        subtitle="What to act on today — not just what the books say."
      />
      <OfflineBar offline={attn.offline} ageMs={attn.stale} />

      {/* Problems first. A dashboard that opens with a healthy total buries the
          one customer who has stopped paying. */}
      <SectionTitle icon={AlertTriangle} note={attn.data ? `as on ${shortDate(attn.data.asOf)}` : undefined}>
        Needs attention
      </SectionTitle>
      {attn.loading || !attn.data ? <Spinner /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {attn.data.items.map((it) => <AttentionCard key={it.key} item={it} />)}
        </div>
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle icon={Hourglass}>How old the money is</SectionTitle>
          {age.loading || !age.data ? <Spinner /> : <AgeingCard data={age.data} />}
        </div>
        <div>
          <SectionTitle icon={CalendarClock}>What is coming in</SectionTitle>
          {proj.loading || !proj.data ? <Spinner /> : <ProjectionCard data={proj.data} />}
        </div>
      </div>

      <SectionTitle icon={TrendingUp} note="each period against the one before it">
        Sales momentum
      </SectionTitle>
      {trend.loading || !trend.data ? <Spinner /> : (
        <div className="grid gap-3 sm:grid-cols-3">
          {trend.data.windows.map((w) => <TrendCard key={w.days} w={w} />)}
        </div>
      )}

      <SectionTitle icon={Trophy}>Rankings</SectionTitle>
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            {DIMENSIONS.map((d) => (
              <button key={d.key} onClick={() => setBy(d.key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                  by === d.key ? 'bg-brand-700 text-white'
                               : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                {d.label}
              </button>
            ))}
          </div>
          {/* A closing balance has no period, so hide the period switch for it. */}
          {by !== 'debtor' && (
            <div className="flex gap-1.5">
              {PERIODS.map((p) => (
                <button key={p.days} onClick={() => setDays(p.days)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                    days === p.days ? 'bg-slate-800 text-white'
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {top.loading || !top.data ? <Spinner />
          : top.data.rows.length === 0
            ? <Empty title="Nothing to rank yet" icon={Trophy}
                hint="This fills in as soon as Tally has entries of this kind." />
            : <Ranking data={top.data} />}
      </Card>
    </>
  );
}

function AttentionCard({ item }: { item: Attention['items'][number] }) {
  const clean = item.count === 0;
  const tone = clean
    ? { bg: 'bg-emerald-50', ring: 'ring-emerald-200', text: 'text-emerald-700', Icon: CheckCircle2 }
    : item.tone === 'bad'
      ? { bg: 'bg-rose-50', ring: 'ring-rose-200', text: 'text-rose-700', Icon: AlertTriangle }
      : { bg: 'bg-amber-50', ring: 'ring-amber-200', text: 'text-amber-700', Icon: AlertTriangle };

  return (
    <div className={`rounded-xl ${tone.bg} p-4 ring-1 ${tone.ring}`}>
      <div className="flex items-start gap-3">
        <tone.Icon size={18} className={`mt-0.5 shrink-0 ${tone.text}`} />
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className={`text-2xl font-bold tabular-nums ${tone.text}`}>{item.count}</span>
            <span className="text-sm font-semibold text-slate-700">{item.label}</span>
          </div>
          {item.amountPaise != null && item.amountPaise > 0 && (
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-slate-800">
              {inr(item.amountPaise)}
            </div>
          )}
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            {clean ? 'Nothing to do here.' : item.hint}
          </p>
        </div>
      </div>
    </div>
  );
}

function AgeingCard({ data }: { data: Ageing }) {
  const max = Math.max(...data.buckets.map((b) => b.amountPaise), 1);
  const pctOverdue = data.totalPaise > 0
    ? Math.round((data.overduePaise / data.totalPaise) * 100) : 0;

  if (data.totalPaise === 0) {
    return <Card><Empty title="Nothing outstanding" icon={CheckCircle2}
      hint="Every bill is settled." /></Card>;
  }

  return (
    <Card>
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <div className="text-2xl font-bold tabular-nums text-slate-900">{inr(data.totalPaise)}</div>
          <div className="text-xs text-slate-500">owed to you in total</div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold tabular-nums text-rose-600">{inr(data.overduePaise)}</div>
          <div className="text-xs text-slate-500">{pctOverdue}% past due</div>
        </div>
      </div>
      <div className="space-y-2.5">
        {data.buckets.map((b, i) => {
          // Later buckets are older money, so they darken toward red.
          const shade = ['bg-emerald-500', 'bg-lime-500', 'bg-amber-500',
                         'bg-orange-500', 'bg-rose-500', 'bg-rose-700'][i] ?? 'bg-slate-400';
          return (
            <div key={b.label} className="flex items-center gap-3">
              <div className="w-16 shrink-0 text-xs font-medium text-slate-500">{b.label}d</div>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full ${shade} transition-all`}
                  style={{ width: `${(b.amountPaise / max) * 100}%` }} />
              </div>
              <div className="w-28 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-700">
                {b.amountPaise > 0 ? inr(b.amountPaise) : '—'}
              </div>
            </div>
          );
        })}
      </div>
      <Link href="/outstanding"
        className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-brand-700 hover:underline">
        See every bill <ChevronRight size={13} />
      </Link>
    </Card>
  );
}

function ProjectionCard({ data }: { data: Projections }) {
  const rows = [
    { label: 'Already overdue', paise: data.overduePaise, tone: 'text-rose-600',
      hint: 'Due date has passed. Chase these.' },
    { label: 'Due in 15 days', paise: data.next15Paise, tone: 'text-amber-600',
      hint: 'Expect this in the next fortnight.' },
    { label: 'Due in 60 days', paise: data.next60Paise, tone: 'text-emerald-600',
      hint: 'Includes the 15-day figure above.' },
  ];
  return (
    <Card>
      <div className="space-y-4">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-slate-700">{r.label}</div>
              <div className="text-xs text-slate-500">{r.hint}</div>
            </div>
            <div className={`shrink-0 text-lg font-bold tabular-nums ${r.tone}`}>
              {inr(r.paise)}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
        Based on each bill&apos;s due date, or the party&apos;s credit terms where
        Tally has not set one.
      </p>
    </Card>
  );
}

function TrendCard({ w }: { w: Trends['windows'][number] }) {
  const up = w.changePct != null && w.changePct > 0;
  const flat = w.changePct == null || w.changePct === 0;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  const tone = flat ? 'text-slate-500' : up ? 'text-emerald-600' : 'text-rose-600';
  const name = w.days === 7 ? 'This week' : w.days === 30 ? 'This month' : 'This quarter';

  return (
    <Card>
      <div className="text-xs font-medium text-slate-500">{name}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{inr(w.amountPaise)}</div>
      <div className={`mt-2 flex items-center gap-1.5 text-sm font-semibold ${tone}`}>
        <Icon size={15} />
        {w.changePct == null ? 'No sales before this'
          : `${w.changePct > 0 ? '+' : ''}${w.changePct}%`}
      </div>
      <div className="mt-0.5 text-xs text-slate-500">
        previous {w.days} days: {inr(w.prevPaise)}
      </div>
    </Card>
  );
}

function Ranking({ data }: { data: Top }) {
  const max = Math.max(...data.rows.map((r) => r.amountPaise), 1);
  return (
    <div className="space-y-1">
      {data.rows.map((r, i) => (
        <div key={r.label} className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50">
          <div className="w-6 shrink-0 text-center text-xs font-bold text-slate-400">{i + 1}</div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-slate-800">{r.label}</div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-brand-500"
                style={{ width: `${(r.amountPaise / max) * 100}%` }} />
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-sm font-semibold tabular-nums text-slate-900">{inr(r.amountPaise)}</div>
            <div className="text-xs tabular-nums text-slate-400">
              {r.sharePct}%{r.count > 0 ? ` · ${r.count}` : ''}
            </div>
          </div>
        </div>
      ))}
      <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
        Top {data.rows.length} of {inr(data.totalPaise)} shown.
      </div>
    </div>
  );
}
