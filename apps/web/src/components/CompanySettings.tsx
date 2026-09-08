'use client';

import { useRef, useState } from 'react';
import { patch, del, inr, type CompanyCard } from '../lib/api';
import { Button, Card, SectionTitle } from './ui';
import {
  Image as ImageIcon, Trash2, Upload, AlertTriangle, Hash, Calendar, Check,
} from 'lucide-react';

/**
 * The settings Munim owns, as opposed to the ones Tally dictates.
 *
 * Kept apart from the profile above it for a reason a customer can feel:
 * everything in the profile is read from Tally and will be overwritten on the
 * next sync, and everything here is theirs and will not. Mixing the two would
 * make people edit a field in Munim, watch it revert, and stop trusting the
 * screen.
 */

// Comfortably under the API's limit, so the browser rejects an oversized file
// before spending a minute uploading it.
const LOGO_MAX_BYTES = 380 * 1024;
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export default function CompanySettings({ c, onChanged, onRemoved }: {
  c: CompanyCard;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const s = c.settings;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function save(body: Record<string, unknown>) {
    setBusy(true); setErr(null); setSaved(false);
    try {
      await patch(`/v1/companies/${encodeURIComponent(c.tallyGuid)}/settings`, body);
      setSaved(true);
      onChanged();
      // The tick is reassurance, not state. Left up, it stops meaning "just
      // saved" and starts meaning nothing at all.
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  function pickLogo(file: File) {
    setErr(null);
    if (!LOGO_TYPES.includes(file.type)) {
      setErr('Please choose a PNG, JPG or WebP image.');
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setErr(`That image is ${Math.round(file.size / 1024)} KB. Please use one under 380 KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setErr('That file could not be read.');
    reader.onload = () => save({ logoDataUri: String(reader.result) });
    reader.readAsDataURL(file);
  }

  async function remove() {
    setBusy(true); setErr(null);
    try {
      await del(`/v1/companies/${encodeURIComponent(c.tallyGuid)}`);
      onRemoved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not remove that book.');
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionTitle icon={ImageIcon} note="Munim only — Tally is never changed">
        Look and feel
      </SectionTitle>

      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 ring-1 ring-rose-200">
          {err}
        </div>
      )}

      {/* Logo */}
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden
                        rounded-lg border border-line bg-canvas">
          {s.logoDataUri
            /* eslint-disable-next-line @next/next/no-img-element */
            ? <img src={s.logoDataUri} alt="Company logo" className="h-full w-full object-contain" />
            : <ImageIcon size={20} className="text-slate-300" />}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-800">Logo</div>
          <p className="text-xs text-slate-500">
            Printed at the top of invoices and statements. PNG, JPG or WebP, under 380 KB.
          </p>
          <div className="mt-2 flex gap-2">
            <input ref={fileRef} type="file" accept={LOGO_TYPES.join(',')} className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickLogo(f);
                // Cleared so choosing the same file twice still fires onChange.
                e.target.value = '';
              }} />
            <Button variant="ghost" icon={Upload} onClick={() => fileRef.current?.click()}>
              {s.logoDataUri ? 'Replace' : 'Upload'}
            </Button>
            {s.logoDataUri && (
              <Button variant="ghost" icon={Trash2} onClick={() => save({ logoDataUri: '' })}>
                Remove
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Number format */}
      <div className="mt-6 border-t border-slate-100 pt-5">
        <Choice
          icon={Hash}
          label="Number format"
          hint="How figures are grouped."
          value={s.numberFormat}
          onPick={(v) => save({ numberFormat: v })}
          disabled={busy}
          options={[
            { value: 'indian', label: 'Indian', sample: inr(12345678900, { format: 'indian' }) },
            { value: 'international', label: 'International', sample: inr(12345678900, { format: 'international' }) },
          ]}
        />
      </div>

      {/* Decimals */}
      <div className="mt-5">
        <Choice
          icon={Hash}
          label="Paise"
          hint="Whole rupees are easier to read; paise are needed to reconcile against Tally."
          value={String(s.decimals)}
          onPick={(v) => save({ decimals: Number(v) })}
          disabled={busy}
          options={[
            { value: '0', label: 'Hide', sample: inr(123456789, { decimals: 0 }) },
            { value: '2', label: 'Show', sample: inr(123456789, { decimals: 2 }) },
          ]}
        />
      </div>

      {/* Date format */}
      <div className="mt-5">
        <Choice
          icon={Calendar}
          label="Date format"
          hint=""
          value={s.dateFormat}
          onPick={(v) => save({ dateFormat: v })}
          disabled={busy}
          options={[
            { value: 'dd-mm-yyyy', label: 'Day first', sample: '31-03-2026' },
            { value: 'mm-dd-yyyy', label: 'Month first', sample: '03-31-2026' },
            { value: 'yyyy-mm-dd', label: 'Year first', sample: '2026-03-31' },
          ]}
        />
      </div>

      {saved && (
        <div className="mt-4 flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
          <Check size={13} /> Saved
        </div>
      )}

      {/* Removal, last and visibly separated. */}
      <div className="mt-8 rounded-lg bg-rose-50 p-4 ring-1 ring-rose-200">
        <div className="flex items-center gap-2 text-sm font-semibold text-rose-800">
          <AlertTriangle size={15} /> Remove this book from Munim
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-rose-700">
          Deletes Munim&apos;s copy of <b>{c.profile.name}</b> — {c.counts.vouchers.toLocaleString('en-IN')} vouchers
          and {c.counts.ledgers.toLocaleString('en-IN')} ledgers. <b>Your Tally company is not touched.</b>{' '}
          The connector will download it again on its next sync, so pause sync instead if you
          want it to stay away.
        </p>

        {!confirming ? (
          <div className="mt-3">
            <Button variant="danger" icon={Trash2} onClick={() => setConfirming(true)}>
              Remove from Munim
            </Button>
          </div>
        ) : (
          <div className="mt-3">
            {/* Typing the name, not an "are you sure" - the second is clicked
                through on reflex, and this is the one destructive button here. */}
            <label className="text-xs font-medium text-rose-800">
              Type <b>{c.profile.name}</b> to confirm:
            </label>
            <div className="mt-1.5 flex gap-2">
              <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-rose-300 px-3 py-2 text-sm
                           outline-none focus:border-rose-500" />
              <Button variant="danger" icon={Trash2}
                disabled={busy || confirmText !== c.profile.name}
                onClick={remove}>
                {busy ? 'Removing…' : 'Remove'}
              </Button>
              <Button variant="ghost" onClick={() => { setConfirming(false); setConfirmText(''); }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function Choice({ icon: Icon, label, hint, value, options, onPick, disabled }: {
  icon: typeof Hash;
  label: string;
  hint: string;
  value: string;
  options: { value: string; label: string; sample: string }[];
  onPick: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
        <Icon size={14} className="text-slate-400" /> {label}
      </div>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {options.map((o) => (
          /* The sample is the control. Nobody knows what "Indian grouping"
             means until they see 12,34,56,789 next to 1,234,567,890. */
          <button key={o.value} disabled={disabled} onClick={() => onPick(o.value)}
            className={`rounded-lg border px-3 py-2 text-left transition disabled:opacity-50 ${
              value === o.value
                ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500'
                : 'border-line hover:border-slate-300'}`}>
            <div className="text-xs font-semibold text-slate-700">{o.label}</div>
            <div className="mt-0.5 font-mono text-xs tabular-nums text-slate-500">{o.sample}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
