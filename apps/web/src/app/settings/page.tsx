'use client';

import Link from 'next/link';

import { useState } from 'react';
import {
  UserRound, Building2, CreditCard, PlugZap, ShieldCheck, Sparkles,
  Database, MonitorSmartphone, ChevronRight, Check, X,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { post, ago, shortDate, type Connector } from '../../lib/api';
import {
  Card, PageTitle, SectionTitle, Badge, Spinner, ErrorNote, Empty, Button, OfflineBar,
} from '../../components/ui';

export default function SettingsPage() {
  const { me, refresh } = useAuth();
  const { data, error, loading, reload, stale, offline } = useApi<{ connectors: Connector[] }>('/v1/connectors');
  const [orgName, setOrgName] = useState('');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    try {
      await post('/v1/onboarding', { businessName: orgName });
      await refresh();
      setOrgName('');
    } finally { setSaving(false); }
  }

  // Turning a book off takes effect on the connector's next heartbeat. Nobody
  // has to go back to the shop computer.
  async function toggleSync(tallyGuid: string, enabled: boolean) {
    setToggling(tallyGuid);
    try {
      await post('/v1/companies/sync', { tallyGuid, enabled });
      await refresh();
    } finally { setToggling(null); }
  }

  const [tab, setTab] = useState<'profile' | 'business' | 'plan' | 'tally'>('profile');

  if (!me) return <Spinner />;

  /*
   * Tabs, not one long page.
   *
   * Settings is where everything lands that has nowhere else to go, and this
   * one already holds an account, a business name, plan and credits, the Tally
   * books, and the connected computers - with more to come. As a single column
   * it becomes a page nobody reads to the bottom of.
   *
   * Grouped by the question being asked rather than by the shape of the data:
   * "who am I", "what am I paying for", "what is connected".
   */
  const TABS = [
    { id: 'profile', label: 'Profile', icon: UserRound },
    { id: 'business', label: 'Business', icon: Building2 },
    { id: 'plan', label: 'Plan & usage', icon: CreditCard },
    { id: 'tally', label: 'Tally & books', icon: PlugZap },
  ] as const;

  return (
    <>
      <PageTitle title="Settings" subtitle="Your account, plan and connected Tally computers." />
      <OfflineBar offline={offline} ageMs={stale} />

      <div className="mb-6 flex flex-wrap gap-1.5 border-b border-line pb-3">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm
                          font-semibold transition ${
                tab === t.id
                  ? 'bg-brand-700 text-white'
                  : 'text-muted hover:bg-line-soft hover:text-ink'}`}>
              <Icon size={14} strokeWidth={2.2} />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'profile' ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <SectionTitle icon={UserRound}>You</SectionTitle>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
              <dt className="text-muted">Name</dt>
              <dd className="font-medium">{me.user.name || <span className="text-faint">not set</span>}</dd>
              <dt className="text-muted">Email</dt>
              <dd className="font-medium break-all">{me.user.email || <span className="text-faint">—</span>}</dd>
              <dt className="text-muted">Mobile</dt>
              <dd className="font-medium">{me.user.phone || <span className="text-faint">—</span>}</dd>
              <dt className="text-muted">Role</dt>
              <dd className="font-medium capitalize">{me.user.role.replace('_', ' ')}</dd>
            </dl>
            <p className="mt-5 border-t border-line-soft pt-4 text-xs text-muted">
              You signed in with Google, so your name and email come from that
              account. Change them there and they update here.
            </p>
          </Card>

          <Card>
            <SectionTitle icon={ShieldCheck}>Signed-in devices</SectionTitle>
            <p className="text-sm text-body">
              Every phone and computer signed in to this account, and a way to
              cut off one you no longer have.
            </p>
            <div className="mt-4">
              <Link href="/devices"
                className="inline-flex items-center gap-1.5 rounded-xl border border-line
                           px-4 py-2.5 text-sm font-semibold transition hover:bg-canvas">
                Manage devices <ChevronRight size={14} strokeWidth={2.5} />
              </Link>
            </div>
            <p className="mt-4 text-xs text-muted">
              Signing in on a new phone signs out the old one automatically.
            </p>
          </Card>
        </div>
      ) : null}

      {tab === 'business' ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <SectionTitle icon={Building2}>Business name</SectionTitle>
            <p className="mb-3 text-sm text-muted">
              This is what appears at the top of every screen and on reminders
              you send.
            </p>
            <div className="flex gap-2">
              <input id="orgName" value={orgName} onChange={(e) => setOrgName(e.target.value)}
                placeholder={me.org.name}
                className="flex-1 rounded-xl border border-line px-3 py-2.5 text-sm
                           outline-none focus:border-brand-600" />
              <Button onClick={save} disabled={saving || !orgName.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </Card>

          <Card>
            <SectionTitle icon={Sparkles}>What you can use</SectionTitle>
            <ul className="space-y-1.5 text-sm">
              {Object.entries(me.features ?? {}).map(([key, on]) => (
                <li key={key} className="flex items-center gap-2">
                  {on
                    ? <Check size={14} strokeWidth={2.6} className="shrink-0 text-positive" />
                    : <X size={14} strokeWidth={2.6} className="shrink-0 text-faint" />}
                  <span className={on ? '' : 'text-faint'}>{featureLabel(key)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-muted">
              Want something switched on? Contact Munim.
            </p>
          </Card>
        </div>
      ) : null}

      {tab === 'plan' ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <SectionTitle icon={CreditCard}>Plan</SectionTitle>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
              <dt className="text-muted">Plan</dt>
              <dd className="font-medium capitalize">{me.org.plan}</dd>
              <dt className="text-muted">Message credits</dt>
              <dd className="figure font-medium">{me.org.messageCredits}</dd>
              <dt className="text-muted">Computers</dt>
              <dd className="figure font-medium">
                {me.connectors} of {me.limits?.connectors ?? 1}
              </dd>
              <dt className="text-muted">Books</dt>
              <dd className="figure font-medium">
                {me.companies.length} of {me.limits?.companies ?? 1}
              </dd>
            </dl>
          </Card>

          <Card>
            <SectionTitle icon={Database}>What is in your books</SectionTitle>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
              <dt className="text-muted">Companies</dt>
              <dd className="figure font-medium">{me.companies.length}</dd>
              <dt className="text-muted">Ledgers</dt>
              <dd className="figure font-medium">
                {me.companies.reduce((n, c) => n + (c.ledgers ?? 0), 0).toLocaleString('en-IN')}
              </dd>
              <dt className="text-muted">Vouchers</dt>
              <dd className="figure font-medium">
                {me.companies.reduce((n, c) => n + (c.vouchers ?? 0), 0).toLocaleString('en-IN')}
              </dd>
            </dl>
          </Card>
        </div>
      ) : null}

      {tab !== 'tally' ? null : (
      <>
      <div className="mb-8 grid gap-5 lg:grid-cols-2">
        <Card>
          <SectionTitle icon={PlugZap}>Connect a Tally computer</SectionTitle>
          <p className="text-sm text-body">
            Download a setup file made for your account and double-click it on
            the computer where Tally runs. Nothing to type, and no code to copy.
          </p>
          <div className="mt-4">
            <Link href="/connect"
              className="inline-block rounded-xl bg-brand-700 px-4 py-2.5 text-sm
                         font-semibold text-white transition hover:bg-brand-800">
              Connect your Tally
            </Link>
          </div>
          <p className="mt-4 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-900">
            Munim <b>reads</b> your Tally data. The only thing it writes is a
            voucher you create in Munim and send, and only while writing is
            switched on below. Nothing already in your books is ever changed.
          </p>
        </Card>
      </div>

      <SectionTitle note="changes apply within a minute">Books syncing from Tally</SectionTitle>
      {me.companies.length === 0 ? (
        <Empty title="No books yet"
          hint="Link the computer that runs Tally, and the companies open in it will appear here." />
      ) : (
        <div className="mb-8 grid gap-3">
          {me.companies.map((c) => (
            <Card key={c.tallyGuid}>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-semibold">{c.name}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {c.vouchers.toLocaleString('en-IN')} vouchers ·{' '}
                    {c.ledgers.toLocaleString('en-IN')} ledgers · synced {ago(c.lastSyncAt)}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={c.enabled ? 'ok' : 'muted'}>
                    {c.enabled ? 'Syncing' : 'Paused'}
                  </Badge>
                  <Button variant="ghost" disabled={toggling === c.tallyGuid}
                    onClick={() => toggleSync(c.tallyGuid, !c.enabled)}>
                    {toggling === c.tallyGuid ? 'Saving…' : c.enabled ? 'Stop syncing' : 'Start syncing'}
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <SectionTitle icon={MonitorSmartphone} note="one per Tally computer">
        Connected computers
      </SectionTitle>
      {error ? <ErrorNote message={error} onRetry={reload} />
        : loading || !data ? <Spinner />
        : data.connectors.length === 0
          ? <Empty title="No computer connected" hint="Follow the four steps above to link your Tally." />
          : (
            <div className="grid gap-3">
              {data.connectors.map((c) => (
                <Card key={c.id}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="font-semibold">{c.machine}</p>
                      <dl className="mt-2 grid grid-cols-2 gap-x-8 gap-y-1 text-xs text-muted sm:grid-cols-4">
                        <Field label="Tally" value={c.tallyVersion === 'erp9' ? 'ERP 9' : 'Prime'} />
                        <Field label="Version" value={`v${c.appVersion}`} />
                        <Field label="Paired" value={shortDate(c.pairedAt)} />
                        <Field label="Last seen" value={ago(c.lastSeenAt)} />
                      </dl>
                    </div>
                    <Badge tone={c.status === 'ok' ? 'ok' : 'warn'}>
                      {c.status === 'ok' ? 'Healthy' : c.status}
                    </Badge>
                  </div>
                </Card>
              ))}
            </div>
          )}
      </>
      )}
    </>
  );
}

/** Feature keys are camelCase; nobody wants to read "multiCompany". */
function featureLabel(key: string): string {
  const named: Record<string, string> = {
    dashboard: 'Dashboard',
    outstanding: 'Outstanding & ageing',
    parties: 'Party statements',
    reports: 'Reports',
    statements: 'Day Book, P&L, Balance Sheet',
    stock: 'Stock & items',
    reminders: 'WhatsApp reminders',
    multiCompany: 'Multiple companies',
    export: 'Export to Excel / PDF',
    api: 'API access',
  };
  return named[key] ?? key;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="font-medium text-body">{value}</dd>
    </div>
  );
}
