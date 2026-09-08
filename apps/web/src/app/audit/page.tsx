'use client';

import { Fragment, useState } from 'react';
import { useApi } from '../../lib/useApi';
import { ago, type AuditLog, type AuditEntry } from '../../lib/api';
import { toCsv, downloadCsv, exportName, type Column } from '../../lib/csv';
import {
  Badge, Button, Card, Empty, ErrorNote, PageTitle, Spinner,
} from '../../components/ui';
import {
  ScrollText, Search, Download, Info, Monitor, Globe, ChevronDown, ChevronRight,
} from 'lucide-react';

/**
 * Who did what.
 *
 * Read-only by construction — there is no delete anywhere in this feature.
 * The person most motivated to tidy an audit log is exactly the person it
 * exists to record.
 */
export default function AuditPage() {
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const qs = new URLSearchParams({ limit: '200' });
  if (q.trim()) qs.set('q', q.trim());
  if (action) qs.set('action', action);
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);

  const log = useApi<AuditLog>(`/v1/audit?${qs}`, [q, action, from, to]);

  const columns: Column<AuditEntry>[] = [
    { key: 'at', label: 'When', value: (r) => r.at },
    { key: 'by', label: 'Who', value: (r) => r.by },
    { key: 'label', label: 'Action', value: (r) => r.label },
    { key: 'entityName', label: 'On', value: (r) => r.entityName },
    { key: 'changes', label: 'Changed', value: (r) => r.changes },
    { key: 'companyName', label: 'Company', value: (r) => r.companyName },
    { key: 'ipPrefix', label: 'Network', value: (r) => r.ipPrefix },
    { key: 'device', label: 'Device', value: (r) => r.device },
  ];

  if (log.error) return <ErrorNote message={log.error} onRetry={log.reload} />;

  return (
    <>
      <PageTitle title="Audit log"
        subtitle="Every change anybody made, and where they made it from."
        right={
          <Button variant="ghost" icon={Download}
            disabled={!log.data?.entries.length}
            onClick={() => downloadCsv(exportName('audit-log'),
              toCsv(log.data?.entries ?? [], columns))}>
            Export
          </Button>
        } />

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="A person, or what they changed"
            className="w-full rounded-lg border border-line py-2 pl-9 pr-3 text-sm
                       outline-none focus:border-brand-500" />
        </div>
        <select value={action} onChange={(e) => setAction(e.target.value)}
          className="rounded-lg border border-line px-3 py-2 text-sm">
          <option value="">Everything</option>
          {(log.data?.actions ?? []).map((a) => (
            <option key={a.key} value={a.key}>{a.label} ({a.count})</option>
          ))}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          className="rounded-lg border border-line px-3 py-2 text-sm" />
        <span className="text-sm text-slate-400">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
          className="rounded-lg border border-line px-3 py-2 text-sm" />
      </div>

      {log.loading && !log.data ? <Spinner label="Reading the log…" />
        : !log.data?.entries.length ? (
          <Empty title="Nothing recorded yet" icon={ScrollText}
            hint="Changes to people, roles, settings and backups appear here." />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase
                                 tracking-wide text-slate-400">
                    <th className="pb-2 pr-3 font-semibold">When</th>
                    <th className="pb-2 pr-3 font-semibold">Who</th>
                    <th className="pb-2 pr-3 font-semibold">Did what</th>
                    <th className="pb-2 pr-3 font-semibold">To</th>
                    <th className="pb-2 font-semibold">From</th>
                  </tr>
                </thead>
                <tbody>
                  {log.data.entries.map((e) => (
                    <Fragment key={e.id}>
                      <tr
                        onClick={() => setOpen(open === e.id ? null : e.id)}
                        className="cursor-pointer border-b border-slate-50 last:border-0
                                   hover:bg-slate-50">
                        <td className="whitespace-nowrap py-2.5 pr-3 text-slate-500">
                          {ago(e.at)}
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="font-medium text-slate-800">{e.by}</div>
                          {e.byEmail && (
                            <div className="text-[11px] text-slate-400">{e.byEmail}</div>
                          )}
                        </td>
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-1.5">
                            {e.changes ? (
                              open === e.id
                                ? <ChevronDown size={13} className="text-slate-400" />
                                : <ChevronRight size={13} className="text-slate-400" />
                            ) : <span className="w-[13px]" />}
                            <span className="text-slate-700">{e.label}</span>
                          </div>
                          {e.changes && (
                            <div className="ml-[19px] truncate text-[11px] text-slate-400">
                              {e.changes}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-slate-600">
                          {e.entityName || '—'}
                          {e.companyName && (
                            <div className="text-[11px] text-slate-400">{e.companyName}</div>
                          )}
                        </td>
                        <td className="py-2.5">
                          <div className="flex flex-col gap-0.5 text-[11px] text-slate-400">
                            {e.ipPrefix && (
                              <span className="inline-flex items-center gap-1">
                                <Globe size={10} />{e.ipPrefix}
                              </span>
                            )}
                            {e.device && (
                              <span className="inline-flex items-center gap-1">
                                <Monitor size={10} />{e.device}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>

                      {open === e.id && (e.before || e.after) && (
                        <tr className="border-b border-slate-50">
                          <td colSpan={5} className="bg-slate-50 px-4 py-3">
                            <div className="grid gap-4 sm:grid-cols-2">
                              <div>
                                <div className="mb-1 text-[10px] font-bold uppercase
                                                tracking-wide text-slate-400">Was</div>
                                <pre className="overflow-x-auto rounded bg-white p-2
                                                text-[11px] text-slate-600">
{JSON.stringify(e.before ?? {}, null, 2)}
                                </pre>
                              </div>
                              <div>
                                <div className="mb-1 text-[10px] font-bold uppercase
                                                tracking-wide text-slate-400">Became</div>
                                <pre className="overflow-x-auto rounded bg-white p-2
                                                text-[11px] text-slate-600">
{JSON.stringify(e.after ?? {}, null, 2)}
                                </pre>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

      <p className="mt-5 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                    text-xs text-slate-500">
        <Info size={13} className="mt-0.5 shrink-0" />
        {log.data?.note} Network addresses are kept only to the nearest /24 —
        enough to tell your usual connection from an unfamiliar one, and no more.
      </p>
    </>
  );
}
