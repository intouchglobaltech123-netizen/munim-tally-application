'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useApi } from '../../../lib/useApi';
import { post, ago, type TicketDetail } from '../../../lib/api';
import {
  Badge, Button, Card, ErrorNote, PageTitle, Spinner,
} from '../../../components/ui';
import { ArrowLeft, Send, Star, CheckCircle2 } from 'lucide-react';

/** One ticket, as a conversation. */
export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useApi<TicketDetail>(`/v1/tickets/${id}`, [id]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); t.reload(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Could not do that.'); }
    finally { setBusy(false); }
  }

  if (t.error) return <ErrorNote message={t.error} onRetry={t.reload} />;
  if (!t.data) return <Spinner />;
  const d = t.data;
  const closed = ['resolved', 'closed'].includes(d.ticket.status);

  return (
    <>
      <Link href="/help" className="mb-4 inline-flex items-center gap-1.5 text-sm
                                    font-semibold text-muted hover:text-ink">
        <ArrowLeft size={15} /> All tickets
      </Link>

      <PageTitle title={d.ticket.subject}
        subtitle={`#${d.ticket.number} · ${d.ticket.category} · raised ${ago(d.ticket.createdAt)}`}
        right={<Badge tone={closed ? 'muted' : 'ok'}>{d.ticket.statusLabel}</Badge>} />

      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</div>
      )}

      <div className="mb-6 space-y-3">
        {d.messages.map((m) => (
          <Card key={m.id}
            className={m.from_staff ? 'border-brand-200 bg-brand-50/40' : ''}>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sm font-semibold text-ink">
                {m.from_staff ? 'Munim' : m.author || 'You'}
              </span>
              <span className="text-xs text-faint">{ago(m.at)}</span>
              {m.internal && <Badge tone="warn">Internal</Badge>}
            </div>
            <p className="whitespace-pre-wrap text-sm text-slate-700">{m.body}</p>
          </Card>
        ))}
      </div>

      {!closed ? (
        <Card className="mb-6">
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4}
            placeholder="Add to this ticket…"
            className="mb-3 w-full rounded-lg border border-line px-3 py-2 text-sm" />
          <div className="flex flex-wrap gap-2">
            <Button icon={Send} disabled={busy || !body}
              onClick={() => act(async () => {
                await post(`/v1/tickets/${id}/reply`, { body });
                setBody('');
              })}>
              Reply
            </Button>
            <Button variant="ghost"
              onClick={() => act(() => post(`/v1/tickets/${id}/status`,
                { status: 'closed' }))}>
              Close this
            </Button>
          </div>
        </Card>
      ) : (
        <Card className="mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-muted">
              {d.ticket.rating
                ? `You rated this ${d.ticket.rating} out of 5. Thank you.`
                : 'How did we do?'}
            </span>
            <div className="flex gap-2">
              {!d.ticket.rating && [1, 2, 3, 4, 5].map((n) => (
                <button key={n} disabled={busy}
                  onClick={() => act(() => post(`/v1/tickets/${id}/rate`, { rating: n }))}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100
                             hover:text-amber-500">
                  <Star size={18} />
                </button>
              ))}
              <Button variant="ghost"
                onClick={() => act(() => post(`/v1/tickets/${id}/status`,
                  { status: 'open' }))}>
                Reopen
              </Button>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
