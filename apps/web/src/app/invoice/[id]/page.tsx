'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../../../lib/auth';
import { useApi } from '../../../lib/useApi';
import { useMoney } from '../../../lib/money';
import { type InvoiceDoc } from '../../../lib/api';
import { ErrorNote, Spinner, Empty } from '../../../components/ui';
import Invoice from '../../../components/Invoice';
import {
  documentText, shareOnWhatsApp, shareByEmail, shareNative, copyText, printDocument,
} from '../../../lib/share';
import {
  ArrowLeft, Printer, Share2, MessageCircle, Mail, CheckCircle2, FileText,
} from 'lucide-react';

/**
 * One invoice, ready to send.
 *
 * The page is the document. Everything around it is marked no-print, so what
 * comes out of the printer is the invoice and nothing else - rather than a
 * second print-only page that quietly drifts from this one.
 */
export default function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { company } = useAuth();
  const money = useMoney();
  const [copied, setCopied] = useState(false);

  const { data, error, loading, reload } = useApi<InvoiceDoc>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/invoice/${id}` : null,
    [company?.tallyGuid, id]);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner label="Preparing the invoice…" />;
  if (!data) return <Empty title="Not found" icon={FileText} hint="No such invoice." />;

  const doc = data;

  const asText = () => documentText({
    company: doc.seller.name,
    title: `${doc.document.title} ${doc.invoice.number} · ${doc.invoice.date}`,
    lines: [
      ...doc.lines.map((l) =>
        `${l.name} — ${l.qty}${l.unit ? ' ' + l.unit : ''} × ${money(l.ratePaise)} = ${money(l.amountPaise)}`),
      ...(doc.totals.tax.total ? [`Tax: ${money(doc.totals.tax.total)}`] : []),
      `Total: ${money(doc.totals.grossPaise)}`,
      doc.totals.inWords,
      ...(doc.invoice.dueDate ? [`Due: ${doc.invoice.dueDate}`] : []),
    ],
    footer: `${doc.seller.name}${doc.seller.phone ? ` · ${doc.seller.phone}` : ''}`,
  });

  async function share() {
    const text = asText();
    if (await shareNative(`${doc.document.title} ${doc.invoice.number}`, text)) return;
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link href="/txn/sales"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink">
          <ArrowLeft size={15} /> Back
        </Link>
        <div className="flex flex-wrap gap-2">
          <Action icon={Printer} label="Print / Save PDF" onClick={() => printDocument(`${doc.document.title} #${doc.invoice.number}`)} primary />
          <Action icon={MessageCircle} label="WhatsApp"
            onClick={() => shareOnWhatsApp(asText(), doc.buyer.phone)} />
          <Action icon={Mail} label="Email"
            onClick={() => shareByEmail(
              `${doc.document.title} ${doc.invoice.number}`, asText(), doc.buyer.email)} />
          <Action icon={copied ? CheckCircle2 : Share2}
            label={copied ? 'Copied' : 'Share'} onClick={share} />
        </div>
      </div>

      <div className="rounded-lg border border-line bg-white shadow-sm">
        <Invoice doc={doc} money={money} />
      </div>
    </>
  );
}

function Action({ icon: Icon, label, onClick, primary }: {
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
