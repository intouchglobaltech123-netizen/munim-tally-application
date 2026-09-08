'use client';

import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { useMoney } from '../../lib/money';
import { type GstSummary, type GstHealth, type GstHsn, type GstParties } from '../../lib/api';
import {
  Badge, Card, Empty, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  Receipt, ShieldCheck, AlertTriangle, CheckCircle2, Hash, Users, Info,
  ArrowDownLeft, ArrowUpRight, Scale, FileWarning,
} from 'lucide-react';

/**
 * GST, read out of the books rather than filed from them.
 *
 * The health checks come first on purpose. The summary tells a customer what
 * they owe; the checks tell them what will be rejected — and that is worth
 * more, because it is cheap to fix this week and expensive after filing.
 */

const PERIODS = [
  { key: 'month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'fy', label: 'Financial year' },
];

const TABS = [
  { key: 'summary', label: 'Summary' },
  { key: 'health', label: 'Checks' },
  { key: 'hsn', label: 'HSN' },
  { key: 'parties', label: 'By party' },
];

export default function GstPage() {
  const { company } = useAuth();
  const money = useMoney();
  const [period, setPeriod] = useState('fy');
  const [tab, setTab] = useState('summary');

  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;
  const qs = `?period=${period}`;
  const sum = useApi<GstSummary>(base && `${base}/gst${qs}`, [company?.tallyGuid, period]);
  const health = useApi<GstHealth>(base && `${base}/gst-health${qs}`, [company?.tallyGuid, period]);
  const hsn = useApi<GstHsn>(base && `${base}/gst-hsn${qs}`, [company?.tallyGuid, period]);
  const parties = useApi<GstParties>(base && `${base}/gst-parties${qs}`, [company?.tallyGuid, period]);

  if (sum.error) return <ErrorNote message={sum.error} onRetry={sum.reload} />;
  if (sum.loading && !sum.data) return <Spinner label="Adding up your GST…" />;
  if (!sum.data) return <Empty title="Nothing yet" icon={Receipt} hint="Connect Tally first." />;

  const d = sum.data;
  const pos = d.position;

  return (
    <>
      <PageTitle title="GST"
        subtitle={`${d.period.label} · ${d.period.from} to ${d.period.to}`} />

      {/* The customer's own GSTIN, checked. Every invoice they print carries
          it, so a wrong one is wrong everywhere. */}
      <div className={`mb-5 flex flex-wrap items-center gap-3 rounded-lg px-4 py-3 text-sm
                       ring-1 ${d.company.gstinCheck.valid
        ? 'bg-emerald-50 ring-emerald-200' : 'bg-rose-50 ring-rose-200'}`}>
        {d.company.gstinCheck.valid
          ? <CheckCircle2 size={17} className="text-emerald-600" />
          : <AlertTriangle size={17} className="text-rose-600" />}
        <span className="font-semibold text-slate-800">
          {d.company.gstin || 'No GSTIN set in Tally'}
        </span>
        <span className="text-slate-600">{d.company.gstinCheck.message}</span>
        {d.company.gstinCheck.stateName && (
          <Badge tone="ok">{d.company.gstinCheck.stateName}</Badge>
        )}
      </div>

      <div className="mb-5 flex flex-wrap items-center gap-1.5">
        {PERIODS.map((p) => (
          <button key={p.key} onClick={() => setPeriod(p.key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              period === p.key ? 'bg-brand-700 text-white'
                               : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
            {p.label}
          </button>
        ))}
      </div>

      {/* The position, which is the figure people come for. */}
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Card>
          <div className="text-xs font-medium text-slate-500">Output tax (on sales)</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
            {money(pos.outputTaxPaise)}
          </div>
          <div className="text-[11px] text-slate-400">
            {d.outward.count} invoices, less {d.creditNotes.count} credit notes
          </div>
        </Card>
        <Card>
          <div className="text-xs font-medium text-slate-500">Input tax (on purchases)</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
            {money(pos.inputTaxPaise)}
          </div>
          <div className="text-[11px] text-slate-400">
            {d.inward.count} bills, less {d.debitNotes.count} debit notes
          </div>
        </Card>
        <Card className={pos.direction === 'payable' ? 'ring-2 ring-rose-300'
          : pos.direction === 'credit' ? 'ring-2 ring-emerald-300' : ''}>
          <div className="text-xs font-medium text-slate-500">
            {pos.direction === 'credit' ? 'Credit carried forward'
              : pos.direction === 'payable' ? 'Payable to government' : 'Net position'}
          </div>
          <div className={`mt-1 text-2xl font-bold tabular-nums ${
            pos.direction === 'payable' ? 'text-rose-700'
              : pos.direction === 'credit' ? 'text-emerald-700' : 'text-slate-900'}`}>
            {money(Math.abs(pos.netPaise))}
          </div>
          <div className="text-[11px] text-slate-400">
            {pos.direction === 'credit'
              ? 'More input than output — nothing to pay.'
              : pos.direction === 'nil' ? 'Nothing either way.'
              : 'Output tax less input tax.'}
          </div>
        </Card>
      </div>

      <div className="mb-5 flex flex-wrap gap-1.5 border-b border-line pb-3">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
              tab === t.key ? 'bg-brand-700 text-white'
                            : 'text-muted hover:bg-line-soft hover:text-ink'}`}>
            {t.label}
            {t.key === 'health' && health.data && health.data.total > 0 && (
              <span className="ml-1.5 rounded-full bg-rose-600 px-1.5 text-[10px] text-white">
                {health.data.total}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'summary' && (
        <>
          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            <Card>
              <SectionTitle icon={ArrowUpRight}>Outward supplies</SectionTitle>
              <Row k="B2B (registered buyers)" v={money(d.b2b.taxable)} sub={`${d.b2b.count} invoices`} />
              <Row k="B2C (unregistered)" v={money(d.b2c.taxable)} sub={`${d.b2c.count} invoices`} />
              <Row k="Taxable value" v={money(d.outward.taxable)} strong />
              <Row k="CGST" v={money(d.outward.tax.cgst)} />
              <Row k="SGST" v={money(d.outward.tax.sgst)} />
              <Row k="IGST" v={money(d.outward.tax.igst)} />
              {d.outward.tax.cess > 0 && <Row k="Cess" v={money(d.outward.tax.cess)} />}
              <Row k="Total tax" v={money(d.outward.taxTotal)} strong />
            </Card>
            <Card>
              <SectionTitle icon={ArrowDownLeft}>Inward supplies</SectionTitle>
              <Row k="Taxable value" v={money(d.inward.taxable)} strong />
              <Row k="CGST" v={money(d.inward.tax.cgst)} />
              <Row k="SGST" v={money(d.inward.tax.sgst)} />
              <Row k="IGST" v={money(d.inward.tax.igst)} />
              {d.inward.tax.cess > 0 && <Row k="Cess" v={money(d.inward.tax.cess)} />}
              <Row k="Total tax" v={money(d.inward.taxTotal)} strong />
            </Card>
          </div>

          <SectionTitle icon={Scale} note="rate applied, derived from the figures">
            Outward supplies by rate
          </SectionTitle>
          {d.byRate.length === 0 ? (
            <Empty title="Nothing to break down" icon={Scale}
              hint="No sales in this period." />
          ) : (
            <Card>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase
                                 tracking-wide text-slate-400">
                    <th className="pb-2 pr-3 font-semibold">Rate</th>
                    <th className="pb-2 pr-3 text-right font-semibold">Invoices</th>
                    <th className="pb-2 pr-3 text-right font-semibold">Taxable</th>
                    <th className="pb-2 pr-3 text-right font-semibold">CGST</th>
                    <th className="pb-2 pr-3 text-right font-semibold">SGST</th>
                    <th className="pb-2 pr-3 text-right font-semibold">IGST</th>
                    <th className="pb-2 text-right font-semibold">Tax</th>
                  </tr>
                </thead>
                <tbody>
                  {d.byRate.map((r) => (
                    <tr key={r.ratePct} className="border-b border-slate-50 last:border-0">
                      <td className="py-2 pr-3 font-semibold">{r.ratePct}%</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{r.count}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{money(r.taxable)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{money(r.tax.cgst)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{money(r.tax.sgst)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{money(r.tax.igst)}</td>
                      <td className="py-2 text-right tabular-nums font-semibold">{money(r.taxTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}

      {tab === 'health' && (
        health.loading && !health.data ? <Spinner /> : (
          <>
            {health.data?.total === 0 ? (
              <div className="flex items-center gap-3 rounded-lg bg-emerald-50 px-4 py-3
                              ring-1 ring-emerald-200">
                <CheckCircle2 size={18} className="text-emerald-600" />
                <span className="text-sm font-semibold text-emerald-900">
                  Nothing wrong found in this period.
                </span>
              </div>
            ) : (
              <div className="space-y-3">
                {health.data?.findings.filter((f) => f.count > 0).map((f) => (
                  <Card key={f.key}>
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={17}
                        className={f.tone === 'bad' ? 'mt-0.5 text-rose-600' : 'mt-0.5 text-amber-600'} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-900">{f.label}</span>
                          <Badge tone={f.tone === 'bad' ? 'bad' : 'warn'}>{f.count}</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-slate-500">{f.detail}</p>
                        {f.items && f.items.length > 0 && (
                          <div className="mt-2 max-h-56 overflow-auto rounded-lg bg-slate-50 p-2">
                            {f.items.map((it, i) => (
                              <div key={i} className="py-0.5 font-mono text-[11px] text-slate-600">
                                {formatItem(it)}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
            <p className="mt-5 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                          text-xs text-slate-500">
              <Info size={13} className="mt-0.5 shrink-0" />
              {health.data?.note}
            </p>
          </>
        )
      )}

      {tab === 'hsn' && (
        hsn.loading && !hsn.data ? <Spinner /> : (
          <>
            {hsn.data && hsn.data.missingHsn.lines > 0 && (
              <div className="mb-4 flex items-start gap-2.5 rounded-lg bg-amber-50 px-4 py-3
                              text-sm ring-1 ring-amber-200">
                <FileWarning size={17} className="mt-0.5 shrink-0 text-amber-600" />
                <span className="text-amber-900">
                  <b>{hsn.data.missingHsn.lines} lines have no HSN</b>, covering{' '}
                  {money(hsn.data.missingHsn.valuePaise)}. A return needs HSN on every line
                  above the turnover threshold — set them on the item in Tally.
                </span>
              </div>
            )}
            {!hsn.data?.rows.length ? (
              <Empty title="No HSN data" icon={Hash}
                hint={hsn.data?.note || 'No item lines in this period.'} />
            ) : (
              <Card>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase
                                   tracking-wide text-slate-400">
                      <th className="pb-2 pr-3 font-semibold">HSN/SAC</th>
                      <th className="pb-2 pr-3 text-right font-semibold">Rate</th>
                      <th className="pb-2 pr-3 text-right font-semibold">Qty</th>
                      <th className="pb-2 pr-3 text-right font-semibold">Invoices</th>
                      <th className="pb-2 text-right font-semibold">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hsn.data.rows.map((r) => (
                      <tr key={r.hsn + r.ratePct} className="border-b border-slate-50 last:border-0">
                        <td className="py-2 pr-3 font-mono">{r.hsn}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {r.ratePct > 0 ? `${r.ratePct}%` : '—'}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {r.qty} {r.unit}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums text-slate-500">{r.vouchers}</td>
                        <td className="py-2 text-right tabular-nums font-semibold">
                          {money(r.valuePaise)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        )
      )}

      {tab === 'parties' && (
        parties.loading && !parties.data ? <Spinner /> : (
          !parties.data?.parties.length ? (
            <Empty title="Nothing here" icon={Users} hint="No trade in this period." />
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[680px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase
                                   tracking-wide text-slate-400">
                      <th className="pb-2 pr-3 font-semibold">Party</th>
                      <th className="pb-2 pr-3 font-semibold">GSTIN</th>
                      <th className="pb-2 pr-3 text-right font-semibold">Sales</th>
                      <th className="pb-2 pr-3 text-right font-semibold">Purchases</th>
                      <th className="pb-2 text-right font-semibold">Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parties.data.parties.map((p) => (
                      <tr key={p.party} className="border-b border-slate-50 last:border-0">
                        <td className="py-2 pr-3">
                          <div className="font-medium text-slate-800">{p.party}</div>
                          <Badge tone={p.kind === 'b2b' ? 'ok' : 'warn'}>
                            {p.kind.toUpperCase()}
                          </Badge>
                        </td>
                        <td className="py-2 pr-3">
                          <span className="font-mono text-xs">{p.gstin || '—'}</span>
                          {p.gstinCheck && !p.gstinCheck.valid && (
                            <div className="text-[11px] text-rose-600">{p.gstinCheck.message}</div>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{money(p.sales)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{money(p.purchases)}</td>
                        <td className="py-2 text-right tabular-nums font-semibold">
                          {money(p.salesTax + p.purchasesTax)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )
        )
      )}

      <p className="mt-6 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                    text-xs text-slate-500">
        <Info size={13} className="mt-0.5 shrink-0" />
        {d.note}
      </p>
    </>
  );
}

/** Findings carry different shapes; render whichever fields are present. */
function formatItem(it: Record<string, unknown>): string {
  if (it.name && it.gstin) return `${it.name} — ${it.gstin}`;
  if (it.no) return `#${it.no} ${it.party ?? ''} ${it.date ? String(it.date).slice(0, 10) : ''}`
    + (it.expected ? ` — expected ${it.expected}, charged ${it.actual}` : '');
  if (it.party) return `${it.party} — ${it.count ?? ''} invoice(s)`;
  return JSON.stringify(it);
}

function Row({ k, v, sub, strong }: {
  k: string; v: string; sub?: string; strong?: boolean;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-4 py-1.5 ${
      strong ? 'border-t border-slate-200 font-semibold' : 'border-b border-slate-50'}`}>
      <span className="text-sm text-slate-600">
        {k}
        {sub && <span className="ml-1.5 text-[11px] text-slate-400">{sub}</span>}
      </span>
      <span className={`tabular-nums ${strong ? 'text-slate-900' : 'text-sm text-slate-700'}`}>
        {v}
      </span>
    </div>
  );
}
