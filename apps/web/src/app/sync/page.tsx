'use client';

import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { post, patch, ago, type SyncHistory, type SyncLogs, type CompanySummary } from '../../lib/api';
import Filters, { type FilterSpec, type FilterValues, matches } from '../../components/Filters';
import {
  Badge, Button, Card, Empty, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  RefreshCw, Wifi, WifiOff, CheckCircle2, XCircle, Terminal, Timer,
  ShieldAlert, ScrollText, Activity, Server,
} from 'lucide-react';

/**
 * The connector, made visible.
 *
 * This is the part of Munim that runs on the customer's own computer, behind
 * their router, on their internet. It is the only component nobody can watch
 * directly, and the one whose failure makes every figure in the product
 * silently wrong. When somebody says "my numbers are wrong", this is the
 * screen that answers why.
 */

const KIND_WORDS: Record<string, { label: string; fix: string }> = {
  network: { label: 'Internet', fix: 'The shop\'s connection dropped. Nothing is lost — queued data goes when it returns.' },
  auth: { label: 'Sign-in', fix: 'This computer is no longer linked. Re-pair it from Devices.' },
  tally: { label: 'Tally', fix: 'Tally was closed or would not answer. Open Tally and your company.' },
  other: { label: 'Other', fix: '' },
};

export default function SyncPage() {
  const { company } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);

  const hist = useApi<SyncHistory>(`/v1/sync/history?limit=60${onlyFailed ? '&failed=1' : ''}`,
    [onlyFailed]);
  const logs = useApi<SyncLogs>('/v1/sync/logs?limit=200', []);
  const [rf, setRf] = useState<FilterValues>({});
  const [lf, setLf] = useState<FilterValues>({});

  /*
   * Two lists, two questions.
   *
   * The run history is read when something is wrong and you want the failures;
   * the log is read when you already know which run and want the line. Both
   * are long, and both were previously scrolled by hand.
   */
  type Run = SyncHistory['runs'][number];
  type Line = SyncLogs['lines'][number];
  const machines = [...new Set((hist.data?.runs ?? [])
    .map((r) => r.companyName).filter(Boolean))] as string[];

  const runSpecs: FilterSpec<Run>[] = [
    { key: 'q', label: 'Company or error', kind: 'search',
      on: (r) => `${r.companyName ?? ''} ${r.error}`,
      placeholder: 'Search company or error…' },
    { key: 'failed', label: 'Failures only', kind: 'toggle', on: (r) => !r.ok },
    { key: 'kind', label: 'What went wrong', kind: 'select', on: (r) => r.errorKind,
      options: [
        { value: 'network', label: 'Network' }, { value: 'auth', label: 'Authentication' },
        { value: 'tally', label: 'Tally' }, { value: 'other', label: 'Something else' },
      ] },
    { key: 'trigger', label: 'Started by', kind: 'select', on: (r) => r.trigger,
      options: [
        { value: 'auto', label: 'Schedule' }, { value: 'manual', label: 'Someone' },
        { value: 'startup', label: 'Startup' }, { value: 'command', label: 'Command' },
      ] },
    { key: 'company', label: 'Company', kind: 'select', on: (r) => r.companyName ?? '',
      options: machines.map((m) => ({ value: m, label: m })) },
    { key: 'at', label: 'Started', kind: 'dateRange', on: (r) => r.startedAt },
    { key: 'empty', label: 'Brought something back', kind: 'toggle',
      on: (r) => r.records > 0 },
  ];

  const logSpecs: FilterSpec<Line>[] = [
    { key: 'q', label: 'Line', kind: 'search', on: (l) => l.line,
      placeholder: 'Search the log…' },
    { key: 'level', label: 'Level', kind: 'select', on: (l) => l.level,
      options: [
        { value: 'error', label: 'Errors' }, { value: 'warn', label: 'Warnings' },
        { value: 'info', label: 'Information' },
      ] },
    { key: 'at', label: 'Logged', kind: 'dateRange', on: (l) => l.at },
  ];
  const summary = useApi<CompanySummary>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/summary` : null,
    [company?.tallyGuid]);

  async function ask(kind: 'sync' | 'reconcile' | 'logs') {
    setBusy(kind); setSaid(null);
    try {
      const r = await post<{ message: string }>('/v1/sync/request', { kind });
      setSaid(r.message);
      // Given away rather than polled: the connector answers on its own beat,
      // and a spinner that cannot know when it finished is a lie.
      setTimeout(() => { hist.reload(); logs.reload(); }, 6000);
    } catch (e) {
      setSaid(e instanceof Error ? e.message : 'Could not ask the connector.');
    } finally {
      setBusy(null);
    }
  }

  async function setInterval(seconds: number) {
    setBusy('interval');
    try {
      await patch('/v1/sync/settings', { intervalSeconds: seconds });
      setSaid(`Now syncing every ${seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minutes`}. Takes effect on the next check-in.`);
    } catch (e) {
      setSaid(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setBusy(null);
    }
  }

  if (hist.error) return <ErrorNote message={hist.error} onRetry={hist.reload} />;

  const conn = summary.data?.connection;
  const w = hist.data?.week;

  return (
    <>
      <PageTitle
        title="Sync"
        subtitle="What the computer running Tally has been doing."
      />

      {conn && (
        <Card className="mb-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              {conn.online
                ? <Wifi size={20} className="mt-0.5 text-emerald-600" />
                : <WifiOff size={20} className="mt-0.5 text-rose-600" />}
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-slate-900">{conn.label}</span>
                  {conn.machineName && <Badge tone="ok">{conn.machineName}</Badge>}
                </div>
                <p className="mt-0.5 text-sm text-slate-600">{conn.hint}</p>
                {conn.lastSeenAt && (
                  <p className="mt-0.5 text-xs text-slate-400">
                    Last check-in {ago(conn.lastSeenAt)}
                  </p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button icon={RefreshCw} onClick={() => ask('sync')} disabled={busy === 'sync'}>
                {busy === 'sync' ? 'Asking…' : 'Sync now'}
              </Button>
              <Button variant="ghost" icon={ShieldAlert} onClick={() => ask('reconcile')}
                disabled={busy === 'reconcile'}>
                Check for deleted records
              </Button>
              <Button variant="ghost" icon={ScrollText} onClick={() => ask('logs')}
                disabled={busy === 'logs'}>
                Fetch logs
              </Button>
            </div>
          </div>

          {said && (
            <div className="mt-4 rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-900">
              {said}
            </div>
          )}

          <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
            These are requests, not commands. The shop&apos;s computer has no address
            anyone can dial, so it picks up instructions on its next check-in — usually
            within a few seconds.
          </p>
        </Card>
      )}

      <SectionTitle icon={Activity} note="last 7 days">How sync has been going</SectionTitle>
      {w && (
        <div className="mb-6 grid gap-3 sm:grid-cols-4">
          <Stat label="Syncs" value={w.runs.toLocaleString('en-IN')}
            sub={w.successPct != null ? `${w.successPct}% succeeded` : 'nothing yet'}
            tone={w.successPct != null && w.successPct < 90 ? 'bad' : 'ok'} />
          <Stat label="Failures" value={String(w.failures)}
            sub={w.lastFailAt ? `last ${ago(w.lastFailAt)}` : 'none'}
            tone={w.failures > 0 ? 'bad' : 'ok'} />
          <Stat label="Records synced" value={w.records.toLocaleString('en-IN')} sub="in 7 days" />
          <Stat label="Last success" value={w.lastOkAt ? ago(w.lastOkAt) : '—'}
            sub={`typically ${Math.round(w.avgMs)} ms`} />
        </div>
      )}

      <div className="mb-4 flex items-center gap-2">
        <Timer size={14} className="text-slate-400" />
        <span className="text-sm font-medium text-slate-600">Sync every</span>
        {[3, 30, 300, 1800].map((sec) => (
          <button key={sec} onClick={() => setInterval(sec)} disabled={busy === 'interval'}
            className="rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-semibold
                       text-slate-600 transition hover:bg-slate-200 disabled:opacity-50">
            {sec < 60 ? `${sec}s` : sec < 3600 ? `${sec / 60}m` : '1h'}
          </button>
        ))}
        <span className="text-xs text-slate-400">
          Slower saves the shop&apos;s bandwidth; faster shows new bills sooner.
        </span>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <SectionTitle icon={Server}>Recent syncs</SectionTitle>
        <button onClick={() => setOnlyFailed(!onlyFailed)}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
            onlyFailed ? 'bg-rose-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
          {onlyFailed ? 'Showing failures' : 'Only failures'}
        </button>
      </div>

      {hist.loading && !hist.data ? <Spinner />
        : !hist.data?.runs.length ? (
          <Empty title={onlyFailed ? 'No failures' : 'No syncs recorded yet'} icon={CheckCircle2}
            hint={onlyFailed
              ? 'Every sync in the last week worked.'
              : 'Restart the connector on the shop’s PC — older versions did not report their runs.'} />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <Filters specs={runSpecs} values={rf} onChange={setRf} />
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-slate-400">
                    <th className="pb-2 pr-3 font-semibold">When</th>
                    <th className="pb-2 pr-3 font-semibold">Book</th>
                    <th className="pb-2 pr-3 font-semibold">Why</th>
                    <th className="pb-2 pr-3 text-right font-semibold">Records</th>
                    <th className="pb-2 pr-3 text-right font-semibold">Took</th>
                    <th className="pb-2 font-semibold">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {hist.data.runs.filter((r) => matches(r, runSpecs, rf)).map((r) => (
                    <tr key={r.id} className="border-b border-slate-50 last:border-0">
                      <td className="py-2.5 pr-3 whitespace-nowrap text-slate-600">{ago(r.startedAt)}</td>
                      <td className="py-2.5 pr-3 text-slate-700">{r.companyName ?? '—'}</td>
                      <td className="py-2.5 pr-3 text-xs capitalize text-slate-500">{r.trigger}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-slate-700">
                        {r.records.toLocaleString('en-IN')}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums text-slate-500">
                        {r.durationMs < 1000 ? `${r.durationMs} ms` : `${(r.durationMs / 1000).toFixed(1)} s`}
                      </td>
                      <td className="py-2.5">
                        {r.ok ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                            <CheckCircle2 size={13} /> OK
                          </span>
                        ) : (
                          <div>
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600">
                              <XCircle size={13} /> {KIND_WORDS[r.errorKind]?.label ?? 'Failed'}
                            </span>
                            {/* Verbatim: rewording the error destroys the one
                                string that identifies the fault. */}
                            <div className="mt-0.5 max-w-md font-mono text-[11px] leading-snug text-slate-500">
                              {r.error}
                            </div>
                            {KIND_WORDS[r.errorKind]?.fix && (
                              <div className="mt-0.5 max-w-md text-[11px] text-slate-500">
                                {KIND_WORDS[r.errorKind].fix}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

      <SectionTitle icon={Terminal} note="from the shop's computer">Connector log</SectionTitle>
      {logs.data?.fetchPending && (
        <p className="mb-2 text-xs text-amber-700">
          Asked for. The log arrives on the connector&apos;s next check-in.
        </p>
      )}
      {!logs.data?.lines.length ? (
        <Empty title="No log fetched yet" icon={Terminal}
          hint="Press “Fetch logs” above and the connector uploads its recent log." />
      ) : (
        <>
        <Filters specs={logSpecs} values={lf} onChange={setLf} />
        <Card>
          <div className="max-h-96 overflow-auto rounded-lg bg-slate-900 p-3">
            {logs.data.lines.filter((l) => matches(l, logSpecs, lf)).map((l, i) => (
              <div key={i} className="flex gap-2 font-mono text-[11px] leading-relaxed">
                <span className="shrink-0 text-slate-500">
                  {new Date(l.at).toLocaleString('en-IN', {
                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className={
                  l.level === 'error' ? 'text-rose-400'
                    : l.level === 'warn' ? 'text-amber-400' : 'text-slate-300'}>
                  {l.line}
                </span>
              </div>
            ))}
          </div>
        </Card>
        </>
      )}
    </>
  );
}

function Stat({ label, value, sub, tone = 'ok' }: {
  label: string; value: string; sub: string; tone?: 'ok' | 'bad';
}) {
  return (
    <Card>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${
        tone === 'bad' ? 'text-rose-600' : 'text-slate-900'}`}>{value}</div>
      <div className="mt-0.5 text-xs text-slate-400">{sub}</div>
    </Card>
  );
}
