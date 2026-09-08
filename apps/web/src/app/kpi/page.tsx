'use client';

import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { inr, shortDate, type Kpis } from '../../lib/api';
import {
  Badge, Card, Empty, ErrorNote, PageTitle, SectionTitle, Settling, Spinner,
  TileSkeleton,
} from '../../components/ui';
import {
  TrendingUp, TrendingDown, Wallet, ShoppingCart, Package, PieChart,
  Info, AlertTriangle, Users2, Boxes,
} from 'lucide-react';

/**
 * The numbers a business is actually run on.
 *
 * One screen rather than five, because the questions they answer are asked
 * together: am I selling more, is the money arriving, what is it costing me,
 * what is sitting on the shelf, and is any of it profit.
 *
 * Every approximation on this page carries its caveat inline rather than in a
 * footnote. A KPI whose derivation is invisible is one nobody trusts the second
 * time it disagrees with Tally.
 */
export default function KpiPage() {
  const { company, loading } = useAuth();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);

  const qs = range ? `?from=${range.from}&to=${range.to}` : '';
  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;
  const k = useApi<Kpis>(base && `${base}/kpi${qs}`, [company?.tallyGuid, qs]);

  if (loading) return <Spinner />;
  if (!company) {
    return <Empty title="No company yet" icon={PieChart}
      hint="Connect the computer running Tally and these fill in on their own." />;
  }
  if (k.error) return <ErrorNote message={k.error} onRetry={k.reload} />;
  if (!k.data) {
    return (
      <>
        <PageTitle title="Key numbers" subtitle={company.name} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <TileSkeleton count={8} />
        </div>
      </>
    );
  }

  const { sales: s, collection: c, purchases: p, inventory: i, profitability: pr } = k.data;

  return (
    <>
      <PageTitle title="Key numbers"
        subtitle={`${company.name} · ${s.period.label}`}
        right={
          <div className="flex items-center gap-2">
            <input type="date" defaultValue={s.period.from}
              onChange={(e) => setRange({ from: e.target.value, to: range?.to ?? s.period.to })}
              className="rounded-lg border border-line px-2 py-1.5 text-sm" />
            <span className="text-sm text-muted">to</span>
            <input type="date" defaultValue={s.period.to}
              onChange={(e) => setRange({ from: range?.from ?? s.period.from, to: e.target.value })}
              className="rounded-lg border border-line px-2 py-1.5 text-sm" />
          </div>
        } />

      <Settling when={k.refreshing}>
      {/* Sales */}
      <SectionTitle icon={TrendingUp} note="what came in">Sales</SectionTitle>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Revenue" value={inr(s.revenuePaise)}
          delta={s.growthPercent}
          sub={s.growthPercent === null
            ? 'no earlier year to compare with'
            : `vs ${inr(s.priorRevenuePaise)} last year`} />
        <Kpi label="Invoices" value={s.invoices.toLocaleString('en-IN')} />
        <Kpi label="Average invoice" value={inr(s.averageInvoicePaise)} />
        <Kpi label="Biggest customer"
          value={s.concentration ? `${s.concentration.topCustomerPercent}%` : '—'}
          sub={s.topCustomers[0]?.party ?? 'nothing sold yet'}
          warn={Boolean(s.concentration && s.concentration.topCustomerPercent > 40)} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle icon={Users2}>Top customers</SectionTitle>
          <Ranked rows={s.topCustomers.map((x) => ({
            label: x.party, value: inr(x.amountPaise),
            share: x.sharePercent, sub: `${x.invoices} invoices` }))} />
        </Card>
        <Card>
          <SectionTitle icon={Boxes}>Top products</SectionTitle>
          <Ranked rows={s.topProducts.map((x) => ({
            label: x.item, value: inr(x.amountPaise),
            share: s.revenuePaise ? (x.amountPaise / s.revenuePaise) * 100 : 0,
            sub: `${x.qty.toLocaleString('en-IN')} sold` }))} />
        </Card>
      </div>

      {!s.salespeople.available && (
        <Note>{s.salespeople.note}</Note>
      )}

      {/* Collection */}
      <SectionTitle icon={Wallet} note="whether the money actually arrives">
        Collection
      </SectionTitle>
      <div className="mb-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Receivable" value={inr(c.receivablePaise)}
          sub={`${c.bills} open bills`} />
        <Kpi label="Overdue" value={inr(c.overduePaise)}
          sub={c.overdueBills ? `oldest ${c.oldestOverdueDays} days` : 'nothing overdue'}
          warn={c.overduePaise > 0} />
        <Kpi label="Average days to pay"
          value={c.averagePaymentDays === null ? '—' : `${c.averagePaymentDays}`}
          sub={c.averagePaymentBasis} />
        <Kpi label="DSO" value={c.dsoDays === null ? '—' : `${c.dsoDays} days`}
          sub={c.dsoNote} />
      </div>
      <Note>{c.collectionRateNote}
        {c.collectionRatePercent !== null
          && ` Currently ${c.collectionRatePercent}%.`}</Note>

      {/* Purchases */}
      <SectionTitle icon={ShoppingCart} note="what it cost to stock">Purchases</SectionTitle>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Purchases" value={inr(p.amountPaise)} delta={p.growthPercent}
          sub={p.growthPercent === null ? 'no earlier year' : `vs ${inr(p.priorAmountPaise)}`} />
        <Kpi label="Bills" value={p.bills.toLocaleString('en-IN')} />
        <Kpi label="Biggest supplier"
          value={p.concentration ? `${p.concentration.topSupplierPercent}%` : '—'}
          sub={p.topSuppliers[0]?.party ?? 'nothing bought yet'}
          warn={Boolean(p.concentration?.warning)} />
        <Kpi label="Top five suppliers"
          value={p.concentration ? `${p.concentration.topFivePercent}%` : '—'}
          sub="of all buying" />
      </div>
      {p.concentration?.warning && (
        <Card className="mb-6 border-amber-200 bg-amber-50">
          <div className="flex items-start gap-2 text-sm text-amber-900">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{p.concentration.warning} If they raise prices or close, there is
              no second source in your books.</span>
          </div>
        </Card>
      )}

      {/* Inventory */}
      <SectionTitle icon={Package} note="what is sitting there">Stock</SectionTitle>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi label="Stock value" value={inr(i.stockValuePaise)} sub={`${i.items} items`} />
        <Kpi label="Turns"
          value={i.turnsBySalesValue === null ? '—' : `${i.turnsBySalesValue}×`}
          sub="by sales value" />
        <Kpi label="Dead stock" value={inr(i.deadStock.valuePaise)}
          sub={`${i.deadStock.count} items, ${i.deadStock.sharePercent}% of stock`}
          warn={i.deadStock.count > 0} />
        <Kpi label="Low stock" value={String(i.lowStock)} sub="at or below reorder level"
          warn={i.lowStock > 0} />
        <Kpi label="Negative" value={String(i.negativeStock.count)}
          sub={i.negativeStock.count ? 'needs fixing in Tally' : 'none'}
          warn={i.negativeStock.count > 0} />
      </div>
      <Note>{i.turnoverNote}</Note>
      {i.negativeStock.note && <Note>{i.negativeStock.note}</Note>}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle icon={TrendingUp}>Fast moving</SectionTitle>
          <Ranked rows={i.fastMoving.map((x) => ({
            label: x.item, value: inr(x.amountPaise), share: 0,
            sub: `${x.qty.toLocaleString('en-IN')} sold` }))} />
        </Card>
        <Card>
          <SectionTitle icon={TrendingDown} note={i.deadStock.note}>Not selling</SectionTitle>
          {i.deadStock.items.length === 0
            ? <p className="text-sm text-muted">Everything on the shelf sold at least once.</p>
            : <Ranked rows={i.deadStock.items.map((x) => ({
                label: x.item, value: inr(x.valuePaise), share: 0,
                sub: `${x.qty.toLocaleString('en-IN')} in stock` }))} />}
        </Card>
      </div>

      {/* Profit */}
      <SectionTitle icon={PieChart} note="what is left">Profitability</SectionTitle>
      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Gross profit" value={inr(pr.grossProfitPaise)}
          sub={pr.grossMarginPercent === null ? '—' : `${pr.grossMarginPercent}% margin`} />
        <Kpi label="Net profit" value={inr(pr.netProfitPaise)}
          sub={pr.netMarginPercent === null ? '—' : `${pr.netMarginPercent}% margin`}
          warn={pr.netProfitPaise < 0} />
        <Kpi label="Expenses" value={inr(pr.directExpensesPaise + pr.indirectExpensesPaise)}
          sub={pr.expenseRatioPercent === null ? '—' : `${pr.expenseRatioPercent}% of sales`} />
        <Kpi label="Other income" value={inr(pr.otherIncomePaise)} />
      </div>
      <Note>{pr.basis}</Note>
      </Settling>
    </>
  );
}

function Kpi({ label, value, sub, delta, warn }: {
  label: string; value: string; sub?: string; delta?: number | null; warn?: boolean;
}) {
  return (
    <Card className={warn ? 'border-amber-200' : ''}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className={`figure mt-1.5 text-[26px] font-bold leading-none ${
        warn ? 'text-amber-700' : ''}`}>
        {value}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        {delta !== undefined && delta !== null && (
          <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${
            delta >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
            {delta >= 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            {Math.abs(delta)}%
          </span>
        )}
        {sub && <span className="text-xs text-faint">{sub}</span>}
      </div>
    </Card>
  );
}

function Ranked({ rows }: {
  rows: { label: string; value: string; share: number; sub: string }[];
}) {
  if (!rows.length) return <p className="text-sm text-muted">Nothing yet.</p>;
  const top = Math.max(...rows.map((r) => r.share), 1);
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate text-ink">{r.label}</span>
            <span className="shrink-0 font-medium text-ink">{r.value}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            {r.share > 0 && (
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-brand-500"
                  style={{ width: `${Math.max(2, (r.share / top) * 100)}%` }} />
              </div>
            )}
            <span className="text-[11px] text-faint">{r.sub}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** A caveat that belongs next to the number, not in a footnote nobody reads. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-6 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                  text-xs text-slate-500">
      <Info size={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
