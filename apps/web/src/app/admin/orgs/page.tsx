'use client';

import { useState } from 'react';
import { useApi } from '../../../lib/useApi';
import { ago, patch } from '../../../lib/api';
import { Card, PageTitle, Badge, Spinner, ErrorNote, Empty, Button } from '../../../components/ui';

/**
 * Every customer, and what each of them is allowed to do.
 *
 * Ten customers on one server will not all buy the same thing, so the answer is
 * data rather than a build per customer. This screen is where that data is set:
 * open a business, tick what they have paid for, save.
 *
 * The catalogue comes from the server, so adding a feature does not mean
 * editing this file.
 */

type Org = {
  id: string; name: string; plan: string; trialEndsAt: string; createdAt: string;
  messageCredits: number; users: number; connectors: number; companies: number;
  vouchers: number; lastSyncAt: string | null;
  features: Record<string, boolean>;
  maxConnectors: number | null; maxCompanies: number | null; notes: string;
  planLabel: string;
  overrides: { connectors: number | null; companies: number | null };
};

type Feature = { key: string; label: string; default: boolean; note?: string };

export default function AdminOrgs() {
  const { data, error, loading, reload } = useApi<{ orgs: Org[] }>('/v1/admin/orgs');
  const { data: cat } = useApi<{ features: Feature[] }>('/v1/admin/catalogue');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner />;

  const needle = q.trim().toLowerCase();
  const orgs = data.orgs.filter((o) => !needle || o.name.toLowerCase().includes(needle));

  return (
    <>
      <PageTitle title="Businesses" subtitle="Every account, and what each one can use." />

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search business…"
        className="mb-5 w-full max-w-md rounded-lg border border-line px-3 py-2.5 text-sm
                   outline-none focus:border-muted" />

      {orgs.length === 0 ? (
        <Empty title="No businesses" hint="Nothing matches that search." />
      ) : (
        <div className="space-y-3">
          {orgs.map((o) => (
            <Card key={o.id} className="p-0">
              <button
                onClick={() => setOpen(open === o.id ? null : o.id)}
                className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 text-left"
              >
                <div className="min-w-48 flex-1">
                  <div className="font-semibold">{o.name}</div>
                  <div className="text-xs text-muted">
                    {o.users} user{o.users === 1 ? '' : 's'} ·{' '}
                    {/* A null ceiling is unlimited, not "null". */}
                    {o.connectors}/{o.maxConnectors ?? '∞'} computer
                    {o.maxConnectors === 1 ? '' : 's'} ·{' '}
                    {o.companies}/{o.maxCompanies ?? '∞'} book
                    {o.maxCompanies === 1 ? '' : 's'} ·{' '}
                    {o.vouchers.toLocaleString('en-IN')} vouchers
                  </div>
                </div>
                <Badge tone={o.plan === 'internal' ? 'muted' : 'ok'}>{o.plan}</Badge>
                <div className="text-xs text-muted">
                  {o.lastSyncAt ? `synced ${ago(o.lastSyncAt)}` : 'never synced'}
                </div>
                <span className="text-xs font-semibold text-brand-700">
                  {open === o.id ? 'Close' : 'Edit'}
                </span>
              </button>

              {open === o.id && cat ? (
                <OrgEditor org={o} catalogue={cat.features} onSaved={reload} />
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function OrgEditor({ org, catalogue, onSaved }: {
  org: Org; catalogue: Feature[]; onSaved: () => void;
}) {
  const [features, setFeatures] = useState<Record<string, boolean>>(org.features);
  // Blank means "let the plan decide", which is what NULL means in the column.
  const [maxConnectors, setMaxConnectors] = useState(org.overrides.connectors?.toString() ?? '');
  const [maxCompanies, setMaxCompanies] = useState(org.overrides.companies?.toString() ?? '');
  const [plan, setPlan] = useState(org.plan);
  const [notes, setNotes] = useState(org.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null); setBusy(true); setSaved(false);
    try {
      await patch(`/v1/admin/orgs/${org.id}`, {
        features,
        maxConnectors: maxConnectors.trim() === '' ? null : Number(maxConnectors),
        maxCompanies: maxCompanies.trim() === '' ? null : Number(maxCompanies),
        plan, notes,
      });
      setSaved(true);
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="border-t border-line bg-canvas px-5 py-4">
      <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
            Features
          </h4>
          <div className="space-y-1.5">
            {catalogue.map((f) => (
              <label key={f.key} className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={features[f.key] ?? f.default}
                  onChange={(e) => setFeatures({ ...features, [f.key]: e.target.checked })}
                  className="mt-0.5 h-4 w-4 accent-brand-700"
                />
                <span className="text-sm">
                  {f.label}
                  {f.note ? <span className="ml-1.5 text-xs text-muted">— {f.note}</span> : null}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Limits</h4>
          <div className="flex gap-3">
            <Num label="Computers" value={maxConnectors} onChange={setMaxConnectors} />
            <Num label="Books" value={maxCompanies} onChange={setMaxCompanies} />
          </div>
          <p className="text-xs text-muted">
            Leave blank to use the {org.planLabel} plan&rsquo;s own limits
            ({org.maxConnectors ?? 'unlimited'} computers,{' '}
            {org.maxCompanies ?? 'unlimited'} books). A number here overrides the plan
            for this customer only.
          </p>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted">Plan</span>
            <input value={plan} onChange={(e) => setPlan(e.target.value)}
              className="w-full rounded-lg border border-line px-3 py-2 text-sm
                         outline-none focus:border-brand-600" />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted">
              Notes <span className="font-normal">(only staff see this)</span>
            </span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              placeholder="Invoice reference, what they asked for…"
              className="w-full rounded-lg border border-line px-3 py-2 text-sm
                         outline-none focus:border-brand-600" />
          </label>

          <div className="flex items-center gap-3">
            <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
            {saved ? <span className="text-xs font-semibold text-positive">Saved</span> : null}
            {err ? <span className="text-xs text-negative">{err}</span> : null}
          </div>
          <p className="text-xs text-muted">
            Takes effect on their next request — no restart, and nothing to
            reinstall on their side.
          </p>
        </div>
      </div>
    </div>
  );
}

function Num({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <label className="w-28">
      <span className="mb-1 block text-xs font-semibold text-muted">{label}</span>
      <input type="number" min={1} max={99} value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-line px-3 py-2 text-sm
                   outline-none focus:border-brand-600" />
    </label>
  );
}
