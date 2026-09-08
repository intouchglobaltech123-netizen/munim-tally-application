'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { useMoney } from '../../lib/money';
import { type PartiesPayload } from '../../lib/api';
import {
  Avatar, Badge, Card, Empty, ErrorNote, OfflineBar, PageTitle, Sno, Spinner,
} from '../../components/ui';
import {
  Users, Search, Phone, Mail, Hash, MapPin, AlertTriangle, ArrowUpDown,
  Tag, Info, ChevronRight, Truck,
} from 'lucide-react';

/**
 * Everyone you trade with.
 *
 * Customers and suppliers are one screen with a switch rather than two, because
 * they are the same record in Tally and differ only by the group they sit in -
 * and a shop that files a customer under a group of its own invention would
 * fall off a list that hard-coded the names.
 */

const KINDS = [
  { key: 'customer', label: 'Customers', icon: Users },
  { key: 'supplier', label: 'Suppliers', icon: Truck },
  { key: 'all', label: 'Every ledger', icon: Hash },
];

const SORTS = [
  { key: 'balance', label: 'Biggest balance' },
  { key: 'name', label: 'Name' },
  { key: 'recent', label: 'Recently changed' },
];

export default function PartiesPage() {
  const { company } = useAuth();
  const money = useMoney();
  const [kind, setKind] = useState('customer');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('balance');
  const [tag, setTag] = useState('');
  const [owing, setOwing] = useState(false);

  const qs = new URLSearchParams({ kind, sort });
  if (q.trim()) qs.set('q', q.trim());
  if (tag) qs.set('tag', tag);
  if (owing) qs.set('owing', '1');

  const { data, error, loading, reload, stale, offline } = useApi<PartiesPayload>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/parties?${qs}` : null,
    [company?.tallyGuid, kind, q, sort, tag, owing]);

  if (error) return <ErrorNote message={error} onRetry={reload} />;

  return (
    <>
      <PageTitle title="Parties" subtitle="Customers, suppliers and every other ledger." />
      <OfflineBar offline={offline} ageMs={stale} />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {KINDS.map((k) => (
          <button key={k.key} onClick={() => setKind(k.key)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs
                        font-semibold transition ${
              kind === k.key ? 'bg-brand-700 text-white'
                             : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
            <k.icon size={13} /> {k.label}
          </button>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, GSTIN or phone"
            className="w-full rounded-lg border border-line py-2 pl-9 pr-3 text-sm
                       outline-none focus:border-brand-500" />
        </div>
        <div className="flex items-center gap-1.5">
          <ArrowUpDown size={14} className="text-slate-400" />
          {SORTS.map((s) => (
            <button key={s.key} onClick={() => setSort(s.key)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                sort === s.key ? 'bg-slate-800 text-white'
                               : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
              {s.label}
            </button>
          ))}
        </div>
        <button onClick={() => setOwing(!owing)}
          className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
            owing ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
          Only with a balance
        </button>
      </div>

      {data && data.tags.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <Tag size={13} className="text-slate-400" />
          {data.tags.map((t) => (
            <button key={t} onClick={() => setTag(tag === t ? '' : t)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                tag === t ? 'bg-brand-700 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
              {t}
            </button>
          ))}
        </div>
      )}

      {data && (
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          <Stat label="Parties" value={data.totals.count.toLocaleString('en-IN')} />
          <Stat label="Owed to you" value={money(data.totals.owedToYouPaise)} tone="good" />
          <Stat label="You owe" value={money(data.totals.youOwePaise)} tone="bad" />
        </div>
      )}

      {loading && !data ? <Spinner label="Loading your parties…" />
        : !data?.parties.length ? (
          <Empty title="Nothing here" icon={Users}
            hint={q ? `No party matches "${q}".` : 'Parties appear as Tally syncs them.'} />
        ) : (
          <div className="space-y-2">
            {data.parties.map((p, i) => (
              <Link key={p.name}
                href={`/parties/${encodeURIComponent(p.name)}`}
                className="block">
                <Card className="transition hover:border-brand-300">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    {/*
                      * A serial number and initials down the left edge.
                      *
                      * Both are for finding a row rather than reading it: the
                      * number gives somebody a place to point at down a phone
                      * line, and the disc is the same colour for the same
                      * customer on every screen, so the eye lands on it before
                      * it has read a word.
                      */}
                    <div className="flex shrink-0 items-center gap-2.5 pt-0.5">
                      <Sno n={i + 1} />
                      <Avatar name={p.name} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900">{p.name}</span>
                        {p.overLimit && (
                          <Badge tone="bad">
                            <AlertTriangle size={10} className="mr-0.5 inline" />
                            Over limit
                          </Badge>
                        )}
                        {p.tags.map((t) => (
                          <span key={t} className="rounded-full bg-slate-100 px-2 py-0.5
                                                   text-[10px] font-medium text-slate-600">
                            {t}
                          </span>
                        ))}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                        <span>{p.group}</span>
                        {p.tax.gstin && (
                          <span className="inline-flex items-center gap-1 font-mono">
                            <Hash size={11} />{p.tax.gstin}
                          </span>
                        )}
                        {p.contact.phone && (
                          <span className="inline-flex items-center gap-1">
                            <Phone size={11} />{p.contact.phone}
                          </span>
                        )}
                        {p.contact.email && (
                          <span className="inline-flex items-center gap-1">
                            <Mail size={11} />{p.contact.email}
                          </span>
                        )}
                        {p.contact.state && (
                          <span className="inline-flex items-center gap-1">
                            <MapPin size={11} />{p.contact.state}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3 text-right">
                      <div>
                        <div className={`text-base font-bold tabular-nums ${
                          p.closingPaise > 0 ? 'text-emerald-700'
                            : p.closingPaise < 0 ? 'text-rose-700' : 'text-slate-400'}`}>
                          {money(Math.abs(p.closingPaise))}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {p.closingPaise > 0 ? 'owes you'
                            : p.closingPaise < 0 ? 'you owe' : 'settled'}
                          {p.creditDays > 0 && ` · ${p.creditDays}d terms`}
                        </div>
                      </div>
                      <ChevronRight size={16} className="text-slate-300" />
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}

      {data && (
        <p className="mt-5 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                      text-xs text-slate-500">
          <Info size={13} className="mt-0.5 shrink-0" />
          {data.readOnly} Munim never writes to your books.
        </p>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <Card>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${
        tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-700' : 'text-slate-900'}`}>
        {value}
      </div>
    </Card>
  );
}
