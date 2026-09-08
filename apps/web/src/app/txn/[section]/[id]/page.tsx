'use client';

import { use } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, Receipt, Package, Scale, Printer, Share2, MessageCircle, Mail,
  Copy, CheckCircle2, Clock3, AlertTriangle, ArrowLeftRight, Info, FileText,
} from 'lucide-react';
import { useState } from 'react';
import { useMoney } from '../../../../lib/money';
import {
  documentText, shareOnWhatsApp, shareByEmail, shareNative, copyText, printDocument,
} from '../../../../lib/share';
import { useAuth } from '../../../../lib/auth';
import { useApi } from '../../../../lib/useApi';
import { inr, shortDate } from '../../../../lib/api';
import {
  Card, PageTitle, SectionTitle, Spinner, ErrorNote, Badge, OfflineBar, Empty,
} from '../../../../components/ui';

/**
 * One voucher, the way it looks in Tally.
 *
 * Three parts, because that is how an accountant reads one: what was sold, what
 * tax was charged, and which ledgers moved. The ledger legs are shown rather
 * than hidden - they are the actual accounting entry, and an accountant
 * checking a voucher wants to see both sides.
 */

type Detail = {
  id: string; vchNo: string; vchType: string; date: string;
  party: string; narration: string; amountPaise: number; isCancelled: boolean;
  items: { name: string; qty: number; ratePaise: number; amountPaise: number }[];
  entries: { ledger: string; amountPaise: number; side: 'debit' | 'credit' }[];
  taxes: { label: string; amountPaise: number }[];
  roundOffPaise: number;
  bills: { ref: string; billDate: string; dueDate: string | null;
           amountPaise: number; type: string }[];
  isCommitment: boolean;
  paymentStatus: 'paid' | 'part-paid' | 'unpaid' | null;
  outstandingPaise: number | null;
  paidPaise: number | null;
  against: { kind: 'against-invoice' | 'advance'; invoices: string[]; multiple: boolean } | null;
  contra: { from: string; to: string; label: string } | null;
};

const PAID: Record<string, { tone: 'ok' | 'warn' | 'bad'; label: string; icon: typeof CheckCircle2 }> = {
  paid: { tone: 'ok', label: 'Paid in full', icon: CheckCircle2 },
  'part-paid': { tone: 'warn', label: 'Part paid', icon: Clock3 },
  unpaid: { tone: 'bad', label: 'Unpaid', icon: AlertTriangle },
};

export default function VoucherPage({ params }: {
  params: Promise<{ section: string; id: string }>;
}) {
  const { section, id } = use(params);
  const { company } = useAuth();
  const money = useMoney();
  const [copied, setCopied] = useState(false);

  const { data, error, loading, reload, stale, offline } = useApi<Detail>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/txn/${section}/${id}` : null,
    [id],
  );

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label="Opening voucher…" />;

  // Captured after the null guard: TypeScript loses the narrowing inside the
  // async closures below, which could in principle run after a re-render.
  const doc = data;

  const taxTotal = doc.taxes.reduce((n, t) => n + t.amountPaise, 0);
  const itemsTotal = doc.items.reduce((n, i) => n + i.amountPaise, 0);

  /*
   * The document as text, for WhatsApp and email.
   *
   * Deliberately readable on its own: somebody receiving this on a phone
   * should be able to act on it without opening anything.
   */
  const asText = () => documentText({
    company: company?.name ?? 'Munim',
    title: `${doc.vchType} #${doc.vchNo} · ${shortDate(doc.date)}`,
    lines: [
      doc.party ? `Party: ${doc.party}` : '',
      ...doc.items.map((i) => `${i.name} — ${i.qty} × ${money(i.ratePaise)} = ${money(i.amountPaise)}`),
      ...(taxTotal ? [`Tax: ${money(taxTotal)}`] : []),
      `Total: ${money(doc.amountPaise)}`,
      ...(doc.paymentStatus === 'unpaid' || doc.paymentStatus === 'part-paid'
        ? [`Outstanding: ${money(doc.outstandingPaise ?? 0)}`] : []),
      ...doc.bills.map((b) => `Bill ${b.ref}${b.dueDate ? ` · due ${shortDate(b.dueDate)}` : ''}`),
    ].filter(Boolean),
    footer: 'Sent from Munim',
  });

  async function share() {
    const text = asText();
    if (await shareNative(`${doc.vchType} #${doc.vchNo}`, text)) return;
    // No share sheet on this browser, so the next most useful thing is the
    // text on the clipboard rather than a button that does nothing.
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <>
      <Link href={`/txn/${section}`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink">
        <ArrowLeft size={15} strokeWidth={2.2} /> Back
      </Link>

      <div className="no-print mb-5 flex flex-wrap items-center gap-2">
        <ActionButton icon={Printer} onClick={() => printDocument(`${data.vchType} #${data.vchNo}`)}
          label="Print / PDF" primary />
        <ActionButton icon={MessageCircle} label="WhatsApp"
          onClick={() => shareOnWhatsApp(asText())} />
        <ActionButton icon={Mail} label="Email"
          onClick={() => shareByEmail(`${data.vchType} #${data.vchNo}`, asText())} />
        <ActionButton icon={copied ? CheckCircle2 : Share2}
          label={copied ? 'Copied' : 'Share'} onClick={share} />
        {/* The full document, with letterhead, HSN and the tax split. */}
        <Link href={`/invoice/${doc.id}`}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2
                     text-xs font-semibold text-slate-700 transition hover:bg-slate-200">
          <FileText size={14} /> Invoice view
        </Link>
      </div>

      {data.paymentStatus && (
        <div className={`no-print mb-5 flex flex-wrap items-center gap-3 rounded-lg px-4 py-3
                         text-sm ring-1 ${
          data.paymentStatus === 'paid' ? 'bg-emerald-50 ring-emerald-200'
            : data.paymentStatus === 'part-paid' ? 'bg-amber-50 ring-amber-200'
            : 'bg-rose-50 ring-rose-200'}`}>
          {(() => { const I = PAID[data.paymentStatus].icon; return (
            <I size={17} className={
              data.paymentStatus === 'paid' ? 'text-emerald-600'
                : data.paymentStatus === 'part-paid' ? 'text-amber-600' : 'text-rose-600'} />
          ); })()}
          <span className="font-semibold text-slate-800">{PAID[data.paymentStatus].label}</span>
          {data.paymentStatus !== 'paid' && (
            <span className="text-slate-600">
              {money(data.paidPaise ?? 0)} received of {money(data.amountPaise)} ·{' '}
              <b>{money(data.outstandingPaise ?? 0)} outstanding</b>
            </span>
          )}
        </div>
      )}

      {data.isCommitment && (
        <div className="no-print mb-5 flex items-start gap-2.5 rounded-lg bg-brand-50 px-4 py-3
                        text-sm ring-1 ring-brand-200">
          <Info size={16} className="mt-0.5 shrink-0 text-brand-700" />
          <span className="text-brand-900">
            This is an <b>order</b>, not an invoice — a commitment to trade. It is
            not counted in sales or profit until it becomes an invoice in Tally.
          </span>
        </div>
      )}

      {data.against && (
        <div className="no-print mb-5 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">
          {data.against.kind === 'advance'
            ? 'Advance — money taken before any bill was raised.'
            : `Settles ${data.against.multiple ? 'invoices' : 'invoice'} ${data.against.invoices.join(', ')}.`}
        </div>
      )}

      {data.contra?.label && (
        <div className="no-print mb-5 flex items-center gap-2 rounded-lg bg-slate-50 px-4 py-3
                        text-sm text-slate-700">
          <ArrowLeftRight size={15} className="text-slate-400" />
          <span className="font-semibold">{data.contra.label}</span>
        </div>
      )}

      <PageTitle
        title={data.party || data.vchType}
        subtitle={`${data.vchType} · #${data.vchNo} · ${shortDate(data.date)}`}
        right={
          <div className="text-right">
            <div className="figure text-2xl font-bold leading-none">{inr(data.amountPaise)}</div>
            {data.isCancelled
              ? <div className="mt-2"><Badge tone="bad">Cancelled in Tally</Badge></div>
              : null}
          </div>
        }
      />
      <OfflineBar offline={offline} ageMs={stale} />

      {data.narration ? (
        <Card className="mb-5">
          <p className="text-sm text-body">{data.narration}</p>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-5">
          <Card className="p-0">
            <div className="px-5 pt-5">
              <SectionTitle icon={Package}
                note={data.items.length ? `${data.items.length} line${data.items.length === 1 ? '' : 's'}` : undefined}>
                Items
              </SectionTitle>
            </div>
            {data.items.length === 0 ? (
              <Empty title="No item lines"
                hint="This voucher posts straight to ledgers — Tally records no stock against it." />
            ) : (
              <div className="overflow-x-auto px-5 pb-5">
                <table className="w-full min-w-[420px] text-sm">
                  <thead className="border-b border-line">
                    <tr className="text-left text-[11px] uppercase tracking-[0.07em] text-muted">
                      <th className="pb-2.5 font-semibold">Item</th>
                      <th className="pb-2.5 text-right font-semibold">Qty</th>
                      <th className="pb-2.5 text-right font-semibold">Rate</th>
                      <th className="pb-2.5 text-right font-semibold">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {data.items.map((i, n) => (
                      <tr key={`${i.name}-${n}`}>
                        <td className="py-2.5 pr-4 font-medium">{i.name}</td>
                        <td className="figure py-2.5 pl-4 text-right">{i.qty || '—'}</td>
                        <td className="figure py-2.5 pl-4 text-right">
                          {i.ratePaise ? inr(i.ratePaise) : '—'}
                        </td>
                        <td className="figure py-2.5 pl-4 text-right font-semibold">
                          {inr(i.amountPaise)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-line">
                      <td className="py-3 font-bold" colSpan={3}>Total</td>
                      <td className="figure py-3 text-right font-bold">{inr(itemsTotal)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle icon={Scale} note="the accounting entry">Ledger postings</SectionTitle>
            <ul className="divide-y divide-line-soft">
              {data.entries.map((e, n) => (
                <li key={`${e.ledger}-${n}`} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{e.ledger}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${
                    e.side === 'debit' ? 'bg-brand-50 text-brand-700' : 'bg-gold-50 text-gold-700'}`}>
                    {e.side === 'debit' ? 'DR' : 'CR'}
                  </span>
                  <span className="figure w-32 text-right font-semibold">
                    {inr(Math.abs(e.amountPaise))}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <SectionTitle icon={Receipt}>Summary</SectionTitle>
            <dl className="space-y-2.5 text-sm">
              <Line label="Items" value={inr(itemsTotal)} />
              {data.taxes.map((t) => (
                <Line key={t.label} label={t.label} value={inr(t.amountPaise)} />
              ))}
              {data.roundOffPaise !== 0
                ? <Line label="Round off" value={inr(data.roundOffPaise)} /> : null}
              {taxTotal > 0 ? <Line label="Total tax" value={inr(taxTotal)} /> : null}
              <div className="flex items-baseline justify-between border-t-2 border-line pt-3">
                <dt className="font-bold">Gross total</dt>
                <dd className="figure text-lg font-bold">{inr(data.amountPaise)}</dd>
              </div>
            </dl>
            {data.taxes.length === 0 ? (
              <p className="mt-4 text-xs text-muted">
                No tax ledgers on this voucher. If your books charge GST, the tax
                appears here automatically.
              </p>
            ) : null}
          </Card>

          {data.bills.length > 0 ? (
            <Card>
              <SectionTitle note="bill-wise">Against bills</SectionTitle>
              <ul className="divide-y divide-line-soft">
                {data.bills.map((b, n) => (
                  <li key={`${b.ref}-${n}`} className="py-2.5 text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">{b.ref || '—'}</span>
                      <span className="figure font-semibold">{inr(Math.abs(b.amountPaise))}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {b.type}
                      {b.dueDate ? ` · due ${shortDate(b.dueDate)}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {data.party ? (
            <Card>
              <SectionTitle>Party</SectionTitle>
              <Link href={`/parties/${encodeURIComponent(data.party)}`}
                className="text-sm font-semibold text-brand-700 hover:underline">
                See {data.party}&apos;s full statement →
              </Link>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}

const Line = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline justify-between gap-3">
    <dt className="text-muted">{label}</dt>
    <dd className="figure font-medium">{value}</dd>
  </div>
);


function ActionButton({ icon: Icon, label, onClick, primary }: {
  icon: typeof Printer; label: string; onClick: () => void; primary?: boolean;
}) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold
                  transition ${primary
        ? 'bg-brand-700 text-white hover:bg-brand-800'
        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>
      <Icon size={14} /> {label}
    </button>
  );
}
