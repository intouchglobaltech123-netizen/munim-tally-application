'use client';

import Link from 'next/link';
import { useApi } from '../../lib/useApi';
import { ago } from '../../lib/api';
import {
  Card, PageTitle, SectionTitle, CountTile, Badge, Spinner, ErrorNote, Empty,
} from '../../components/ui';

type Stats = {
  orgs: number; users: number; companies: number; vouchers: number;
  connectors: number; connectorsHealthy: number; records: number;
  batches: number; remindersSent: number; credits: number;
};

type Conn = {
  id: string; machine: string; orgName: string; status: string;
  lastSeenAt: string; tallyUp?: boolean; tallyVersion: string; appVersion: string;
};

export default function AdminHome() {
  const stats = useApi<Stats>('/v1/admin/stats');
  const conns = useApi<{ connectors: Conn[] }>('/v1/admin/connectors');

  if (stats.error) return <ErrorNote message={stats.error} onRetry={stats.reload} />;
  if (stats.loading || !stats.data) return <Spinner />;

  const s = stats.data;
  const unhealthy = (conns.data?.connectors ?? []).filter((c) => c.status !== 'ok');

  return (
    <>
      <PageTitle title="Platform overview"
        subtitle="Every business, connector and message across Munim." />

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <CountTile label="Businesses" value={s.orgs.toLocaleString('en-IN')} sub={`${s.users} users`} />
        <CountTile label="Connectors" value={`${s.connectorsHealthy}/${s.connectors}`} sub="healthy / total" />
        <CountTile label="Companies synced" value={s.companies.toLocaleString('en-IN')}
          sub={`${s.vouchers.toLocaleString('en-IN')} vouchers`} />
        <CountTile label="Reminders sent" value={s.remindersSent.toLocaleString('en-IN')}
          sub={`${s.credits.toLocaleString('en-IN')} credits outstanding`} />
      </div>

      {/* Connector health is the business metric that matters most: a silently
          broken sync looks like a dead product and churns without a ticket. */}
      <SectionTitle note="the metric that predicts churn">Connectors needing attention</SectionTitle>
      {conns.loading ? <Spinner />
        : unhealthy.length === 0
          ? <Empty title="All connectors healthy" hint="Every paired Tally machine reported in recently." />
          : (
            <div className="mb-8 grid gap-3">
              {unhealthy.map((c) => (
                <Card key={c.id} className="border-amber-200 bg-amber-50">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold">{c.orgName}</p>
                      <p className="text-xs text-body">{c.machine} · last seen {ago(c.lastSeenAt)}</p>
                    </div>
                    <Badge tone="warn">{c.status}</Badge>
                  </div>
                </Card>
              ))}
            </div>
          )}

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Link href="/admin/orgs">
          <Card className="transition hover:border-faint">
            <p className="font-semibold">Businesses →</p>
            <p className="mt-1 text-sm text-muted">Accounts, plans, trials and usage.</p>
          </Card>
        </Link>
        <Link href="/admin/connectors">
          <Card className="transition hover:border-faint">
            <p className="font-semibold">Connector fleet →</p>
            <p className="mt-1 text-sm text-muted">Every machine, version and heartbeat.</p>
          </Card>
        </Link>
      </div>

      <p className="mt-8 text-xs text-faint">
        Ingest: {s.records.toLocaleString('en-IN')} records in {s.batches.toLocaleString('en-IN')} batches.
      </p>
    </>
  );
}
