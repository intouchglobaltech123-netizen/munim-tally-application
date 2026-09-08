'use client';

import { useApi } from '../../../lib/useApi';
import { ago, type AdminMetrics } from '../../../lib/api';
import {
  Badge, Card, CountTile, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../../components/ui';
import {
  TrendingUp, Server, Activity, Gauge, Database, Cpu, AlertTriangle, Zap,
} from 'lucide-react';

/**
 * How the business and the box are doing.
 *
 * Three groups because they answer to three different people: money to whoever
 * decides what to build, health to whoever is on call, usage to both.
 */
export default function AdminMetricsPage() {
  const m = useApi<AdminMetrics>('/v1/admin/metrics', []);

  if (m.error) return <ErrorNote message={m.error} onRetry={m.reload} />;
  if (!m.data) return <Spinner label="Counting everything…" />;

  const { business: b, technical: t, feature: f } = m.data;
  const hot = t.api.errorRate > 1 || t.api.p95Ms > 2000 || t.connectors.onlinePercent < 50;

  return (
    <>
      <PageTitle title="Metrics"
        subtitle={`Everything, as of ${ago(m.data.at)}.`}
        right={<Badge tone={hot ? 'bad' : 'ok'}>{hot ? 'Needs a look' : 'Healthy'}</Badge>} />

      <SectionTitle icon={TrendingUp} note="what the business is worth">Revenue</SectionTitle>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="MRR" value={b.revenue.mrrLabel} />
        <Figure label="ARR" value={b.revenue.arrLabel} />
        <Figure label="ARPU" value={b.revenue.arpuLabel} sub="per paying account" />
        <Figure label="LTV" value={b.revenue.ltvLabel}
          sub={b.revenue.ltvPaise === null ? 'needs real churn to compute' : 'ARPU ÷ churn'} />
      </div>

      <SectionTitle icon={Activity} note={b.activeDefinition}>Customers</SectionTitle>
      <div className="mb-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <CountTile label="Accounts" value={n(b.accounts.total)} />
        <CountTile label="Paying" value={n(b.accounts.paid)} />
        <CountTile label="On trial" value={n(b.accounts.trial)} />
        <CountTile label="New (30d)" value={n(b.accounts.new30d)} />
        <CountTile label="Companies" value={n(b.companies.total)}
          sub={`${b.companies.active} syncing`} />
        <CountTile label="Closing" value={n(b.accounts.closing)} />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CountTile label="Daily actives" value={n(b.users.dau)} />
        <CountTile label="Monthly actives" value={n(b.users.mau)}
          sub={`${b.users.stickiness}% come back daily`} />
        <Figure label="Conversion" value={`${b.health.conversionPercent}%`}
          sub="trial → paid" />
        <Figure label="Churn" value={`${b.health.churnPercent}%`}
          sub={`${b.health.cancelled30d} cancelled in 30d`}
          tone={b.health.churnPercent > 5 ? 'bad' : 'ok'} />
      </div>

      <SectionTitle icon={Server} note="the fleet">Connectors & sync</SectionTitle>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <CountTile label="Connectors" value={n(t.connectors.total)} />
        <Figure label="Online" value={`${t.connectors.onlinePercent}%`}
          sub={`${t.connectors.online} of ${t.connectors.total}`}
          tone={t.connectors.onlinePercent < 50 ? 'bad' : 'ok'} />
        <CountTile label="Tally down" value={n(t.connectors.tallyDown)} />
        <CountTile label="Queued batches" value={n(t.connectors.queueDepth)} />
        <Figure label="Sync success" value={`${t.sync.successPercent}%`}
          sub={`${t.sync.runs24h} runs, avg ${t.sync.averageMs}ms`}
          tone={t.sync.successPercent < 95 ? 'bad' : 'ok'} />
      </div>

      <SectionTitle icon={Gauge}
        note={`last ${t.api.windowMinutes} minutes, ${t.api.samples} requests`}>
        API
      </SectionTitle>
      <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Figure label="Median" value={`${t.api.p50Ms}ms`} />
        <Figure label="p95" value={`${t.api.p95Ms}ms`}
          tone={t.api.p95Ms > 2000 ? 'bad' : 'ok'} />
        <Figure label="p99" value={`${t.api.p99Ms}ms`} />
        <Figure label="Slowest" value={`${t.api.maxMs}ms`} />
        <Figure label="Errors" value={`${t.api.errorRate}%`}
          sub={`${t.api.errors} of ${t.api.samples}`}
          tone={t.api.errorRate > 1 ? 'bad' : 'ok'} />
        <CountTile label="Rate limited" value={n(t.api.lifetime.rateLimited)} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle icon={Zap}>Slowest routes</SectionTitle>
          <RouteTable rows={t.api.slowest} sortLabel="avg" />
        </Card>
        <Card>
          <SectionTitle icon={Activity}>Busiest routes</SectionTitle>
          <RouteTable rows={t.api.busiest} sortLabel="calls" />
        </Card>
      </div>

      <SectionTitle icon={Cpu} note="this server">Machine</SectionTitle>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Figure label="Load" value={`${t.system.loadPercent}%`}
          sub={`${t.system.load.one} over ${t.system.cores} cores`}
          tone={t.system.loadPercent > 90 ? 'bad' : 'ok'} />
        <Figure label="Memory" value={`${t.system.memory.rssMb}MB`}
          sub={`heap ${t.system.memory.heapUsedMb}/${t.system.memory.heapTotalMb}MB`} />
        <Figure label="System RAM" value={`${t.system.memory.systemUsedPercent}%`}
          sub={`${t.system.memory.systemFreeMb}MB free`} />
        <Figure label="Database" value={`${t.database.latencyMs}ms`}
          sub={`${t.database.sizeMb}MB, ${t.database.vouchers.toLocaleString('en-IN')} vouchers`} />
        <Figure label="Uptime"
          value={`${Math.floor(t.system.uptimeSeconds / 3600)}h`}
          sub={t.system.nodeVersion} />
      </div>

      <SectionTitle icon={Database} note="last 7 days">Backups</SectionTitle>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Success" value={`${t.backups.successPercent}%`}
          sub={`${t.backups.ok7d} ok, ${t.backups.failed7d} failed`}
          tone={t.backups.failed7d > 0 ? 'bad' : 'ok'} />
        <Figure label="Stored" value={`${t.backups.storedMb}MB`} />
        <Figure label="Encrypted at rest" value={t.backups.encrypted ? 'Yes' : 'NO'}
          tone={t.backups.encrypted ? 'ok' : 'bad'} />
        <CountTile label="Restores (30d)" value={n(f.data.restores)} />
      </div>

      <SectionTitle icon={Activity} note={f.window}>What people use</SectionTitle>
      <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <CountTile label="Vouchers synced" value={n(f.accounting.vouchersSynced)} />
        <CountTile label="Invoices" value={n(f.accounting.invoices)} />
        <CountTile label="Reminders" value={n(f.messaging.reminders)} />
        <CountTile label="WhatsApp" value={n(f.messaging.whatsapp)} />
        <CountTile label="Shares" value={n(f.messaging.shares)} />
        <CountTile label="Prints / PDFs" value={n(f.documents.pdfsAndPrints)} />
      </div>
      <div className="mb-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <CountTile label="CSV exports" value={n(f.documents.csvExports)} />
        <CountTile label="Backups" value={n(f.data.backups)} />
        <CountTile label="Saved views" value={n(f.data.savedViews)} />
        <CountTile label="Pinned reports" value={n(f.data.pinnedReports)} />
        <CountTile label="E-Invoices" value={n(f.compliance.eInvoices)} />
        <CountTile label="E-Way Bills" value={n(f.compliance.eWayBills)} />
      </div>

      <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        {f.compliance.note} API and machine figures are held in memory and reset when
        the server restarts; everything else comes from the database.
      </p>
    </>
  );
}

/** A count, grouped the Indian way. 12,34,567 rather than 1,234,567. */
const n = (v: number) => v.toLocaleString('en-IN');

function Figure({ label, value, sub, tone = 'ok' }: {
  label: string; value: string; sub?: string; tone?: 'ok' | 'bad';
}) {
  return (
    <Card>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tone === 'bad' ? 'text-rose-600' : 'text-ink'}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </Card>
  );
}

function RouteTable({ rows, sortLabel }: {
  rows: { route: string; calls: number; avgMs: number; maxMs: number; errors: number }[];
  sortLabel: string;
}) {
  if (!rows.length) return <p className="text-sm text-muted">No traffic yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase
                         tracking-wide text-slate-400">
            <th className="pb-2 pr-3 font-semibold">Route</th>
            <th className="pb-2 pr-3 text-right font-semibold">Calls</th>
            <th className="pb-2 pr-3 text-right font-semibold">Avg</th>
            <th className="pb-2 text-right font-semibold">Max</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.route} className="border-b border-slate-50 last:border-0">
              <td className="py-2 pr-3 font-mono text-[11px] text-slate-700">{r.route}</td>
              <td className="py-2 pr-3 text-right text-muted">{r.calls}</td>
              <td className="py-2 pr-3 text-right text-ink">{r.avgMs}ms</td>
              <td className={`py-2 text-right ${r.maxMs > 2000 ? 'text-rose-600' : 'text-muted'}`}>
                {r.maxMs}ms
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
