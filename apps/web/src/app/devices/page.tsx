'use client';

import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { del, ago, shortDate, type Devices } from '../../lib/api';
import {
  Badge, Button, Card, Empty, ErrorNote, OfflineBar, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';

/**
 * Linked devices. Revoking has to be possible from here: a shop PC that was
 * sold, stolen or replaced must stop syncing without anyone travelling to it.
 */
export default function DevicesPage() {
  const { data, error, loading, reload, stale, offline } = useApi<Devices>('/v1/devices');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function revoke(kind: 'connectors' | 'signins', id: string, label: string) {
    if (!confirm(
      kind === 'connectors'
        ? `Unlink "${label}"? That computer will stop syncing until it is paired again.`
        : `Sign out ${label}? That device will need to sign in with Google again.`
    )) return;
    setBusy(id); setNote(null);
    try {
      await del(`/v1/devices/${kind}/${id}`);
      setNote(kind === 'connectors' ? `${label} unlinked.` : `${label} signed out.`);
      await reload();
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(null); }
  }

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;

  return (
    <>
      <PageTitle title="Linked devices"
        subtitle="Every computer syncing your Tally, and every phone signed in." />
      <OfflineBar offline={offline} ageMs={stale} />

      {note ? (
        <Card className="mb-5 border-brand-100 bg-brand-50">
          <p className="text-sm text-brand-900">{note}</p>
        </Card>
      ) : null}

      <SectionTitle note="one per Tally computer">Tally computers</SectionTitle>
      {(data.connectors ?? []).length === 0 ? (
        <Empty title="No computer linked"
          hint="Run Munim on the PC where Tally is installed, then scan the code it shows." />
      ) : (
        <div className="mb-8 grid gap-3">
          {(data.connectors ?? []).map((c) => (
            <Card key={c.id} className={c.revoked ? 'opacity-60' : ''}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="font-semibold">{c.machine}</p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-8 gap-y-1 text-xs text-muted sm:grid-cols-4">
                    <Field label="Tally" value={c.tallyVersion === 'erp9' ? 'ERP 9' : 'Prime'} />
                    <Field label="Version" value={c.appVersion ? `v${c.appVersion}` : '—'} />
                    <Field label="Linked" value={shortDate(c.pairedAt)} />
                    <Field label="Last seen" value={ago(c.lastSeenAt)} />
                  </dl>
                </div>
                <div className="flex items-center gap-3">
                  <Badge tone={c.revoked ? 'muted' : c.status === 'ok' ? 'ok' : 'warn'}>
                    {c.revoked ? 'Unlinked' : c.status === 'ok' ? 'Syncing' : c.status}
                  </Badge>
                  {!c.revoked ? (
                    <Button variant="ghost" disabled={busy === c.id}
                      onClick={() => revoke('connectors', c.id, c.machine)}>
                      {busy === c.id ? 'Unlinking…' : 'Unlink'}
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <SectionTitle note="phones and browsers">Signed in</SectionTitle>
      <div className="grid gap-3">
        {(data.signIns ?? []).map((s) => (
          <Card key={s.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-semibold">
                  {s.name || s.phone}
                  {s.current ? (
                    <span className="ml-2 text-xs font-normal text-brand-700">this device</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {s.phone} · signed in {ago(s.signedInAt)}
                </p>
              </div>
              {!s.current ? (
                <Button variant="ghost" disabled={busy === s.id}
                  onClick={() => revoke('signins', s.id, s.phone)}>
                  {busy === s.id ? 'Signing out…' : 'Sign out'}
                </Button>
              ) : null}
            </div>
          </Card>
        ))}
      </div>

      <p className="mt-6 text-xs text-muted">
        Unlinking a computer stops it syncing immediately — its access is
        revoked on the server, not just hidden here.
      </p>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-faint">{label}</dt>
      <dd className="font-medium text-body">{value}</dd>
    </div>
  );
}
