'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { put, post, type Preferences } from '../../lib/api';
import {
  Button, Card, Empty, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  LayoutGrid, ArrowUp, ArrowDown, Eye, EyeOff, RotateCcw, CheckCircle2, Info, Home,
} from 'lucide-react';

/**
 * Making Munim look the way one person wants it.
 *
 * Per person, not per business: the owner wants cash and receivables on top,
 * the accountant wants the day book, and an account-wide layout means one of
 * them loses. Saved on the server rather than in the browser so it follows
 * somebody to their phone.
 */
export default function CustomisePage() {
  const { company, me, loading } = useAuth();
  const path = company
    ? `/v1/preferences?company=${encodeURIComponent(company.tallyGuid)}` : null;
  const prefs = useApi<Preferences>(path, [company?.tallyGuid]);

  const [order, setOrder] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [period, setPeriod] = useState('fy');
  const [landing, setLanding] = useState('dashboard');
  const [defaultCompany, setDefaultCompany] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Seeded from the resolved layout, not from the raw stored order.
   *
   * The stored order is often partial - it only names what somebody moved -
   * and editing that directly would silently drop every section they never
   * touched the first time they pressed Save.
   */
  useEffect(() => {
    if (!prefs.data) return;
    const d = prefs.data.dashboard;
    setOrder([...d.widgets.map((w) => w.key), ...d.hidden.map((w) => w.key)]);
    setHidden(d.hidden.map((w) => w.key));
    setPeriod(d.period);
    setLanding(prefs.data.preferences['app.preferences'].landing);
    setDefaultCompany(prefs.data.preferences['app.preferences'].defaultCompany);
  }, [prefs.data]);

  if (loading) return <Spinner />;
  if (!company) {
    return <Empty title="No company yet" icon={LayoutGrid}
      hint="Connect Tally first — there is nothing to lay out until then." />;
  }
  if (prefs.error) return <ErrorNote message={prefs.error} onRetry={prefs.reload} />;
  if (!prefs.data) return <Spinner label="Loading your settings…" />;

  const catalogue = prefs.data.dashboard.catalogue;
  const labelFor = (key: string) => catalogue.find((c) => c.key === key)?.label ?? key;
  const hintFor = (key: string) => catalogue.find((c) => c.key === key)?.hint ?? '';

  function move(key: string, by: number) {
    const i = order.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  }

  const toggle = (key: string) =>
    setHidden(hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]);

  async function save() {
    setBusy(true); setErr(null); setSaid(null);
    try {
      await put('/v1/preferences', {
        key: 'dashboard.layout',
        company: company!.tallyGuid,
        value: { order, hidden, period },
      });
      await put('/v1/preferences', {
        key: 'app.preferences',
        value: { landing, defaultCompany },
      });
      setSaid('Saved. Your dashboard will look like this everywhere you sign in.');
      prefs.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save that.');
    } finally { setBusy(false); }
  }

  async function reset() {
    setBusy(true); setErr(null); setSaid(null);
    try {
      await post('/v1/preferences/reset', { key: 'dashboard.layout' });
      setSaid('Back to how it ships.');
      prefs.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not reset.');
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageTitle title="Customise"
        subtitle="Your dashboard, your order. Nobody else on this account is affected."
        right={
          <div className="flex gap-2">
            <Button variant="ghost" icon={RotateCcw} onClick={reset} disabled={busy}>
              Reset
            </Button>
            <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        } />

      {said && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2
                        text-sm text-emerald-800">
          <CheckCircle2 size={15} /> {said}
        </div>
      )}
      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</div>
      )}

      <SectionTitle icon={LayoutGrid} note="drag-free: use the arrows">
        Dashboard sections
      </SectionTitle>
      <Card className="mb-6">
        {order.map((key, i) => {
          const off = hidden.includes(key);
          return (
            <div key={key}
              className={`flex items-center gap-3 border-b border-slate-50 py-2.5
                          last:border-0 ${off ? 'opacity-50' : ''}`}>
              <span className="w-6 text-xs font-semibold text-slate-400">{i + 1}</span>
              <div className="flex-1">
                <div className="text-sm font-medium text-ink">{labelFor(key)}</div>
                <div className="text-xs text-muted">{hintFor(key)}</div>
              </div>
              <button onClick={() => toggle(key)} title={off ? 'Show' : 'Hide'}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
                {off ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              <button onClick={() => move(key, -1)} disabled={i === 0}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100
                           disabled:opacity-25">
                <ArrowUp size={15} />
              </button>
              <button onClick={() => move(key, 1)} disabled={i === order.length - 1}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100
                           disabled:opacity-25">
                <ArrowDown size={15} />
              </button>
            </div>
          );
        })}
      </Card>

      <SectionTitle icon={Home}>When you open Munim</SectionTitle>
      <Card className="mb-6">
        <Field label="Dashboard period"
          hint="Which period the dashboard opens on.">
          <select value={period} onChange={(e) => setPeriod(e.target.value)}
            className="rounded-lg border border-line px-3 py-2 text-sm">
            <option value="month">This month</option>
            <option value="quarter">This quarter</option>
            <option value="fy">This financial year</option>
            <option value="year">Last 12 months</option>
          </select>
        </Field>

        <Field label="Landing screen" hint="Where signing in takes you.">
          <select value={landing} onChange={(e) => setLanding(e.target.value)}
            className="rounded-lg border border-line px-3 py-2 text-sm">
            <option value="dashboard">Dashboard</option>
            <option value="outstanding">Outstanding</option>
            <option value="reports">Reports</option>
            <option value="kpi">Key numbers</option>
          </select>
        </Field>

        <Field label="Default company"
          hint="Which book opens first. Most people run one nine times out of ten.">
          <select value={defaultCompany} onChange={(e) => setDefaultCompany(e.target.value)}
            className="rounded-lg border border-line px-3 py-2 text-sm">
            <option value="">Whichever I used last</option>
            {(me?.companies ?? []).map((c) => (
              <option key={c.tallyGuid} value={c.tallyGuid}>{c.name}</option>
            ))}
          </select>
        </Field>
      </Card>

      <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs
                    text-slate-500">
        <Info size={13} className="mt-0.5 shrink-0" />
        {prefs.data.note} A section you have no permission for is never sent to your
        browser at all, whatever you set here.
      </p>
    </>
  );
}

function Field({ label, hint, children }: {
  label: string; hint: string; children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b
                    border-slate-50 py-3 last:border-0">
      <div>
        <div className="text-sm font-medium text-ink">{label}</div>
        <div className="text-xs text-muted">{hint}</div>
      </div>
      {children}
    </div>
  );
}
