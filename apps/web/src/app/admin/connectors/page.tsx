'use client';

import { useApi } from '../../../lib/useApi';
import { ago, shortDate, type Connector } from '../../../lib/api';
import {
  Card, PageTitle, SectionTitle, Badge, Spinner, ErrorNote, Empty, CountTile,
} from '../../../components/ui';

export default function AdminConnectors() {
  const { data, error, loading, reload } =
    useApi<{ connectors: Connector[] }>('/v1/admin/connectors');

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;

  const all = data.connectors;
  const healthy = all.filter((c) => c.status === 'ok').length;
  const byVersion = all.reduce<Record<string, number>>((acc, c) => {
    acc[c.appVersion] = (acc[c.appVersion] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <PageTitle title="Connector fleet"
        subtitle="Every Tally machine running Munim, across all customers." />

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <CountTile label="Total" value={String(all.length)} />
        <CountTile label="Healthy" value={`${healthy}/${all.length}`} />
        <CountTile label="Versions in the field" value={String(Object.keys(byVersion).length)}
          sub={Object.entries(byVersion).map(([v, n]) => `v${v}: ${n}`).join(' · ') || '—'} />
      </div>

      {/* Version adoption matters: you need to know how many customers still
          run the build you shipped with a bug last week. */}
      <SectionTitle>All connectors</SectionTitle>
      {all.length === 0
        ? <Empty title="No connectors paired" hint="Nobody has linked a Tally machine yet." />
        : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
                    <th className="pb-2 font-semibold">Business</th>
                    <th className="pb-2 font-semibold">Machine</th>
                    <th className="pb-2 font-semibold">Tally</th>
                    <th className="pb-2 font-semibold">Version</th>
                    <th className="pb-2 font-semibold">Paired</th>
                    <th className="pb-2 font-semibold">Last heartbeat</th>
                    <th className="pb-2 text-right font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map((c) => (
                    <tr key={c.id} className="border-b border-line-soft last:border-0">
                      <td className="py-2.5 font-medium">{c.orgName ?? '—'}</td>
                      <td className="py-2.5">{c.machine}</td>
                      <td className="py-2.5 text-muted">
                        {c.tallyVersion === 'erp9' ? 'ERP 9' : 'Prime'}
                        {c.tallyUp === false ? <span className="ml-1 text-amber-700">(down)</span> : null}
                      </td>
                      <td className="py-2.5 tabular-nums text-muted">v{c.appVersion}</td>
                      <td className="py-2.5 text-muted">{shortDate(c.pairedAt)}</td>
                      <td className="py-2.5 text-muted">{ago(c.lastSeenAt)}</td>
                      <td className="py-2.5 text-right">
                        <Badge tone={c.status === 'ok' ? 'ok' : 'warn'}>{c.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
    </>
  );
}
