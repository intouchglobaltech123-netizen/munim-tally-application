'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import {
  post, patch, inr, ago, shortDate,
  type EntryOptions, type Draft, type DraftList,
} from '../../lib/api';
import {
  Badge, Button, Card, Empty, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  FilePlus2, Send, Trash2, Plus, X, AlertTriangle, CheckCircle2, Lock,
  Info, Scale, Clock,
} from 'lucide-react';

/**
 * Creating a voucher and sending it to Tally.
 *
 * The only screen in Munim that changes somebody's books, so it is built to
 * make that obvious at every step rather than to be quick:
 *
 *   - Saving and sending are separate buttons. A draft is inert.
 *   - The balance is shown while you type, because an unbalanced voucher is the
 *     single most common reason Tally refuses one.
 *   - Ledgers are chosen from what the company actually has. Munim will not
 *     create a ledger, so a typo has to be impossible rather than merely
 *     discouraged.
 */

type Line = { ledger: string; amountPaise: number };

const emptyLine = (): Line => ({ ledger: '', amountPaise: 0 });

export default function EntryPage() {
  const { company, loading } = useAuth();
  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;

  const opts = useApi<EntryOptions>(base && `${base}/entry-options`, [company?.tallyGuid]);
  const list = useApi<DraftList>(base && `${base}/entries`, [company?.tallyGuid]);

  const [kind, setKind] = useState('sales');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [party, setParty] = useState('');
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [editing, setEditing] = useState<string | null>(null);

  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  /*
   * The running balance, computed while typing.
   *
   * Debits are positive throughout this codebase, so a balanced voucher sums to
   * exactly zero. Showing the difference as it changes is what stops somebody
   * discovering a ten-rupee gap after they press Send.
   */
  const { debit, credit, difference } = useMemo(() => {
    let d = 0; let c = 0;
    for (const l of lines) {
      const p = Math.round(Number(l.amountPaise) || 0);
      if (p > 0) d += p; else c += -p;
    }
    return { debit: d, credit: c, difference: d - c };
  }, [lines]);

  const def = opts.data?.kinds.find((k) => k.key === kind);

  function reset() {
    setLines([emptyLine(), emptyLine()]);
    setParty(''); setNarration(''); setEditing(null); setProblems([]);
  }

  function loadDraft(d: Draft) {
    setEditing(d.id);
    setKind(d.kind);
    setDate(d.date.slice(0, 10));
    setParty(d.party);
    setNarration(d.narration);
    setLines(d.entries.length ? d.entries : [emptyLine(), emptyLine()]);
    setProblems([]);
    setSaid(null); setErr(null);
  }

  const body = () => ({
    kind, date, party, narration,
    entries: lines.filter((l) => l.ledger && l.amountPaise),
  });

  async function save() {
    setBusy('save'); setErr(null); setSaid(null);
    try {
      const r = editing
        ? await patch<{ draft: Draft; problems: string[] }>(`/v1/entries/${editing}`, body())
        : await post<{ draft: Draft; problems: string[] }>(`${base}/entries`, body());
      setProblems(r.problems);
      setEditing(r.draft.id);
      setSaid(r.problems.length
        ? 'Saved as a draft. Fix the points below before sending.'
        : 'Saved. Nothing has gone to Tally yet — press Send when you are ready.');
      list.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save that.');
    } finally { setBusy(null); }
  }

  async function sendIt(id: string) {
    setBusy('send'); setErr(null); setSaid(null);
    try {
      const r = await post<{ message: string }>(`/v1/entries/${id}/send`, {});
      setSaid(r.message);
      reset();
      list.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send that.');
    } finally { setBusy(null); }
  }

  if (loading) return <Spinner />;
  if (!company) {
    return <Empty title="No company yet" icon={FilePlus2}
      hint="Connect the computer running Tally before creating entries." />;
  }
  if (opts.error) return <ErrorNote message={opts.error} onRetry={opts.reload} />;
  if (!opts.data) return <Spinner label="Loading your ledgers…" />;

  const o = opts.data;

  return (
    <>
      <PageTitle title="New entry"
        subtitle={`${company.name} — created here, then written into Tally.`}
        right={editing && (
          <Button variant="ghost" icon={X} onClick={reset}>Start fresh</Button>
        )} />

      {!o.writesEnabled && (
        <Card className="mb-6 border-amber-200 bg-amber-50">
          <div className="flex items-start gap-2 text-sm text-amber-900">
            <Lock size={15} className="mt-0.5 shrink-0" />
            <span>
              Writing to Tally is switched off for this business, so you can draft
              entries but not send them. An owner can turn it on in{' '}
              <Link href="/settings" className="font-semibold underline">Settings</Link>.
            </span>
          </div>
        </Card>
      )}

      {said && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2
                        text-sm text-emerald-800">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> {said}
        </div>
      )}
      {err && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2
                        text-sm text-rose-800">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {err}
        </div>
      )}

      <Card className="mb-6">
        <div className="mb-4 flex flex-wrap gap-1.5">
          {o.kinds.map((k) => (
            <button key={k.key} onClick={() => { setKind(k.key); setProblems([]); }}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                kind === k.key
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-line text-muted hover:border-slate-300'}`}>
              {k.label}
            </button>
          ))}
        </div>

        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <Label>Date</Label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-line px-3 py-2 text-sm" />
          </label>
          <label className="block sm:col-span-2">
            <Label>
              {def?.partySide === 'debit' ? 'Customer' :
               def?.partySide === 'credit' ? 'Supplier or customer' : 'Party (optional)'}
            </Label>
            <input list="entry-ledgers" value={party}
              onChange={(e) => setParty(e.target.value)}
              placeholder="Start typing a name from Tally"
              className="w-full rounded-lg border border-line px-3 py-2 text-sm" />
          </label>
        </div>

        <datalist id="entry-ledgers">
          {o.ledgers.map((l) => <option key={l.name} value={l.name}>{l.group}</option>)}
        </datalist>

        <SectionTitle icon={Scale} note="debits and credits must match exactly">
          Ledger lines
        </SectionTitle>

        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input list="entry-ledgers" value={l.ledger}
                onChange={(e) => {
                  const next = [...lines];
                  next[i] = { ...next[i], ledger: e.target.value };
                  setLines(next);
                }}
                placeholder="Ledger"
                className="min-w-[180px] flex-1 rounded-lg border border-line px-3 py-2 text-sm" />

              <select
                value={l.amountPaise >= 0 ? 'debit' : 'credit'}
                onChange={(e) => {
                  const next = [...lines];
                  const mag = Math.abs(next[i].amountPaise);
                  next[i] = { ...next[i],
                    amountPaise: e.target.value === 'debit' ? mag : -mag };
                  setLines(next);
                }}
                className="rounded-lg border border-line px-2 py-2 text-sm">
                <option value="debit">Debit</option>
                <option value="credit">Credit</option>
              </select>

              <input
                type="number" inputMode="decimal" step="0.01" min="0"
                value={l.amountPaise ? Math.abs(l.amountPaise) / 100 : ''}
                onChange={(e) => {
                  const next = [...lines];
                  const mag = Math.round(Number(e.target.value || 0) * 100);
                  const sign = next[i].amountPaise < 0 ? -1 : 1;
                  next[i] = { ...next[i], amountPaise: mag * sign };
                  setLines(next);
                }}
                placeholder="0.00"
                className="w-32 rounded-lg border border-line px-3 py-2 text-right text-sm
                           tabular-nums" />

              <button onClick={() => setLines(lines.filter((_, j) => j !== i))}
                disabled={lines.length <= 2}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100
                           disabled:opacity-25">
                <X size={15} />
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" icon={Plus}
            onClick={() => setLines([...lines, emptyLine()])}>
            Add a line
          </Button>

          {/*
            * The balance, live. An unbalanced voucher is the single most common
            * reason Tally refuses one, and finding out after pressing Send means
            * finding out from a machine in another room.
            */}
          <div className={`rounded-lg px-3 py-1.5 text-sm font-semibold tabular-nums ${
            difference === 0 && debit > 0
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-amber-50 text-amber-800'}`}>
            {debit === 0 && credit === 0
              ? 'Nothing entered yet'
              : difference === 0
                ? `Balanced — ${inr(debit, { decimals: 2 })}`
                : `Out by ${inr(Math.abs(difference), { decimals: 2 })}`}
          </div>
        </div>

        <label className="mt-4 block">
          <Label>Narration</Label>
          <input value={narration} onChange={(e) => setNarration(e.target.value)}
            placeholder="What this entry is for"
            className="w-full rounded-lg border border-line px-3 py-2 text-sm" />
        </label>

        {problems.length > 0 && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold
                            text-amber-900">
              <AlertTriangle size={14} /> Fix these before sending
            </div>
            <ul className="space-y-0.5 text-sm text-amber-800">
              {problems.map((p) => <li key={p}>• {p}</li>)}
            </ul>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="ghost" onClick={save} disabled={busy === 'save'}>
            {busy === 'save' ? 'Saving…' : editing ? 'Save changes' : 'Save draft'}
          </Button>
          <Button icon={Send}
            disabled={busy === 'send' || !editing || problems.length > 0
                      || !o.writesEnabled}
            onClick={() => editing && sendIt(editing)}>
            {busy === 'send' ? 'Sending…' : 'Send to Tally'}
          </Button>
          {!editing && (
            <span className="self-center text-xs text-muted">
              Save it first — sending is a separate step on purpose.
            </span>
          )}
        </div>
      </Card>

      <SectionTitle icon={Clock} note="everything created here">Entries</SectionTitle>
      <Card>
        {!list.data?.drafts.length ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : list.data.drafts.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-3 border-b
                                     border-slate-50 py-2.5 last:border-0">
            <div className="min-w-[180px] flex-1">
              <div className="text-sm font-medium text-ink">
                {d.kindLabel}{d.party ? ` — ${d.party}` : ''}
              </div>
              <div className="text-xs text-muted">
                {shortDate(d.date)} · {inr(d.amountPaise, { decimals: 2 })}
                {d.tallyNumber ? ` · Tally #${d.tallyNumber}` : ''}
                {d.createdBy ? ` · ${d.createdBy}` : ''}
              </div>
              {d.error && (
                <div className="mt-0.5 text-xs text-rose-600">{d.error}</div>
              )}
            </div>

            <Badge tone={
              d.status === 'posted' ? 'ok'
                : d.status === 'rejected' ? 'bad'
                : d.status === 'cancelled' ? 'muted' : 'warn'}>
              {d.statusLabel}
            </Badge>

            {d.editable && (
              <Button variant="ghost" onClick={() => loadDraft(d)}>Open</Button>
            )}
            {['draft', 'queued', 'rejected'].includes(d.status) && (
              <button
                onClick={() => post(`/v1/entries/${d.id}/cancel`, {}).then(() => list.reload())}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
                title="Withdraw">
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </Card>

      <p className="mt-5 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                    text-xs text-slate-500">
        <Info size={13} className="mt-0.5 shrink-0" /> {o.note}
      </p>
    </>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide
                     text-muted">
      {children}
    </span>
  );
}
