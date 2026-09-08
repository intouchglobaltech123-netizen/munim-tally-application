'use client';

import { useState } from 'react';
import { useApi } from '../../../lib/useApi';
import { post, del, API, getToken } from '../../../lib/api';
import { Card, PageTitle, Button, Spinner, ErrorNote, SectionTitle } from '../../../components/ui';

/**
 * Issuing and managing licence keys. Staff only.
 *
 * A key is what a customer buys and what lets one Tally computer connect. The
 * screen is built around the two facts that cause support calls:
 *
 *  - a key is shown ONCE, because only its hash is stored
 *  - a key works ONCE, and the listing says which machine holds it
 */

type Licence = {
  id: string; hint: string; issuedTo: string; note: string;
  issuedAt: string; expiresAt: string | null;
  status: 'unused' | 'in use' | 'revoked' | 'expired';
  usedBy: string | null; machine: string; redeemedAt: string | null;
  revokedNote: string;
};

export default function LicencesPage() {
  const { data, error, loading, reload } = useApi<{ keys: Licence[] }>('/v1/admin/licences');
  const [count, setCount] = useState('1');
  const [issuedTo, setIssuedTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function issue() {
    setErr(null); setBusy(true);
    try {
      const r = await post<{ keys: string[] }>('/v1/admin/licences', {
        count: Number(count) || 1, issuedTo, note,
      });
      setFresh(r.keys);
      setIssuedTo(''); setNote('');
      await reload();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function revoke(id: string, hint: string) {
    const why = window.prompt(
      `Cancel ${hint}?\n\nThe computer using it stops syncing immediately.\n\nReason (optional):`);
    if (why === null) return;
    try {
      await del(`/v1/admin/licences/${id}`, { note: why });
      await reload();
    } catch (e) { setErr((e as Error).message); }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorNote message={error} onRetry={reload} />;

  const keys = data?.keys ?? [];
  const unused = keys.filter((k) => k.status === 'unused').length;
  const inUse = keys.filter((k) => k.status === 'in use').length;

  return (
    <>
      <PageTitle
        title="Licence keys"
        subtitle="One key connects one Tally computer, once."
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <Card><Label>Unused</Label><Big>{unused}</Big></Card>
        <Card><Label>In use</Label><Big>{inUse}</Big></Card>
        <Card><Label>Issued</Label><Big>{keys.length}</Big></Card>
      </div>

      <Card className="mb-5">
        <SectionTitle>Issue new keys</SectionTitle>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="How many" value={count} onChange={setCount} width="w-24" />
          <Field label="Sold to" value={issuedTo} onChange={setIssuedTo}
            placeholder="Business or dealer name" width="w-64" />
          <Field label="Note" value={note} onChange={setNote}
            placeholder="Invoice no., reference" width="w-56" />
          <Button onClick={issue} disabled={busy}>
            {busy ? 'Issuing…' : 'Issue keys'}
          </Button>
        </div>

        {fresh ? (
          <div className="mt-4 rounded-lg border border-warn bg-warn-soft p-3">
            <p className="text-xs font-semibold text-warn">
              Copy these now — they cannot be shown again.
            </p>
            <pre className="mt-2 overflow-x-auto text-sm font-semibold tracking-wide text-ink">
              {fresh.join('\n')}
            </pre>
            <button
              onClick={() => navigator.clipboard?.writeText(fresh.join('\n'))}
              className="mt-2 text-xs font-semibold text-brand-700 hover:underline">
              Copy to clipboard
            </button>
          </div>
        ) : null}
        {err ? <p className="mt-3 text-sm text-negative">{err}</p> : null}
      </Card>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs uppercase tracking-wider text-muted">
            <tr>
              <Th>Key</Th><Th>Status</Th><Th>Sold to</Th>
              <Th>Used by</Th><Th>Computer</Th><Th>Issued</Th><Th />
            </tr>
          </thead>
          <tbody>
            {keys.length === 0 ? (
              <tr><td colSpan={7} className="p-6 text-center text-muted">
                No keys yet. Issue some above.
              </td></tr>
            ) : keys.map((k) => (
              <tr key={k.id} className="border-b border-line-soft last:border-0">
                <Td><span className="font-mono text-xs">{k.hint}</span></Td>
                <Td><Status value={k.status} /></Td>
                <Td>{k.issuedTo || <Dash />}</Td>
                <Td>{k.usedBy || <Dash />}</Td>
                <Td>{k.machine || <Dash />}</Td>
                <Td className="whitespace-nowrap text-muted">
                  {new Date(k.issuedAt).toLocaleDateString('en-IN')}
                </Td>
                <Td>
                  {k.status !== 'revoked' ? (
                    <button onClick={() => revoke(k.id, k.hint)}
                      className="text-xs font-semibold text-negative hover:underline">
                      Cancel
                    </button>
                  ) : (
                    <span className="text-xs text-faint" title={k.revokedNote}>cancelled</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

const Label = ({ children }: { children: React.ReactNode }) =>
  <div className="text-xs font-semibold uppercase tracking-wider text-muted">{children}</div>;
const Big = ({ children }: { children: React.ReactNode }) =>
  <div className="mt-1.5 text-2xl font-bold tabular-nums">{children}</div>;
const Th = ({ children }: { children?: React.ReactNode }) =>
  <th className="px-4 py-2.5 font-semibold">{children}</th>;
const Td = ({ children, className = '' }: { children: React.ReactNode; className?: string }) =>
  <td className={`px-4 py-2.5 ${className}`}>{children}</td>;
const Dash = () => <span className="text-faint">—</span>;

function Status({ value }: { value: Licence['status'] }) {
  const style = {
    'unused':  'bg-brand-50 text-brand-700',
    'in use':  'bg-positive-soft text-positive',
    'revoked': 'bg-negative-soft text-negative',
    'expired': 'bg-warn-soft text-warn',
  }[value];
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}>
      {value}
    </span>
  );
}

function Field({ label, value, onChange, placeholder, width = 'w-full' }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; width?: string;
}) {
  return (
    <label className={width}>
      <span className="mb-1 block text-xs font-semibold text-muted">{label}</span>
      <input value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line px-3 py-2 text-sm
                   outline-none focus:border-brand-600" />
    </label>
  );
}
