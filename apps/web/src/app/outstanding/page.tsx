'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { post, inr, shortDate, type Outstanding } from '../../lib/api';
import {
  Avatar, Badge, Button, Card, Empty, ErrorNote, OfflineBar, PageTitle, Sno,
  Spinner,
} from '../../components/ui';
import Filters, { type FilterSpec, type FilterValues, matches } from '../../components/Filters';

const BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;

export default function OutstandingPage() {
  const { company } = useAuth();
  const [kind, setKind] = useState<'receivable' | 'payable'>('receivable');
  const [bucket, setBucket] = useState<string | null>(null);
  const [f, setF] = useState<FilterValues>({});
  const [open, setOpen] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, string>>({});

  const { data, error, loading, reload, stale, offline } = useApi<Outstanding>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/outstanding?kind=${kind}` : null,
    [company?.tallyGuid, kind],
  );

  async function remind(party: string, phone: string, amountPaise: number) {
    setSent((s) => ({ ...s, [party]: 'sending' }));
    try {
      await post('/v1/reminders/send', {
        party, phone, amountPaise, channel: 'whatsapp', companyGuid: company?.tallyGuid,
      });
      setSent((s) => ({ ...s, [party]: 'sent' }));
    } catch (e) {
      setSent((s) => ({ ...s, [party]: (e as Error).message }));
    }
  }

  if (!company) return <Empty title="No company yet" hint="Connect Tally to see outstanding." />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label="Loading outstanding…" />;

  /*
   * What this list can be narrowed by.
   *
   * Declared here rather than inside the strip because the answers come from
   * the loaded data - the credit-terms options below are the terms this
   * business actually uses, not a guess at what an SMB might have.
   */
  type Party = Outstanding['items'][number];
  const terms = [...new Set(data.items.map((p) => p.creditDays))].sort((a, b) => a - b);
  const specs: FilterSpec<Party>[] = [
    { key: 'q', label: 'Party', kind: 'search', on: (p) => p.party,
      placeholder: 'Search party…' },
    { key: 'amt', label: 'Amount pending', kind: 'amountRange', on: (p) => p.totalPaise },
    { key: 'overdue', label: 'Has overdue', kind: 'toggle', on: (p) => p.overduePaise > 0 },
    { key: 'phone', label: 'Has a phone number', kind: 'toggle', on: (p) => !!p.phone },
    { key: 'terms', label: 'Credit terms', kind: 'select',
      on: (p) => String(p.creditDays),
      options: terms.map((d) => ({ value: String(d), label: d === 0 ? 'Cash' : `${d} days` })) },
    { key: 'age', label: 'Oldest bill', kind: 'select',
      on: (p) => bucketOf(p.oldestDays),
      options: BUCKETS.map((b) => ({ value: b, label: b === '90+' ? '90+ days' : `${b} days` })) },
  ];

  const items = data.items.filter((p) => {
    if (!matches(p, specs, f)) return false;
    if (!bucket) return true;
    return p.bills.some((b) => b.days > 0 && bucketOf(b.days) === bucket);
  });

  return (
    <>
      <PageTitle
        title={kind === 'receivable' ? 'Who owes you' : 'What you owe'}
        subtitle="Bill-wise, oldest first. Tap a party to see their invoices."
      />
      <OfflineBar offline={offline} ageMs={stale} />

      <Filters specs={specs} values={f} onChange={setF}>
        <div className="inline-flex overflow-hidden rounded-lg border border-line">
          {(['receivable', 'payable'] as const).map((k) => (
            <button key={k} onClick={() => { setKind(k); setBucket(null); }}
              className={`px-4 py-2 text-sm font-semibold ${
                kind === k ? 'bg-brand-700 text-white' : 'bg-white text-body hover:bg-canvas'}`}>
              {k === 'receivable' ? 'Receivable' : 'Payable'}
            </button>
          ))}
        </div>
      </Filters>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {BUCKETS.map((b) => {
          const active = bucket === b;
          return (
            <button key={b} onClick={() => setBucket(active ? null : b)}
              className={`rounded-xl border p-4 text-left transition ${
                active ? 'border-brand-600 bg-brand-50' : 'border-line bg-white hover:border-line'}`}>
              <div className="text-xs font-semibold uppercase tracking-wider text-muted">
                {b === '90+' ? '90+ days' : `${b} days`}
              </div>
              <div className={`mt-1 text-xl font-bold tabular-nums ${b === '90+' ? 'text-rose-700' : ''}`}>
                {inr(data.totals.buckets[b] ?? 0, { compact: true })}
              </div>
            </button>
          );
        })}
      </div>

      <Card className="mb-5">
        <div className="flex flex-wrap gap-x-10 gap-y-2 text-sm">
          <Figure label="Total outstanding" value={inr(data.totals.total)} />
          <Figure label="Overdue" value={inr(data.totals.overdue)} tone="bad" />
          <Figure label="Parties" value={String(data.items.length)} />
        </div>
      </Card>

      {items.length === 0 ? (
        <Empty title="Nothing here" hint={bucket ? 'No bills in this ageing bucket.' : 'No pending amounts.'} />
      ) : (
        <div className="grid gap-3">
          {items.map((p, i) => {
            const isOpen = open === p.party;
            const state = sent[p.party];
            return (
              <Card key={p.party}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {/*
                    * Rank and initials. This list is worked down in order -
                    * somebody chases the top of it - so the position is part of
                    * the information, not decoration.
                    */}
                  <div className="flex shrink-0 items-center gap-2.5 pt-0.5">
                    <Sno n={i + 1} />
                    <Avatar name={p.party} />
                  </div>
                  <button onClick={() => setOpen(isOpen ? null : p.party)}
                    className="min-w-0 flex-1 text-left">
                    <p className="font-semibold">{p.party}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {(p.bills ?? []).length} open bill{(p.bills ?? []).length === 1 ? '' : 's'}
                      {p.phone ? ` · ${p.phone}` : ''}
                      {p.creditDays ? ` · ${p.creditDays} day credit` : ''}
                    </p>
                  </button>
                  <div className="flex items-center gap-3">
                    {p.oldestDays > 0 ? (
                      <Badge tone={p.oldestDays > 90 ? 'bad' : 'warn'}>{p.oldestDays} days overdue</Badge>
                    ) : <Badge tone="ok">On time</Badge>}
                    <div className="text-right">
                      <div className="font-bold tabular-nums">{inr(p.totalPaise)}</div>
                      {p.overduePaise > 0 ? (
                        <div className="text-xs tabular-nums text-rose-700">
                          {inr(p.overduePaise)} overdue
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>

                {isOpen ? (
                  <div className="mt-4 border-t border-line-soft pt-4">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs uppercase tracking-wider text-muted">
                            <th className="pb-2 font-semibold">Invoice</th>
                            <th className="pb-2 font-semibold">Date</th>
                            <th className="pb-2 font-semibold">Due</th>
                            <th className="pb-2 font-semibold">Age</th>
                            <th className="pb-2 text-right font-semibold">Pending</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(p.bills ?? []).map((b) => (
                            <tr key={b.ref} className="border-t border-line-soft">
                              <td className="py-2">{b.ref}</td>
                              <td className="whitespace-nowrap py-2">{shortDate(b.date)}</td>
                              <td className="whitespace-nowrap py-2">{shortDate(b.dueDate)}</td>
                              <td className={`py-2 tabular-nums ${b.days > 90 ? 'font-semibold text-rose-700' : ''}`}>
                                {b.days > 0 ? `${b.days}d late` : 'not due'}
                              </td>
                              <td className="py-2 text-right font-semibold tabular-nums">
                                {inr(b.pendingPaise)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <Button onClick={() => remind(p.party, p.phone, p.overduePaise || p.totalPaise)}
                        disabled={state === 'sending' || state === 'sent'}>
                        {state === 'sent' ? 'Reminder sent ✓'
                          : state === 'sending' ? 'Sending…' : 'Send WhatsApp reminder'}
                      </Button>
                      <Link href={`/parties/${encodeURIComponent(p.party)}`}>
                        <Button variant="ghost">View statement</Button>
                      </Link>
                      {p.phone ? (
                        <a href={`tel:${p.phone}`}><Button variant="ghost">Call</Button></a>
                      ) : null}
                      {state && state !== 'sent' && state !== 'sending' ? (
                        <span className="text-sm text-rose-700">{state}</span>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function bucketOf(days: number) {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${tone === 'bad' ? 'text-rose-700' : ''}`}>{value}</div>
    </div>
  );
}
