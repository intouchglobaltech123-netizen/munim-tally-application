'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../../../lib/auth';
import { useApi } from '../../../lib/useApi';
import { useMoney, useDateFormat } from '../../../lib/money';
import { put, type PartyDetail } from '../../../lib/api';
import {
  Avatar, Badge, Button, Card, Empty, ErrorNote, SectionTitle, Spinner,
} from '../../../components/ui';
import { TrendChart, RankBars } from '../../../components/charts';
import ShareButton from '../../../components/ShareButton';
import {
  Phone, Mail, Hash, MapPin, Building2, Landmark, AlertTriangle, Tag,
  Receipt, ArrowDownLeft, ArrowUpRight, Package, Clock3, X, Plus, User,
} from 'lucide-react';

/**
 * One party, with everything anyone opens the screen to find.
 *
 * Open bills first, because the reason somebody looks a customer up is almost
 * always "what do they owe me and since when".
 */

const TABS = [
  { key: 'bills', label: 'Open bills' },
  { key: 'sales', label: 'Sales' },
  { key: 'purchases', label: 'Purchases' },
  { key: 'receipts', label: 'Receipts' },
  { key: 'payments', label: 'Payments' },
  { key: 'items', label: 'Items' },
  { key: 'details', label: 'Details' },
];

export default function PartyPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const { company } = useAuth();
  const money = useMoney();
  const date = useDateFormat();
  const [tab, setTab] = useState('bills');
  const [editingTags, setEditingTags] = useState(false);
  const [newTag, setNewTag] = useState('');

  const decoded = decodeURIComponent(name);
  const base = company
    ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/parties/${encodeURIComponent(decoded)}`
    : null;
  const { data, error, loading, reload } = useApi<PartyDetail>(base, [company?.tallyGuid, decoded]);

  async function saveTags(tags: string[]) {
    if (!company) return;
    await put(`${base}/tags`, { tags });
    setNewTag('');
    reload();
  }

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner label="Loading…" />;
  if (!data) return <Empty title="Not found" hint="No such party in this company." />;

  const p = data.party;
  const overdue = data.openBills.filter((b) => !b.current);

  return (
    <>
      {/*
        * The same disc that identifies this party in every list, at the head of
        * their own page - so arriving here from a list is visibly the same
        * customer rather than a name that happens to match.
        */}
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Avatar name={p.name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xl font-bold text-ink">{p.name}</div>
          <div className="text-sm text-muted">
            {p.group} · {p.kind === 'customer' ? 'Customer'
              : p.kind === 'supplier' ? 'Supplier' : 'Ledger'}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* The two things anyone sends a customer. */}
          <ShareButton kind="outstanding" subject={p.name} label="Send dues" />
          <ShareButton kind="statement" subject={p.name} label="Send statement" compact />
          <Link href="/parties"
            className="text-sm font-semibold text-brand-700 hover:underline">
            All parties
          </Link>
        </div>
      </div>

      {p.overLimit && (
        <div className="mb-5 flex items-start gap-2.5 rounded-lg bg-rose-50 px-4 py-3
                        text-sm ring-1 ring-rose-200">
          <AlertTriangle size={17} className="mt-0.5 shrink-0 text-rose-600" />
          <div>
            <span className="font-semibold text-rose-900">Over their credit limit</span>
            <p className="mt-0.5 text-xs text-rose-800">
              Owes {money(p.closingPaise)} against a limit of {money(p.creditLimitPaise)}.
            </p>
          </div>
        </div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label={p.closingPaise >= 0 ? 'Owes you' : 'You owe'}
          value={money(Math.abs(p.closingPaise))}
          tone={p.closingPaise > 0 ? 'good' : p.closingPaise < 0 ? 'bad' : undefined} />
        <Stat label="Open bills" value={String(data.openBills.length)} />
        <Stat label="Overdue" value={String(overdue.length)} tone={overdue.length ? 'bad' : undefined} />
        <Stat label="Credit terms"
          value={p.creditDays > 0 ? `${p.creditDays} days` : 'None set'} />
      </div>

      {/* Tags are Munim's own - Tally has no concept of them. */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Tag size={14} className="text-slate-400" />
        {p.tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-brand-50
                                   px-2.5 py-1 text-xs font-medium text-brand-900">
            {t}
            <button onClick={() => saveTags(p.tags.filter((x) => x !== t))}
              className="text-brand-500 hover:text-brand-800">
              <X size={11} />
            </button>
          </span>
        ))}
        {editingTags ? (
          <span className="inline-flex items-center gap-1">
            <input value={newTag} onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newTag.trim()) saveTags([...p.tags, newTag.trim()]);
                if (e.key === 'Escape') setEditingTags(false);
              }}
              autoFocus placeholder="wholesale"
              className="w-28 rounded-lg border border-line px-2 py-1 text-xs outline-none
                         focus:border-brand-500" />
            <button onClick={() => newTag.trim() && saveTags([...p.tags, newTag.trim()])}
              className="text-xs font-semibold text-brand-700">Add</button>
          </span>
        ) : (
          <button onClick={() => setEditingTags(true)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed
                       border-slate-300 px-2.5 py-1 text-xs text-slate-500 hover:border-brand-400">
            <Plus size={11} /> Tag
          </button>
        )}
        <span className="text-[11px] text-slate-400">
          Tags are Munim&apos;s own — Tally never sees them.
        </span>
      </div>

      <div className="mb-5 flex flex-wrap gap-1.5 border-b border-line pb-3">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
              tab === t.key ? 'bg-brand-700 text-white'
                            : 'text-muted hover:bg-line-soft hover:text-ink'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/*
        * Above the tabs, not inside one.
        *
        * These are the two questions somebody has in mind when they open a
        * customer at all - can I trust them to pay, and how exposed am I right
        * now. Burying either behind a tab means they are asked and not answered.
        */}
      <div className="mb-5 grid gap-4 md:grid-cols-2">
        <Card>
          <SectionTitle icon={Clock3} note="on bills already settled">
            How they pay
          </SectionTitle>
          {!data.behaviour ? (
            <p className="text-sm text-muted">
              Nothing settled yet, so there is no track record to read.
            </p>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className={`text-xl font-bold ${
                  (data.behaviour.daysAgainstTerms ?? 0) > 15 ? 'text-rose-700'
                    : (data.behaviour.daysAgainstTerms ?? 0) > 3 ? 'text-amber-700'
                    : 'text-ink'}`}>
                  {data.behaviour.verdict}
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                <Fact k="Average" v={`${data.behaviour.averageDays} days`} />
                <Fact k="Slowest" v={`${data.behaviour.worstDays} days`} />
                <Fact k="Against terms"
                  v={data.behaviour.daysAgainstTerms === null ? '—'
                    : data.behaviour.daysAgainstTerms > 0
                      ? `${data.behaviour.daysAgainstTerms} days late`
                      : `${Math.abs(data.behaviour.daysAgainstTerms)} days early`} />
                <Fact k="Paid on time" v={`${data.behaviour.onTimePercent}%`} />
              </dl>
              {/*
                * One or two settled bills is a fact, not a pattern, and saying
                * so is the difference between a useful number and a misleading
                * one.
                */}
              <p className="mt-3 text-xs text-muted">
                {data.behaviour.confident
                  ? `Based on ${data.behaviour.bills} settled bills.`
                  : `Only ${data.behaviour.bills} settled bill`
                    + `${data.behaviour.bills === 1 ? '' : 's'} so far — not yet a pattern.`}
              </p>
            </>
          )}
        </Card>

        <Card>
          <SectionTitle icon={Receipt} note="what is outstanding, and how late">
            Exposure
          </SectionTitle>
          {data.ageing.totalPaise === 0 ? (
            <p className="text-sm text-muted">Nothing outstanding.</p>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="figure text-xl font-bold text-ink">
                  {money(data.ageing.totalPaise)}
                </span>
                {data.ageing.overduePercent > 0 && (
                  <span className={`text-sm font-semibold ${
                    data.ageing.overduePercent > 50 ? 'text-rose-700' : 'text-amber-700'}`}>
                    {data.ageing.overduePercent}% overdue
                  </span>
                )}
              </div>
              <div className="mt-3 space-y-1.5">
                <AgeBar label="Not due yet" paise={data.ageing.notDuePaise}
                  total={data.ageing.totalPaise} money={money} tone="ok" />
                {data.ageing.buckets.filter((b) => b.paise > 0).map((b) => (
                  <AgeBar key={b.label} label={b.label} paise={b.paise}
                    total={data.ageing.totalPaise} money={money} tone="bad" />
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      {tab === 'bills' && (
        data.openBills.length === 0
          ? <Empty title="Nothing outstanding" icon={Receipt} hint="Every bill is settled." />
          : (
            <Card>
              <Table head={['Bill', 'Date', 'Due', 'Amount', '']}>
                {data.openBills.map((b) => (
                  <tr key={b.ref} className="border-b border-slate-50 last:border-0">
                    <td className="py-2.5 pr-3 font-medium text-slate-800">{b.ref}</td>
                    <td className="py-2.5 pr-3 text-slate-500">{date(b.billDate)}</td>
                    <td className="py-2.5 pr-3 text-slate-500">{date(b.dueDate)}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums font-semibold text-slate-900">
                      {money(b.amountPaise)}
                    </td>
                    <td className="py-2.5">
                      {b.current ? <Badge tone="ok">Current</Badge> : <Badge tone="bad">Overdue</Badge>}
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>
          )
      )}

      {tab === 'sales' && <VoucherTable rows={data.salesHistory} money={money} date={date} />}
      {tab === 'purchases' && <VoucherTable rows={data.purchaseHistory} money={money} date={date} />}
      {tab === 'receipts' && <VoucherTable rows={data.receiptHistory} money={money} date={date} />}
      {tab === 'payments' && <VoucherTable rows={data.paymentHistory} money={money} date={date} />}

      {tab === 'items' && (
        data.itemsBought.length === 0
          ? <Empty title="No item detail" icon={Package}
              hint="These sales were recorded without inventory lines." />
          : <Card><RankBars data={data.itemsBought.map((i) => ({
              label: `${i.label} (${i.qty})`, value: i.amountPaise }))} money={money} /></Card>
      )}

      {tab === 'details' && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <SectionTitle icon={User}>Contact</SectionTitle>
            <Row k="Contact person" v={p.contact.person} />
            <Row k="Phone" v={p.contact.phone} icon={Phone} />
            <Row k="Email" v={p.contact.email} icon={Mail} />
            <Row k="Address" v={p.contact.address} icon={MapPin} />
            <Row k="State" v={p.contact.state} />
            <Row k="Pincode" v={p.contact.pincode} />
            {p.contact.shippingAddress && (
              <Row k="Shipping address" v={p.contact.shippingAddress} />
            )}
          </Card>
          <Card>
            <SectionTitle icon={Hash}>Tax</SectionTitle>
            <Row k="GSTIN" v={p.tax.gstin} mono />
            <Row k="Registration" v={p.tax.registrationType} />
            <Row k="PAN" v={p.tax.pan} mono />

            <SectionTitle icon={Landmark}>Bank</SectionTitle>
            <Row k="Bank" v={p.bank.name} />
            <Row k="Account" v={p.bank.account} mono />
            <Row k="IFSC" v={p.bank.ifsc} mono />
            <Row k="Holder" v={p.bank.holder} />

            <SectionTitle icon={Building2}>Terms</SectionTitle>
            <Row k="Opening balance" v={money(p.openingPaise)} />
            <Row k="Credit limit"
              v={p.creditLimitPaise > 0 ? money(p.creditLimitPaise) : 'None set'} />
            <Row k="Credit period" v={p.creditDays > 0 ? `${p.creditDays} days` : 'None set'} />
          </Card>
        </div>
      )}

      {data.monthly.length > 1 && (
        <>
          <SectionTitle icon={Clock3} note="sales month by month">History</SectionTitle>
          <Card>
            <TrendChart data={data.monthly.map((m) => ({ at: m.at, value: m.sales }))}
              money={money} />
          </Card>
        </>
      )}
    </>
  );
}

/** A label and a figure, for a two-column fact list. */
function Fact({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="text-right font-medium text-ink tabular-nums">{v}</dd>
    </>
  );
}

/**
 * One ageing bucket as a proportion of what is owed.
 *
 * A bar rather than a number because the question is "how much of this is
 * late", and a share is read from a length far faster than from two figures
 * somebody has to divide.
 */
function AgeBar({ label, paise, total, money, tone }: {
  label: string; paise: number; total: number;
  money: (p: number) => string; tone: 'ok' | 'bad';
}) {
  if (paise <= 0) return null;
  const pct = total ? (paise / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2.5 text-xs">
      <span className="w-24 shrink-0 text-muted">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${
          tone === 'ok' ? 'bg-emerald-500' : 'bg-rose-500'}`}
          style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span className="w-24 shrink-0 text-right font-medium tabular-nums text-ink">
        {money(paise)}
      </span>
    </div>
  );
}

function VoucherTable({ rows, money, date }: {
  rows: PartyDetail['salesHistory'];
  money: (p: number) => string; date: (d: string) => string;
}) {
  if (!rows.length) return <Empty title="Nothing here" icon={Receipt} hint="No entries of this kind." />;
  return (
    <Card>
      <Table head={['No.', 'Type', 'Date', 'Amount']}>
        {rows.map((v) => (
          <tr key={v.id} className="border-b border-slate-50 last:border-0">
            <td className="py-2.5 pr-3 font-medium text-slate-800">{v.no || '—'}</td>
            <td className="py-2.5 pr-3 text-slate-500">{v.type ?? ''}</td>
            <td className="py-2.5 pr-3 text-slate-500">{date(v.date)}</td>
            <td className="py-2.5 text-right tabular-nums font-semibold text-slate-900">
              {money(Math.abs(v.amountPaise))}
            </td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-slate-400">
            {head.map((h, i) => (
              <th key={h + i}
                className={`pb-2 pr-3 font-semibold ${i >= 3 ? 'text-right' : ''}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Blank fields are shown rather than hidden here: on a details tab, "not set"
    is itself the answer somebody came for. */
function Row({ k, v, icon: Icon, mono }: {
  k: string; v: string; icon?: typeof Phone; mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-slate-50 py-2 last:border-0">
      <span className="inline-flex items-center gap-1.5 text-sm text-slate-500">
        {Icon && <Icon size={12} className="text-slate-400" />}{k}
      </span>
      <span className={`text-right text-sm ${v ? 'font-semibold text-slate-800' : 'text-slate-300'} ${
        mono ? 'font-mono' : ''}`}>
        {v || 'Not set in Tally'}
      </span>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <Card>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${
        tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-700' : 'text-slate-900'}`}>
        {value}
      </div>
    </Card>
  );
}
