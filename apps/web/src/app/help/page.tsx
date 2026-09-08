'use client';

import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { post, ago, shortDate, type HelpPayload, type TicketRow } from '../../lib/api';
import {
  Badge, Button, Card, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  LifeBuoy, MessageSquare, Stethoscope, ChevronDown, ChevronRight, Send,
  CheckCircle2, AlertTriangle, Mail, Clock, ExternalLink,
} from 'lucide-react';
import Link from 'next/link';

/**
 * Help, in the order it actually helps.
 *
 * Diagnosis first, then the answer if we already have it, and only then the
 * form. Most tickets in this product have one of about six causes, and a
 * customer told "that computer has not reported for two hours" often does not
 * need a ticket at all — which is worth more than answering faster.
 */
export default function HelpPage() {
  const h = useApi<HelpPayload>('/v1/help', []);
  const t = useApi<{ tickets: TicketRow[]; open: number }>('/v1/tickets', []);

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('other');
  const [priority, setPriority] = useState('normal');
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function raise() {
    setBusy(true); setErr(null); setSaid(null);
    try {
      const r = await post<{ message: string }>('/v1/tickets',
        { subject, body, category, priority });
      setSaid(r.message);
      setSubject(''); setBody('');
      t.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not raise that.');
    } finally { setBusy(false); }
  }

  if (h.error) return <ErrorNote message={h.error} onRetry={h.reload} />;
  if (!h.data) return <Spinner label="Checking how things look…" />;
  const d = h.data;

  return (
    <>
      <PageTitle title="Help"
        subtitle={`We aim to reply within ${d.responseHours[priority]} working hours on ${d.planLabel}.`} />

      {said && (
        <Card className="mb-6 border-emerald-300 bg-emerald-50">
          <div className="flex items-start gap-2 text-sm text-emerald-900">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> {said}
          </div>
        </Card>
      )}
      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</div>
      )}

      {/* What we can already see is wrong, before anybody types anything. */}
      {d.suggestions.length > 0 && (
        <>
          <SectionTitle icon={Stethoscope} note="from your own system right now">
            This might be it
          </SectionTitle>
          <div className="mb-6 space-y-3">
            {d.suggestions.map((s) => (
              <Card key={s.title} className="border-amber-200 bg-amber-50">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 font-semibold text-amber-900">
                      <AlertTriangle size={15} /> {s.title}
                    </div>
                    <p className="mt-1 text-sm text-amber-800">{s.detail}</p>
                  </div>
                  <Link href={s.href}>
                    <Button variant="ghost" icon={ExternalLink}>{s.action}</Button>
                  </Link>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {(t.data?.tickets.length ?? 0) > 0 && (
        <>
          <SectionTitle icon={MessageSquare}
            note={t.data!.open ? `${t.data!.open} still open` : 'all closed'}>
            Your tickets
          </SectionTitle>
          <Card className="mb-6">
            {t.data!.tickets.map((x) => (
              <Link key={x.id} href={`/help/${x.id}`}
                className="flex items-center gap-3 border-b border-slate-50 py-2.5
                           last:border-0 hover:bg-slate-50">
                <span className="w-14 font-mono text-xs text-slate-400">#{x.number}</span>
                <div className="flex-1">
                  <div className="text-sm font-medium text-ink">{x.subject}</div>
                  <div className="text-xs text-muted">
                    {x.category} · {x.messages} message{x.messages === 1 ? '' : 's'}
                    {x.lastAt ? ` · ${ago(x.lastAt)}` : ''}
                  </div>
                </div>
                <Badge tone={
                  x.status === 'waiting_on_us' ? 'warn'
                    : x.status === 'waiting_on_you' ? 'bad'
                    : ['resolved', 'closed'].includes(x.status) ? 'muted' : 'ok'}>
                  {x.statusLabel}
                </Badge>
                <ChevronRight size={15} className="text-slate-300" />
              </Link>
            ))}
          </Card>
        </>
      )}

      <SectionTitle icon={LifeBuoy}>Ask us</SectionTitle>
      <Card className="mb-6">
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide
                             text-muted">What is it about</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-lg border border-line px-3 py-2 text-sm">
              {d.categories.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide
                             text-muted">How urgent</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value)}
              className="w-full rounded-lg border border-line px-3 py-2 text-sm">
              {d.priorities.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
          </label>
        </div>

        <input value={subject} onChange={(e) => setSubject(e.target.value)}
          placeholder="One line: what is wrong?"
          className="mb-3 w-full rounded-lg border border-line px-3 py-2 text-sm" />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5}
          placeholder="What you did, what you expected, and what happened instead."
          className="mb-3 w-full rounded-lg border border-line px-3 py-2 text-sm" />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Stethoscope size={12} />
            Your connector, Tally version and last sync are attached automatically —
            you will not be asked for them.
          </p>
          <Button icon={Send} onClick={raise} disabled={busy || !subject || !body}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </Card>

      <SectionTitle icon={MessageSquare}>Common questions</SectionTitle>
      <Card className="mb-6">
        {d.faq.map((f, i) => (
          <div key={f.q} className="border-b border-slate-50 last:border-0">
            <button onClick={() => setOpenFaq(openFaq === i ? null : i)}
              className="flex w-full items-center gap-2 py-2.5 text-left">
              {openFaq === i
                ? <ChevronDown size={15} className="shrink-0 text-slate-400" />
                : <ChevronRight size={15} className="shrink-0 text-slate-400" />}
              <span className="text-sm font-medium text-ink">{f.q}</span>
            </button>
            {openFaq === i && (
              <p className="pb-3 pl-7 text-sm text-muted">{f.a}</p>
            )}
          </div>
        ))}
      </Card>

      <Card>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase
                            tracking-wide text-muted">
              <Mail size={12} /> Email
            </div>
            <div className="mt-1 text-sm text-ink">{d.contact.email}</div>
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase
                            tracking-wide text-muted">
              <Clock size={12} /> Hours
            </div>
            <div className="mt-1 text-sm text-ink">{d.contact.hours}</div>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">
              Phone
            </div>
            <div className="mt-1 text-sm text-muted">{d.contact.phoneNote}</div>
          </div>
        </div>
      </Card>
    </>
  );
}
