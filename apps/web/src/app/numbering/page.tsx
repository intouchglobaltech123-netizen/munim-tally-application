'use client';

import Link from 'next/link';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { useMoney } from '../../lib/money';
import { type NumberingReport } from '../../lib/api';
import {
  Badge, Card, Empty, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  Hash, Copy, AlertTriangle, CalendarX, CheckCircle2, Info, ListOrdered,
} from 'lucide-react';

/**
 * Whether the invoice numbering holds up.
 *
 * Three things nobody checks by hand and every assessment asks about. A
 * duplicate invoice number is a compliance problem that otherwise surfaces
 * months later, when fixing it is expensive and the explanation is awkward.
 */
export default function NumberingPage() {
  const { company } = useAuth();
  const money = useMoney();

  const { data, error, loading, reload } = useApi<NumberingReport>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/numbering` : null,
    [company?.tallyGuid]);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner label="Checking your invoice numbers…" />;
  if (!data) return <Empty title="Nothing yet" icon={Hash} hint="Connect Tally first." />;

  const clean = data.findings.duplicates === 0
    && data.findings.gaps === 0 && data.findings.outOfOrder === 0;

  return (
    <>
      <PageTitle title="Invoice numbering"
        subtitle={`${data.invoices.toLocaleString('en-IN')} sales invoices checked.`} />

      {clean ? (
        <div className="mb-6 flex items-center gap-3 rounded-lg bg-emerald-50 px-4 py-3
                        ring-1 ring-emerald-200">
          <CheckCircle2 size={18} className="text-emerald-600" />
          <span className="text-sm font-semibold text-emerald-900">
            No duplicates, no gaps, nothing dated out of order.
          </span>
        </div>
      ) : (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <Finding n={data.findings.duplicates} label="Duplicate numbers" icon={Copy}
            hint="The same number issued twice." bad />
          <Finding n={data.findings.gaps} label="Missing numbers" icon={ListOrdered}
            hint="Gaps in a sequence." />
          <Finding n={data.findings.outOfOrder} label="Out of order" icon={CalendarX}
            hint="Dated before a lower number." />
        </div>
      )}

      {data.duplicates.length > 0 && (
        <>
          <SectionTitle icon={Copy}>Duplicate invoice numbers</SectionTitle>
          <div className="mb-6 space-y-3">
            {data.duplicates.map((d) => (
              <Card key={d.number}>
                <div className="flex items-center gap-2">
                  <AlertTriangle size={15} className="text-rose-600" />
                  <span className="font-bold text-slate-900">{d.number}</span>
                  <Badge tone="bad">used {d.count} times</Badge>
                </div>
                <div className="mt-3 space-y-1">
                  {d.vouchers.map((v) => (
                    <Link key={v.id} href={`/invoice/${v.id}`}
                      className="flex items-center justify-between gap-3 rounded px-2 py-1.5
                                 text-sm hover:bg-slate-50">
                      <span className="text-slate-700">{v.party || '—'}</span>
                      <span className="text-xs text-slate-500">{v.date.slice(0, 10)}</span>
                      <span className="tabular-nums font-semibold">{money(v.amountPaise)}</span>
                      {v.cancelled && <Badge tone="warn">cancelled</Badge>}
                    </Link>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      <SectionTitle icon={Hash}>Series</SectionTitle>
      <div className="space-y-3">
        {data.series.map((s) => (
          <Card key={s.series}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-semibold text-slate-900">{s.series}</div>
                <div className="text-xs text-slate-500">
                  {s.count.toLocaleString('en-IN')} invoices · {s.first} to {s.last}
                </div>
              </div>
              <div className="flex gap-2">
                {s.missingCount > 0 && <Badge tone="warn">{s.missingCount} missing</Badge>}
                {s.outOfOrder.length > 0 && (
                  <Badge tone="warn">{s.outOfOrder.length} out of order</Badge>
                )}
                {s.missingCount === 0 && s.outOfOrder.length === 0 && (
                  <Badge tone="ok">Clean</Badge>
                )}
              </div>
            </div>

            {s.missing.length > 0 && (
              <div className="mt-3 rounded-lg bg-amber-50 p-3">
                <div className="text-xs font-semibold text-amber-900">Missing numbers</div>
                <div className="mt-1 font-mono text-xs text-amber-800">
                  {s.missing.slice(0, 60).join(', ')}
                  {s.missing.length > 60 && ` … and ${s.missing.length - 60} more`}
                </div>
                {/* A gap is not automatically wrong, and saying so avoids a
                    support call from every customer who deletes a draft. */}
                <p className="mt-1.5 text-[11px] text-amber-700">
                  A gap is not always a problem — a cancelled or deleted voucher leaves one.
                  It is worth knowing which.
                </p>
              </div>
            )}

            {s.outOfOrder.length > 0 && (
              <div className="mt-3 rounded-lg bg-slate-50 p-3">
                <div className="text-xs font-semibold text-slate-700">Dated out of order</div>
                <div className="mt-1 space-y-0.5">
                  {s.outOfOrder.slice(0, 20).map((o) => (
                    <div key={o.number} className="text-xs text-slate-600">
                      <b>{o.number}</b> dated {o.date.slice(0, 10)} comes after{' '}
                      <b>{o.after}</b> dated {o.afterDate.slice(0, 10)}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        ))}
      </div>

      <p className="mt-6 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                    text-xs text-slate-500">
        <Info size={13} className="mt-0.5 shrink-0" />
        {data.note}
      </p>
    </>
  );
}

function Finding({ n, label, icon: Icon, hint, bad }: {
  n: number; label: string; icon: typeof Copy; hint: string; bad?: boolean;
}) {
  const tone = n === 0 ? 'text-emerald-700'
    : bad ? 'text-rose-700' : 'text-amber-600';
  return (
    <Card>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs font-medium text-slate-500">{label}</div>
          <div className={`mt-1 text-2xl font-bold tabular-nums ${tone}`}>{n}</div>
          <div className="text-[11px] text-slate-400">{hint}</div>
        </div>
        <Icon size={16} className="text-slate-300" />
      </div>
    </Card>
  );
}
