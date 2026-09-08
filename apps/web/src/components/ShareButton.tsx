'use client';

import { useState } from 'react';
import { useAuth } from '../lib/auth';
import { get, post, type SharePreview } from '../lib/api';
import { shareOnWhatsApp, shareByEmail, copyText, shareNative } from '../lib/share';
import { Button, Card } from './ui';
import {
  Share2, MessageCircle, Mail, Copy, X, Check, Loader2, AlertTriangle,
} from 'lucide-react';

/**
 * One share control, used everywhere.
 *
 * The message is built on the server so that a statement looks the same
 * whether it was sent from the party screen, the outstanding list or the
 * phone. Building it per screen is how three slightly different statements end
 * up in front of the same customer.
 *
 * Nothing is sent from here. The owner's own WhatsApp or mail app does it, so
 * it arrives from the number their customer recognises.
 */
export default function ShareButton({ kind, subject, label = 'Share', extra, compact }: {
  kind: 'statement' | 'outstanding' | 'invoice' | 'voucher' | 'item' | 'report';
  subject: string;
  label?: string;
  /** For reports, which cannot be rebuilt from an id. */
  extra?: { period?: string; lines?: string[] };
  compact?: boolean;
}) {
  const { company } = useAuth();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SharePreview | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function load() {
    if (!company) return;
    setOpen(true); setBusy(true); setErr(null);
    try {
      const qs = new URLSearchParams({ kind, subject });
      if (extra?.period) qs.set('period', extra.period);
      for (const l of extra?.lines ?? []) qs.append('line', l);

      const d = await get<SharePreview>(
        `/v1/companies/${encodeURIComponent(company.tallyGuid)}/share?${qs}`);
      setData(d);
      setText(d.message);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not build that message.');
    } finally {
      setBusy(false);
    }
  }

  async function record(status: string, channel: string) {
    if (!company || !data) return;
    setDone(true);
    try {
      await post(`/v1/companies/${encodeURIComponent(company.tallyGuid)}/share/record`, {
        kind, subject: data.subject, channel, recipient: data.recipient,
        status, message: text,
      });
    } catch { /* the message still went; the log entry is not worth blocking on */ }
  }

  return (
    <>
      <Button variant={compact ? 'ghost' : 'primary'} icon={Share2} onClick={load}>
        {label}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto
                        bg-slate-900/40 p-4 sm:p-8"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <Card className="w-full max-w-lg">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-bold text-slate-900">Share {kind}</h2>
                {data && <p className="text-xs text-slate-500">{data.subject}</p>}
              </div>
              <Button variant="ghost" icon={X} onClick={() => setOpen(false)}>Close</Button>
            </div>

            {busy && (
              <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
                <Loader2 size={15} className="animate-spin" /> Building the message…
              </div>
            )}

            {err && (
              <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</div>
            )}

            {data && !busy && (
              <>
                {/* Editable: the owner knows their customer, and a message they
                    cannot adjust is one they will retype elsewhere. */}
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12}
                  className="mt-3 w-full rounded-lg border border-line p-3 text-sm
                             leading-relaxed outline-none focus:border-brand-500" />

                {!data.recipient && kind !== 'report' && kind !== 'item' && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2
                                  text-xs text-amber-800">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    No phone number for this party in Tally. WhatsApp will ask you who to send to.
                  </div>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button icon={MessageCircle}
                    onClick={() => { shareOnWhatsApp(text, data.recipient); record('handed-off', 'whatsapp'); }}>
                    WhatsApp
                  </Button>
                  <Button variant="ghost" icon={Mail}
                    onClick={() => {
                      shareByEmail(`${data.subject} — from Munim`, text, data.email);
                      record('handed-off', 'email');
                    }}>
                    Email
                  </Button>
                  <Button variant="ghost" icon={Copy}
                    onClick={async () => {
                      if (!(await shareNative(data.subject, text))) await copyText(text);
                      record('handed-off', 'copy');
                    }}>
                    Copy
                  </Button>
                  {done && (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold
                                     text-emerald-600">
                      <Check size={13} /> Recorded
                    </span>
                  )}
                </div>

                <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
                  Munim does not send this. Your own WhatsApp or mail app does, so it
                  comes from your number.
                </p>
              </>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
