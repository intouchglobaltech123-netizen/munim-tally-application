'use client';

import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { get, post, inr, shortDate, type Billing, type PlanPreview } from '../../lib/api';
import {
  Badge, Button, Card, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  CreditCard, Check, AlertTriangle, TrendingUp, Receipt, Tag, CheckCircle2, Info,
} from 'lucide-react';

/**
 * What they are on, what they are using, and what else they could buy.
 *
 * Ordered that way on purpose. A customer opens this screen because something
 * was refused or a payment failed, not to browse the price list — so the
 * problem, then the usage that caused it, then the ladder out of it.
 */
export default function BillingPage() {
  const b = useApi<Billing>('/v1/billing', []);
  const [coupon, setCoupon] = useState('');
  const [term, setTerm] = useState<'monthly' | 'yearly'>('monthly');
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function look(plan: string) {
    setErr(null);
    try {
      const q = new URLSearchParams({ plan, term });
      if (coupon.trim()) q.set('coupon', coupon.trim());
      setPreview(await get<PlanPreview>(`/v1/billing/preview?${q}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not price that.');
      setPreview(null);
    }
  }

  async function choose(plan: string) {
    setBusy(plan); setErr(null); setSaid(null);
    try {
      const r = await post<{ message: string }>('/v1/billing/subscribe',
        { plan, term, coupon: coupon.trim() || undefined });
      setSaid(r.message);
      setPreview(null);
      b.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not change the plan.');
    } finally { setBusy(null); }
  }

  async function act(key: string, path: string) {
    setBusy(key); setErr(null); setSaid(null);
    try {
      const r = await post<{ message: string }>(path, {});
      setSaid(r.message);
      b.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not do that.');
    } finally { setBusy(null); }
  }

  if (b.error) return <ErrorNote message={b.error} onRetry={b.reload} />;
  if (!b.data) return <Spinner label="Loading your plan…" />;
  const d = b.data;

  return (
    <>
      <PageTitle title="Plan & billing"
        subtitle="What you are on, what you are using, and what it costs." />

      {said && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2
                        text-sm text-emerald-800">
          <CheckCircle2 size={15} /> {said}
        </div>
      )}
      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2
                        text-sm text-rose-800">
          <AlertTriangle size={15} /> {err}
        </div>
      )}

      {/* The problem first, if there is one. */}
      {d.subscription && ['grace', 'past_due'].includes(d.subscription.status) && (
        <Card className="mb-6 border-amber-200 bg-amber-50">
          <div className="flex items-start gap-2 text-sm text-amber-900">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{d.subscription.message}</span>
          </div>
        </Card>
      )}

      {d.atLimit.length > 0 && (
        <Card className="mb-6 border-amber-200 bg-amber-50">
          <div className="flex items-start gap-2 text-sm text-amber-900">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>
              You are at your limit for {d.atLimit.join(', ').toLowerCase()}.
              Anything new of that kind will be refused until you upgrade.
            </span>
          </div>
        </Card>
      )}

      <Card className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl font-bold text-ink">
                {d.subscription?.planLabel ?? d.plan.label}
              </span>
              {d.trial.trial && (
                <Badge tone={d.trial.expired ? 'bad' : 'warn'}>
                  {d.trial.expired
                    ? 'Trial ended'
                    : `${d.trial.daysLeft} day${d.trial.daysLeft === 1 ? '' : 's'} left`}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted">
              {d.subscription?.message ?? 'No paid plan yet.'}
            </p>
            {d.subscription?.pendingPlanLabel && (
              <p className="mt-1 text-xs text-amber-700">
                Moving to {d.subscription.pendingPlanLabel} at the end of this period.
              </p>
            )}
            {d.subscription?.coupon && (
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-700">
                <Tag size={11} /> {d.subscription.coupon} applied
              </p>
            )}
          </div>

          {d.subscription && (
            <div className="flex gap-2">
              {d.subscription.cancelAtEnd ? (
                <Button onClick={() => act('resume', '/v1/billing/resume')}
                  disabled={busy === 'resume'}>Keep it</Button>
              ) : (
                <Button variant="ghost" onClick={() => act('cancel', '/v1/billing/cancel')}
                  disabled={busy === 'cancel'}>Cancel</Button>
              )}
            </div>
          )}
        </div>
      </Card>

      <SectionTitle icon={TrendingUp} note="counted from your data">Usage</SectionTitle>
      <Card className="mb-6">
        {d.usage.map((u) => (
          <div key={u.key} className="border-b border-slate-50 py-2.5 last:border-0">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="text-ink">{u.label}</span>
              <span className={u.over ? 'font-medium text-rose-700' : 'text-muted'}>
                {u.summary}
              </span>
            </div>
            {!u.unlimited && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${
                    u.over ? 'bg-rose-500' : u.pct >= 80 ? 'bg-amber-500' : 'bg-brand-500'}`}
                  style={{ width: `${Math.max(2, u.pct)}%` }} />
              </div>
            )}
          </div>
        ))}
      </Card>

      <SectionTitle icon={CreditCard} note="prices exclude GST">Plans</SectionTitle>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-line p-0.5">
          {(['monthly', 'yearly'] as const).map((t) => (
            <button key={t} onClick={() => { setTerm(t); setPreview(null); }}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                term === t ? 'bg-ink text-white' : 'text-muted hover:text-ink'}`}>
              {t === 'monthly' ? 'Monthly' : 'Yearly — 2 months free'}
            </button>
          ))}
        </div>
        <input value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())}
          placeholder="Coupon code"
          className="w-40 rounded-lg border border-line px-3 py-2 text-sm uppercase" />
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {d.plans.map((p) => {
          const isCurrent = p.key === (d.subscription?.plan ?? d.plan.key);
          const price = term === 'yearly' ? p.pricePaise * 10 : p.pricePaise;
          return (
            <Card key={p.key}
              className={isCurrent ? 'border-brand-500 ring-1 ring-brand-500' : ''}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-ink">{p.label}</span>
                {isCurrent && <Badge tone="ok">Current</Badge>}
              </div>
              <div className="mt-2 text-2xl font-bold text-ink">
                {p.quoted ? 'Talk to us' : p.pricePaise === 0 ? 'Free' : inr(price)}
                {!p.quoted && p.pricePaise > 0 && (
                  <span className="text-sm font-normal text-muted">
                    /{term === 'yearly' ? 'year' : 'month'}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">{p.blurb}</p>

              <ul className="mt-3 space-y-1 text-xs text-muted">
                <Limit label="companies" v={p.limits.companies} />
                <Limit label="people" v={p.limits.users} />
                <Limit label="Tally computers" v={p.limits.connectors} />
                <Limit label="WhatsApp messages a month" v={p.limits.whatsappPerMonth} />
              </ul>

              {!isCurrent && !p.quoted && p.key !== 'trial' && (
                <div className="mt-4 flex gap-2">
                  <Button variant="ghost" onClick={() => look(p.key)}>What it costs</Button>
                  <Button onClick={() => choose(p.key)} disabled={busy === p.key}>
                    Choose
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {preview && (
        <Card className="mb-6">
          <SectionTitle icon={Receipt}>Before you commit</SectionTitle>
          <p className="mb-3 text-sm text-ink">{preview.message}</p>
          {preview.quote && (
            <dl className="space-y-1 text-sm">
              <Line k="Subtotal" v={inr(preview.quote.subtotalPaise, { decimals: 2 })} />
              {preview.quote.discountPaise > 0 && (
                <Line k={`Discount — ${preview.quote.discountLabel}`}
                  v={`− ${inr(preview.quote.discountPaise, { decimals: 2 })}`} />
              )}
              <Line k={`GST 18% (${preview.quote.taxKind})`}
                v={inr(preview.quote.taxPaise, { decimals: 2 })} />
              <Line k="Total" v={inr(preview.quote.totalPaise, { decimals: 2 })} strong />
              {preview.proration && (
                <p className="pt-2 text-xs text-muted">
                  You are mid-period, so only {preview.proration.daysLeft} days are
                  charged — {inr(preview.proration.duePaise, { decimals: 2 })} today.
                </p>
              )}
            </dl>
          )}
        </Card>
      )}

      <SectionTitle icon={Receipt} note="every payment, successful or not">
        Payment history
      </SectionTitle>
      <Card>
        {d.payments.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase
                             tracking-wide text-slate-400">
                <th className="pb-2 pr-3 font-semibold">Date</th>
                <th className="pb-2 pr-3 font-semibold">Amount</th>
                <th className="pb-2 pr-3 font-semibold">Status</th>
                <th className="pb-2 font-semibold">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {d.payments.map((p) => (
                <tr key={p.id} className="border-b border-slate-50 last:border-0">
                  <td className="py-2.5 pr-3 text-muted">{shortDate(p.createdAt)}</td>
                  <td className="py-2.5 pr-3 font-medium text-ink">{p.totalLabel}</td>
                  <td className="py-2.5 pr-3">
                    <Badge tone={p.status === 'paid' ? 'ok'
                      : p.status === 'failed' ? 'bad' : 'warn'}>
                      {p.status === 'paid' ? 'Paid'
                        : p.status === 'failed' ? 'Failed' : p.status}
                    </Badge>
                    {p.failureReason && (
                      <div className="mt-0.5 text-[11px] text-rose-600">{p.failureReason}</div>
                    )}
                  </td>
                  <td className="py-2.5 text-muted">{p.invoiceNumber ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <p className="mt-5 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                    text-xs text-slate-500">
        <Info size={13} className="mt-0.5 shrink-0" /> {d.note}
      </p>
    </>
  );
}

function Limit({ label, v }: { label: string; v: number | null | undefined }) {
  return (
    <li className="flex items-center gap-1.5">
      <Check size={11} className="shrink-0 text-emerald-600" />
      {v === null || v === undefined ? `Unlimited ${label}` : `${v} ${label}`}
    </li>
  );
}

function Line({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? 'border-t border-line pt-1 font-semibold' : ''}`}>
      <dt className="text-muted">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}
