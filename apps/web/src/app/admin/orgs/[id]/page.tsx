'use client';

import { use } from 'react';
import Link from 'next/link';
import { useApi } from '../../../../lib/useApi';
import { ago, shortDate } from '../../../../lib/api';
import {
  Badge, Card, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../../../components/ui';
import {
  ArrowLeft, Server, Building2, Users2, CreditCard, RefreshCw, AlertTriangle, Gauge,
} from 'lucide-react';

type Customer = {
  account: {
    id: string; name: string; plan: string; planLabel: string;
    createdAt: string; trialEndsAt: string | null; messageCredits: number;
    notes: string; closingAt: string | null;
    billing: { name: string; gstin: string; state: string };
  };
  headline: {
    connectorOnline: boolean; connectors: string; lastSync: string | null;
    atLimit: string[]; lastPaymentFailed: string | null;
  };
  usage: { key: string; label: string; summary: string; over: boolean;
           unlimited: boolean; pct: number }[];
  companies: { guid: string; name: string; enabled: boolean;
               lastSyncAt: string | null; vouchers: number }[];
  people: { id: string; name: string; email: string; role: string;
            status: string; last_seen_at: string | null }[];
  connectors: { id: string; machine_name: string; status: string; tally_up: boolean;
                tally_version: string; app_version: string; last_seen_at: string | null;
                revoked_at: string | null; queued_batches: number }[];
  subscriptions: { id: string; plan: string; status: string; term: string;
                   price_paise: string; current_until: string }[];
  payments: { id: string; status: string; totalLabel: string;
              failure_reason: string; created_at: string }[];
  recentSyncs: { ok: boolean; duration_ms: number; started_at: string;
                 error: string; error_kind: string }[];
};

/**
 * One customer, for answering their support call.
 *
 * Ordered by what the call is actually about: is their connector up, when did
 * it last sync, are they blocked by a limit, did their payment fail. Everything
 * else is below that.
 */
export default function AdminCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const c = useApi<Customer>(`/v1/admin/orgs/${id}`, [id]);

  if (c.error) return <ErrorNote message={c.error} onRetry={c.reload} />;
  if (!c.data) return <Spinner label="Loading the account…" />;
  const d = c.data;

  return (
    <>
      <Link href="/admin/orgs"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold
                   text-muted hover:text-ink">
        <ArrowLeft size={15} /> All businesses
      </Link>

      <PageTitle title={d.account.name || 'Unnamed business'}
        subtitle={`${d.account.planLabel} · joined ${shortDate(d.account.createdAt)}`}
        right={d.account.closingAt
          ? <Badge tone="bad">Closing {shortDate(d.account.closingAt)}</Badge>
          : <Badge tone="ok">{d.account.planLabel}</Badge>} />

      {/* What the call is about. */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Connector"
          value={d.headline.connectorOnline ? 'Online' : 'Offline'}
          sub={d.headline.connectors}
          bad={!d.headline.connectorOnline} />
        <Tile label="Last sync"
          value={d.headline.lastSync ? ago(d.headline.lastSync) : 'Never'}
          bad={!d.headline.lastSync} />
        <Tile label="At limit"
          value={d.headline.atLimit.length ? d.headline.atLimit.join(', ') : 'No'}
          bad={d.headline.atLimit.length > 0} />
        <Tile label="Last payment"
          value={d.headline.lastPaymentFailed ? 'Failed' : 'Fine'}
          sub={d.headline.lastPaymentFailed ?? ''}
          bad={Boolean(d.headline.lastPaymentFailed)} />
      </div>

      <SectionTitle icon={Gauge}>Usage against their plan</SectionTitle>
      <Card className="mb-6">
        {d.usage.map((u) => (
          <div key={u.key} className="flex items-center justify-between border-b border-slate-50
                                      py-2 text-sm last:border-0">
            <span className="text-muted">{u.label}</span>
            <span className={u.over ? 'font-medium text-rose-700' : 'text-ink'}>
              {u.summary}
            </span>
          </div>
        ))}
      </Card>

      <SectionTitle icon={Building2} note={`${d.companies.length} books`}>Companies</SectionTitle>
      <Card className="mb-6">
        {d.companies.length === 0 ? <p className="text-sm text-muted">Nothing synced yet.</p>
          : d.companies.map((co) => (
            <div key={co.guid} className="flex items-center justify-between border-b
                                          border-slate-50 py-2 text-sm last:border-0">
              <div>
                <div className="text-ink">{co.name}</div>
                <div className="text-xs text-muted">
                  {co.vouchers.toLocaleString('en-IN')} vouchers
                </div>
              </div>
              <span className="text-xs text-muted">
                {co.lastSyncAt ? ago(co.lastSyncAt) : 'never synced'}
              </span>
            </div>
          ))}
      </Card>

      <SectionTitle icon={Server}>Connectors</SectionTitle>
      <Card className="mb-6">
        {d.connectors.length === 0 ? <p className="text-sm text-muted">None paired.</p>
          : d.connectors.map((k) => (
            <div key={k.id} className="flex items-center justify-between border-b
                                       border-slate-50 py-2 text-sm last:border-0">
              <div>
                <div className="text-ink">{k.machine_name}</div>
                <div className="text-xs text-muted">
                  {k.tally_version === 'erp9' ? 'Tally ERP 9' : 'Tally Prime'}
                  {k.app_version ? ` · v${k.app_version}` : ''}
                  {k.queued_batches > 0 ? ` · ${k.queued_batches} queued` : ''}
                </div>
              </div>
              <Badge tone={k.revoked_at ? 'muted' : k.tally_up ? 'ok' : 'bad'}>
                {k.revoked_at ? 'Unlinked' : k.tally_up ? 'Tally up' : 'Tally down'}
              </Badge>
            </div>
          ))}
      </Card>

      <SectionTitle icon={RefreshCw} note="last ten">Recent syncs</SectionTitle>
      <Card className="mb-6">
        {d.recentSyncs.length === 0 ? <p className="text-sm text-muted">No runs recorded.</p>
          : d.recentSyncs.map((r, i) => (
            <div key={i} className="flex items-center justify-between border-b border-slate-50
                                    py-2 text-sm last:border-0">
              <span className="text-muted">{ago(r.started_at)}</span>
              <span className="flex items-center gap-2">
                {r.error && <span className="text-xs text-rose-600">{r.error}</span>}
                <span className="text-xs text-muted">{r.duration_ms}ms</span>
                <Badge tone={r.ok ? 'ok' : 'bad'}>{r.ok ? 'ok' : r.error_kind || 'failed'}</Badge>
              </span>
            </div>
          ))}
      </Card>

      <SectionTitle icon={Users2}>People</SectionTitle>
      <Card className="mb-6">
        {d.people.map((p) => (
          <div key={p.id} className="flex items-center justify-between border-b border-slate-50
                                     py-2 text-sm last:border-0">
            <div>
              <div className="text-ink">{p.name || p.email}</div>
              <div className="text-xs text-muted">{p.email}</div>
            </div>
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted">
                {p.last_seen_at ? ago(p.last_seen_at) : 'never signed in'}
              </span>
              <Badge tone={p.status === 'disabled' ? 'muted' : 'ok'}>{p.role}</Badge>
            </span>
          </div>
        ))}
      </Card>

      <SectionTitle icon={CreditCard}>Payments</SectionTitle>
      <Card>
        {d.payments.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p>
          : d.payments.map((p) => (
            <div key={p.id} className="flex items-center justify-between border-b border-slate-50
                                       py-2 text-sm last:border-0">
              <div>
                <div className="text-ink">{p.totalLabel}</div>
                <div className="text-xs text-muted">{shortDate(p.created_at)}</div>
              </div>
              <span className="flex items-center gap-2">
                {p.failure_reason && (
                  <span className="text-xs text-rose-600">{p.failure_reason}</span>
                )}
                <Badge tone={p.status === 'paid' ? 'ok' : p.status === 'failed' ? 'bad' : 'warn'}>
                  {p.status}
                </Badge>
              </span>
            </div>
          ))}
      </Card>
    </>
  );
}

function Tile({ label, value, sub, bad }: {
  label: string; value: string; sub?: string; bad?: boolean;
}) {
  return (
    <Card className={bad ? 'border-rose-200 bg-rose-50' : ''}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-lg font-bold ${bad ? 'text-rose-700' : 'text-ink'}`}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-xs text-muted">{sub}</div> : null}
    </Card>
  );
}
