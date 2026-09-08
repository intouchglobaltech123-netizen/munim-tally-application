'use client';

import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { post, ago, type SecurityStatus, type LoginHistory } from '../../lib/api';
import {
  Badge, Button, Card, Empty, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  ShieldCheck, Lock, LogIn, XCircle, CheckCircle2, Smartphone, Monitor,
  AlertTriangle, Fingerprint, Info,
} from 'lucide-react';

/**
 * Account safety, for a product where sign-in is Google and nothing else.
 *
 * There is no password here to lose, which is most of the usual risk gone. The
 * remaining ones are worth showing plainly: an attempt the owner does not
 * recognise, and a phone left signed in on the shop counter.
 */

export default function SecurityPage() {
  const st = useApi<SecurityStatus>('/v1/security', []);
  const hist = useApi<LoginHistory>('/v1/security/logins?limit=50', []);
  const [pin, setPin] = useState('');
  const [minutes, setMinutes] = useState(0);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function saveLock(enable: boolean) {
    setBusy(true); setErr(null); setSaid(null);
    try {
      await post('/v1/security/app-lock', enable ? { pin, minutes } : { enabled: false });
      setPin('');
      setSaid(enable ? 'App lock is on.' : 'App lock is off.');
      st.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }

  if (st.error) return <ErrorNote message={st.error} onRetry={st.reload} />;
  if (st.loading && !st.data) return <Spinner label="Checking your account…" />;
  const s = st.data;

  return (
    <>
      <PageTitle title="Security" subtitle="Who can get at your books, and who has tried." />

      {hist.data && hist.data.failedLast30Days > 0 && (
        <div className="mb-6 flex items-start gap-2.5 rounded-lg bg-amber-50 px-4 py-3
                        text-sm ring-1 ring-amber-200">
          <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-600" />
          <div>
            <span className="font-semibold text-amber-900">
              {hist.data.failedLast30Days} failed sign-in
              {hist.data.failedLast30Days === 1 ? '' : 's'} in the last 30 days
            </span>
            <p className="mt-0.5 text-xs text-amber-800">
              If none of these were you, sign out every device below. Your Google
              account password may need changing too.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle icon={ShieldCheck}>How you sign in</SectionTitle>
          <Card>
            <Fact label="Method" value="Sign in with Google" />
            <Fact label="Password" value="None — Google holds it" />
            <Fact label="Two-factor"
              value="Whatever you set on your Google account" />
            <Fact label="Stay signed in"
              value={s?.sessionPolicy.expires ? 'Sessions expire' : 'Until you sign out'} />
            <p className="mt-3 flex items-start gap-2 rounded-lg bg-brand-50 px-3 py-2
                          text-xs leading-relaxed text-brand-900">
              <Info size={13} className="mt-0.5 shrink-0" />
              {/* Stated rather than implied: people ask about this. */}
              {s?.sessionPolicy.note}
            </p>
          </Card>
        </div>

        <div>
          <SectionTitle icon={Lock}>App lock</SectionTitle>
          <Card>
            <p className="text-sm text-slate-600">
              Google protects your account. It cannot protect a phone that is
              already signed in and lying on the counter. A PIN puts something
              in front of your figures.
            </p>

            {s?.appLock.enabled ? (
              <div className="mt-4">
                <Badge tone="ok">On</Badge>
                <span className="ml-2 text-sm text-slate-600">
                  {s.appLock.minutes === 0
                    ? 'Asks every time the app opens.'
                    : `Asks after ${s.appLock.minutes} minutes idle.`}
                  {s.appLock.biometric && ' Fingerprint allowed.'}
                </span>
                <div className="mt-3">
                  <Button variant="ghost" onClick={() => saveLock(false)} disabled={busy}>
                    Turn off
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div>
                  <label className="text-xs font-semibold text-slate-600">PIN (4–8 digits)</label>
                  <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                    inputMode="numeric" maxLength={8} type="password"
                    className="mt-1 block w-40 rounded-lg border border-line px-3 py-2
                               font-mono text-sm tracking-widest outline-none focus:border-brand-500" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-600">Ask again after</label>
                  <div className="mt-1 flex gap-1.5">
                    {[0, 5, 30, 120].map((m) => (
                      <button key={m} onClick={() => setMinutes(m)}
                        className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                          minutes === m ? 'bg-brand-700 text-white'
                                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                        {m === 0 ? 'Every time' : `${m} min`}
                      </button>
                    ))}
                  </div>
                </div>
                <Button icon={Fingerprint} onClick={() => saveLock(true)}
                  disabled={busy || pin.length < 4}>
                  {busy ? 'Saving…' : 'Turn on app lock'}
                </Button>
              </div>
            )}

            {err && <p className="mt-3 text-sm text-rose-600">{err}</p>}
            {said && <p className="mt-3 text-sm text-emerald-600">{said}</p>}
          </Card>
        </div>
      </div>

      <SectionTitle icon={LogIn} note="successes and failures">Sign-in history</SectionTitle>
      {hist.loading && !hist.data ? <Spinner />
        : !hist.data?.events.length ? (
          <Empty title="Nothing recorded yet" icon={LogIn}
            hint="Sign-ins from now on appear here." />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase
                                 tracking-wide text-slate-400">
                    <th className="pb-2 pr-3 font-semibold">When</th>
                    <th className="pb-2 pr-3 font-semibold">Device</th>
                    <th className="pb-2 pr-3 font-semibold">Network</th>
                    <th className="pb-2 font-semibold">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {hist.data.events.map((e, i) => (
                    <tr key={i} className="border-b border-slate-50 last:border-0">
                      <td className="whitespace-nowrap py-2.5 pr-3 text-slate-600">{ago(e.at)}</td>
                      <td className="py-2.5 pr-3">
                        <span className="inline-flex items-center gap-1.5 text-slate-700">
                          {e.deviceKind === 'mobile'
                            ? <Smartphone size={13} className="text-slate-400" />
                            : <Monitor size={13} className="text-slate-400" />}
                          {e.deviceLabel || e.deviceKind || 'Unknown'}
                        </span>
                      </td>
                      {/* Only a /24 is kept — enough to spot "not my usual line". */}
                      <td className="py-2.5 pr-3 font-mono text-xs text-slate-500">
                        {e.ipPrefix || '—'}
                      </td>
                      <td className="py-2.5">
                        {e.ok ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600">
                            <CheckCircle2 size={13} /> Signed in
                          </span>
                        ) : (
                          <div>
                            <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600">
                              <XCircle size={13} /> Failed
                            </span>
                            {e.reason && (
                              <div className="mt-0.5 text-[11px] text-slate-500">{e.reason}</div>
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
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-slate-50 py-2 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-semibold text-slate-800">{value}</span>
    </div>
  );
}
