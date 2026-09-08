'use client';

import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { useMoney } from '../../lib/money';
import {
  patch, type DocTemplatePayload, type DocTemplate, type InvoiceDoc,
} from '../../lib/api';
import {
  Badge, Button, Card, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import Invoice from '../../components/Invoice';
import {
  FileText, Check, Info, QrCode, Landmark, Type, Layout, Eye,
} from 'lucide-react';

/**
 * The document designer.
 *
 * Deliberately not a drag-and-drop canvas. A tax invoice has a required shape,
 * and a blank canvas produces documents that fail an audit with no way for the
 * person using it to know until it does. What is offered instead is: which
 * blocks appear, what size paper, and the shop's own words.
 *
 * The preview is the real invoice component with real data, not a mock - so
 * what is on screen is what comes out of the printer.
 */

const FONTS = [
  { key: 'sans', label: 'Sans', sample: 'Modern' },
  { key: 'serif', label: 'Serif', sample: 'Traditional' },
  { key: 'mono', label: 'Mono', sample: 'Typewriter' },
];

const ACCENTS = ['#1F2937', '#0E7A47', '#0B5A8A', '#7A1A15', '#C9A227', '#4C1D95'];

export default function DocumentPage() {
  const { company } = useAuth();
  const money = useMoney();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;
  const cfg = useApi<DocTemplatePayload>(base && `${base}/doc-template`, [company?.tallyGuid]);

  /*
   * A real invoice to preview against.
   *
   * The most recent one, because a shop recognises its own last sale - and a
   * made-up sample hides exactly the problems worth seeing, like a party name
   * too long for the box.
   */
  const sample = useApi<{ rows: { id: string }[] }>(
    base && `${base}/txn/sales?groupBy=none&limit=1`, [company?.tallyGuid]);
  const preview = useApi<InvoiceDoc>(
    base && sample.data?.rows?.[0]?.id
      ? `${base}/invoice/${sample.data.rows[0].id}` : null,
    [company?.tallyGuid, sample.data?.rows?.[0]?.id, cfg.data?.template]);

  async function save(body: Record<string, unknown>) {
    if (!base) return;
    setSaving(true); setErr(null); setSaved(false);
    try {
      await patch(`${base}/doc-template`, body);
      await cfg.reload();
      await preview.reload();
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setSaving(false);
    }
  }

  if (cfg.error) return <ErrorNote message={cfg.error} onRetry={cfg.reload} />;
  if (cfg.loading && !cfg.data) return <Spinner label="Loading your template…" />;
  if (!cfg.data) return null;

  const t: DocTemplate = cfg.data.template;

  return (
    <>
      <PageTitle title="Document design"
        subtitle="How your invoices and statements look when you print or share them."
        right={saved ? (
          <span className="inline-flex items-center gap-1 text-sm font-semibold text-emerald-600">
            <Check size={14} /> Saved
          </span>
        ) : undefined} />

      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700
                        ring-1 ring-rose-200">{err}</div>
      )}

      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        <div className="space-y-5">
          <Card>
            <SectionTitle icon={Layout}>Paper</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(cfg.data.pages).map(([key, p]) => (
                <Pill key={key} on={t.page.size === key} disabled={saving}
                  onClick={() => save({ pageSize: key })}>
                  {p.label}
                </Pill>
              ))}
            </div>
            {t.page.size === 'thermal' && (
              <p className="mt-2 text-xs text-slate-500">
                80mm roll. Spacing is tightened automatically — anything else runs off the paper.
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-1.5">
              {['portrait', 'landscape'].map((o) => (
                <Pill key={o} on={t.page.orientation === o} disabled={saving}
                  onClick={() => save({ orientation: o })}>
                  {o === 'portrait' ? 'Portrait' : 'Landscape'}
                </Pill>
              ))}
            </div>

            <label className="mt-4 block text-xs font-semibold text-slate-600">
              Margin: {t.page.marginMm}mm
            </label>
            <input type="range" min={0} max={40} value={t.page.marginMm}
              onChange={(e) => save({ marginMm: Number(e.target.value) })}
              className="mt-1 w-full" />
          </Card>

          <Card>
            <SectionTitle icon={Type}>Type</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {FONTS.map((f) => (
                <Pill key={f.key} on={t.type.font === f.key} disabled={saving}
                  onClick={() => save({ font: f.key })}>
                  {f.label}
                </Pill>
              ))}
            </div>

            <label className="mt-4 block text-xs font-semibold text-slate-600">
              Size: {t.type.sizePt}pt
            </label>
            <input type="range" min={8} max={18} value={t.type.sizePt}
              onChange={(e) => save({ fontSize: Number(e.target.value) })}
              className="mt-1 w-full" />

            <div className="mt-4 text-xs font-semibold text-slate-600">Accent</div>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {ACCENTS.map((c) => (
                <button key={c} onClick={() => save({ accent: c })} disabled={saving}
                  aria-label={`Accent ${c}`}
                  className={`h-7 w-7 rounded-full ring-2 transition ${
                    t.type.accent.toLowerCase() === c.toLowerCase()
                      ? 'ring-slate-900' : 'ring-transparent hover:ring-slate-300'}`}
                  style={{ background: c }} />
              ))}
            </div>

            <div className="mt-4 space-y-2">
              <Toggle label="Table borders" on={t.type.borders} disabled={saving}
                onChange={(v) => save({ borders: v })} />
              <Toggle label="Tight spacing" on={t.type.dense}
                disabled={saving || t.page.size === 'thermal'}
                onChange={(v) => save({ dense: v })} />
            </div>
          </Card>

          <Card>
            <SectionTitle icon={Eye}>What appears</SectionTitle>
            <div className="space-y-1.5">
              {Object.entries(cfg.data.blocks).map(([key, b]) => (
                <Toggle key={key} label={b.label} hint={b.hint}
                  on={t.show[key] !== false} disabled={saving}
                  onChange={(v) => save({ show: { ...t.show, [key]: v } })} />
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle icon={QrCode}>Getting paid</SectionTitle>
            <Field label="UPI id" value={t.upiId} placeholder="shop@okhdfcbank"
              hint="Puts a QR on the invoice with the amount already filled in."
              onSave={(v) => save({ upiId: v })} />
            <SectionTitle icon={Landmark}>Bank</SectionTitle>
            <Field label="Bank name" value={t.bank.name} onSave={(v) => save({ bankName: v })} />
            <Field label="Account number" value={t.bank.account}
              onSave={(v) => save({ bankAccount: v })} />
            <Field label="IFSC" value={t.bank.ifsc} onSave={(v) => save({ bankIfsc: v })} />
            <Field label="Branch" value={t.bank.branch} onSave={(v) => save({ bankBranch: v })} />
          </Card>

          <Card>
            <SectionTitle icon={FileText}>Your words</SectionTitle>
            <TextArea label="Terms" value={t.text.terms} rows={4}
              placeholder="Goods once sold will not be taken back."
              onSave={(v) => save({ terms: v })} />
            <TextArea label="Footer" value={t.text.footer} rows={2}
              placeholder="Thank you for your business."
              onSave={(v) => save({ footer: v })} />
            <Field label="Signatory" value={t.text.signatory} placeholder="Authorised signatory"
              onSave={(v) => save({ signatory: v })} />
          </Card>
        </div>

        <div>
          <SectionTitle icon={FileText} note="your most recent invoice, with these settings">
            Preview
          </SectionTitle>
          <div className="overflow-auto rounded-lg border border-line bg-slate-100 p-4">
            {preview.data ? (
              <div className="mx-auto bg-white shadow-sm" style={{ width: 'fit-content' }}>
                <Invoice doc={preview.data} money={money} />
              </div>
            ) : (
              <p className="py-12 text-center text-sm text-slate-500">
                {sample.data?.rows?.length === 0
                  ? 'No invoice to preview yet. One appears as soon as Tally has a sale.'
                  : 'Loading a real invoice to preview…'}
              </p>
            )}
          </div>
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                        text-xs text-slate-500">
            <Info size={13} className="mt-0.5 shrink-0" />
            {cfg.data.note} This preview uses a real invoice, so what you see here is
            what prints.
          </p>
        </div>
      </div>
    </>
  );
}

function Pill({ on, children, onClick, disabled }: {
  on: boolean; children: React.ReactNode; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
        on ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
      {children}
    </button>
  );
}

function Toggle({ label, hint, on, onChange, disabled }: {
  label: string; hint?: string; on: boolean;
  onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <button onClick={() => onChange(!on)} disabled={disabled}
      className="flex w-full items-start gap-2.5 rounded-lg px-1 py-1 text-left
                 transition hover:bg-slate-50 disabled:opacity-50">
      <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded
                        border transition ${
        on ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300'}`}>
        {on && <Check size={11} />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-slate-700">{label}</span>
        {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
      </span>
    </button>
  );
}

/** Saves on blur rather than on every keystroke, which would be a write per letter. */
function Field({ label, value, placeholder, hint, onSave }: {
  label: string; value: string; placeholder?: string; hint?: string;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  return (
    <div className="mb-3">
      <label className="text-xs font-semibold text-slate-600">{label}</label>
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder}
        onBlur={() => { if (v !== value) onSave(v); }}
        className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm
                   outline-none focus:border-brand-500" />
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

function TextArea({ label, value, rows, placeholder, onSave }: {
  label: string; value: string; rows: number; placeholder?: string;
  onSave: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  return (
    <div className="mb-3">
      <label className="text-xs font-semibold text-slate-600">{label}</label>
      <textarea value={v} onChange={(e) => setV(e.target.value)} rows={rows}
        placeholder={placeholder}
        onBlur={() => { if (v !== value) onSave(v); }}
        className="mt-1 w-full rounded-lg border border-line p-3 text-sm
                   outline-none focus:border-brand-500" />
    </div>
  );
}
