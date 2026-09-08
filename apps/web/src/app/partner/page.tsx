'use client';

import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { post, patch, del, ago, shortDate, type PartnerDashboard } from '../../lib/api';
import {
  Badge, Button, Card, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  Handshake, Users2, Wallet, Copy, Check, Plus, Trash2, TrendingUp, Info,
} from 'lucide-react';

/**
 * The dealer's own screen.
 *
 * Tally is sold through a dealer network in India, and a channel that cannot
 * see what it has sold and what it is owed stops selling. So this is a real
 * dashboard — leads, customers, and four separate money figures — rather than a
 * form that emails somebody.
 */
export default function PartnerPage() {
  const p = useApi<PartnerDashboard>('/v1/partner', []);

  const [form, setForm] = useState({ name: '', email: '', phone: '', city: '', gstin: '' });
  const [lead, setLead] = useState({ business: '', contactName: '', phone: '', city: '' });
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); p.reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not do that.'); }
    finally { setBusy(false); }
  }

  if (p.error) return <ErrorNote message={p.error} onRetry={p.reload} />;
  if (!p.data) return <Spinner />;
  const d = p.data;

  // Not a partner yet: the pitch and the form, nothing else.
  if (!d.partner) {
    return (
      <>
        <PageTitle title="Partner programme"
          subtitle="Sell Munim to the businesses whose Tally you already look after." />
        {err && (
          <div className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</div>
        )}
        {said && (
          <Card className="mb-6 border-emerald-300 bg-emerald-50">
            <p className="text-sm text-emerald-900">{said}</p>
          </Card>
        )}

        <Card className="mb-6">
          <SectionTitle icon={Handshake}>How it works</SectionTitle>
          <ul className="space-y-2 text-sm text-slate-700">
            <li>• You get a referral code and a link.</li>
            <li>• Anybody who signs up through it is yours, permanently.</li>
            <li>• You earn a share of everything they pay — not once, but for as
              long as they keep paying.</li>
            <li>• You see their plan, what they have paid and what you are owed,
              on this screen.</li>
          </ul>
        </Card>

        <Card>
          <SectionTitle icon={Plus}>Apply</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Your business name" value={form.name}
              onChange={(v) => setForm({ ...form, name: v })} />
            <Field label="Email" value={form.email}
              onChange={(v) => setForm({ ...form, email: v })} />
            <Field label="Phone" value={form.phone}
              onChange={(v) => setForm({ ...form, phone: v })} />
            <Field label="City" value={form.city}
              onChange={(v) => setForm({ ...form, city: v })} />
            <Field label="GSTIN (optional)" value={form.gstin}
              onChange={(v) => setForm({ ...form, gstin: v.toUpperCase() })} />
          </div>
          <div className="mt-4">
            <Button disabled={busy || !form.name || !form.email}
              onClick={() => run(async () => {
                const r = await post<{ message: string }>('/v1/partner/apply', form);
                setSaid(r.message);
              })}>
              Apply
            </Button>
          </div>
        </Card>
      </>
    );
  }

  // Applied, not yet approved.
  if (!d.summary) {
    return (
      <>
        <PageTitle title="Partner programme" subtitle={d.partner.name} />
        <Card>
          <div className="flex items-center gap-2">
            <Badge tone="warn">{d.partner.status}</Badge>
            <span className="text-sm text-muted">{d.message}</span>
          </div>
          <p className="mt-3 text-sm text-ink">
            Your referral code is <code className="font-mono">{d.partner.code}</code>.
          </p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageTitle title={d.partner.name}
        subtitle={d.partner.commissionNote}
        right={<Badge tone="ok">Active partner</Badge>} />

      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</div>
      )}

      <Card className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">
              Your referral link
            </div>
            <code className="text-sm text-slate-700">{d.partner.referralLink}</code>
          </div>
          <Button variant="ghost" icon={copied ? Check : Copy}
            onClick={async () => {
              await navigator.clipboard.writeText(d.partner!.referralLink ?? '');
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </Card>

      <SectionTitle icon={Wallet} note="what you are owed, and what has arrived">
        Commission
      </SectionTitle>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Earned, not yet approved" value={d.summary.pendingLabel} />
        <Figure label="Approved, due to you" value={d.summary.approvedLabel} strong />
        <Figure label="Paid to date" value={d.summary.paidLabel} />
        <Figure label="Customers"
          value={`${d.summary.payingCustomers} of ${d.summary.customers}`}
          sub="paying" />
      </div>

      <SectionTitle icon={Users2}>Your customers</SectionTitle>
      <Card className="mb-6">
        {(d.customers ?? []).length === 0 ? (
          <p className="text-sm text-muted">Nobody yet. Share your link.</p>
        ) : (d.customers ?? []).map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-3 border-b
                                     border-slate-50 py-2.5 last:border-0">
            <div className="min-w-[160px] flex-1">
              <div className="text-sm font-medium text-ink">{c.name}</div>
              <div className="text-xs text-muted">
                {c.plan} · introduced {shortDate(c.introducedAt)}
              </div>
            </div>
            <span className="text-sm text-ink">{c.paidLabel}</span>
            <Badge tone={['active', 'grace'].includes(c.subscription) ? 'ok'
              : c.subscription === 'none' ? 'muted' : 'warn'}>
              {c.subscription}
            </Badge>
          </div>
        ))}
      </Card>

      <SectionTitle icon={TrendingUp} note="who you are still working on">Leads</SectionTitle>
      <Card className="mb-6">
        {(d.leads ?? []).map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-3 border-b
                                     border-slate-50 py-2.5 last:border-0">
            <div className="min-w-[160px] flex-1">
              <div className="text-sm font-medium text-ink">{l.business}</div>
              <div className="text-xs text-muted">
                {[l.contact_name, l.phone, l.city].filter(Boolean).join(' · ')}
              </div>
            </div>
            <select value={l.status}
              onChange={(e) => run(() =>
                patch(`/v1/partner/leads/${l.id}`, { status: e.target.value }))}
              className="rounded-lg border border-line px-2 py-1 text-xs">
              {['new', 'contacted', 'demo', 'trial', 'won', 'lost'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button onClick={() => run(() => del(`/v1/partner/leads/${l.id}`))}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100">
              <Trash2 size={14} />
            </button>
          </div>
        ))}

        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <input value={lead.business} onChange={(e) => setLead({ ...lead, business: e.target.value })}
            placeholder="Business name"
            className="rounded-lg border border-line px-3 py-2 text-sm" />
          <input value={lead.contactName}
            onChange={(e) => setLead({ ...lead, contactName: e.target.value })}
            placeholder="Contact"
            className="rounded-lg border border-line px-3 py-2 text-sm" />
          <input value={lead.phone} onChange={(e) => setLead({ ...lead, phone: e.target.value })}
            placeholder="Phone"
            className="rounded-lg border border-line px-3 py-2 text-sm" />
          <Button icon={Plus} disabled={busy || !lead.business}
            onClick={() => run(async () => {
              await post('/v1/partner/leads', lead);
              setLead({ business: '', contactName: '', phone: '', city: '' });
            })}>
            Add lead
          </Button>
        </div>
      </Card>

      <SectionTitle icon={Wallet}>Commission history</SectionTitle>
      <Card className="mb-6">
        {(d.commissions ?? []).length === 0 ? (
          <p className="text-sm text-muted">Nothing earned yet.</p>
        ) : (d.commissions ?? []).map((c) => (
          <div key={c.id} className="flex items-center gap-3 border-b border-slate-50
                                     py-2 text-sm last:border-0">
            <span className="flex-1 text-ink">{c.customer}</span>
            <span className="text-xs text-muted">{c.ratePercent}%</span>
            <span className="font-medium text-ink">{c.amountLabel}</span>
            <Badge tone={c.status === 'paid' ? 'ok'
              : c.status === 'reversed' ? 'bad' : 'warn'}>{c.status}</Badge>
            <span className="text-xs text-faint">{ago(c.earnedAt)}</span>
          </div>
        ))}
      </Card>

      <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs
                    text-slate-500">
        <Info size={13} className="mt-0.5 shrink-0" />
        Commission is a share of what a customer actually pays, before GST — tax
        collected is passed to the government, not kept, so it is not shared.
        A refunded payment reverses its commission line rather than deleting it,
        so a figure never changes without a reason you can see.
      </p>
    </>
  );
}

function Figure({ label, value, sub, strong }: {
  label: string; value: string; sub?: string; strong?: boolean;
}) {
  return (
    <Card className={strong ? 'border-brand-300' : ''}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className={`figure mt-1 text-2xl font-bold ${strong ? 'text-brand-700' : ''}`}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-faint">{sub}</div>}
    </Card>
  );
}

function Field({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </span>
      <input value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line px-3 py-2 text-sm" />
    </label>
  );
}
