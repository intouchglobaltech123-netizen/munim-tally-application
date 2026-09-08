'use client';

import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { post, patch, del, ago, shortDate, type Developer } from '../../lib/api';
import {
  Badge, Button, Card, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  KeyRound, Webhook, Copy, Check, Trash2, Play, AlertTriangle, Activity,
  Info, Lock, Plus,
} from 'lucide-react';

/**
 * Where a customer wires Munim into their own software.
 *
 * Two things dominate the design: a key is shown exactly once, so the moment it
 * appears has to be unmissable; and every endpoint is read-only, which is worth
 * saying on the page rather than leaving somebody to discover it with a POST.
 */
export default function DeveloperPage() {
  const d = useApi<Developer>('/v1/developer', []);

  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>([]);
  const [madeKey, setMadeKey] = useState<{ key: string; warning: string } | null>(null);

  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState<string[]>([]);
  const [madeHook, setMadeHook] = useState<
    { secret: string; warning: string; howToVerify: string } | null>(null);

  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 2000);
  }

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key); setErr(null); setSaid(null);
    try {
      await fn();
      d.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not do that.');
    } finally { setBusy(null); }
  }

  if (d.error) return <ErrorNote message={d.error} onRetry={d.reload} />;
  if (!d.data) return <Spinner label="Loading your integration settings…" />;
  const data = d.data;

  return (
    <>
      <PageTitle title="Developers"
        subtitle="Keys and webhooks for your own software." />

      {!data.enabled && (
        <Card className="mb-6 border-amber-200 bg-amber-50">
          <div className="flex items-start gap-2 text-sm text-amber-900">
            <Lock size={15} className="mt-0.5 shrink-0" />
            <span>{data.disabledNote}</span>
          </div>
        </Card>
      )}
      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2
                        text-sm text-rose-800">
          <AlertTriangle size={15} /> {err}
        </div>
      )}
      {said && (
        <div className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {said}
        </div>
      )}

      <Card className="mb-6">
        <div className="grid gap-4 sm:grid-cols-4">
          <Stat label="Calls (24h)" value={data.usage.calls24h.toLocaleString('en-IN')} />
          <Stat label="Errors (24h)" value={String(data.usage.errors24h)}
            bad={data.usage.errors24h > 0} />
          <Stat label="Average" value={`${data.usage.averageMs}ms`} />
          <Stat label="Daily allowance"
            value={data.usage.limitPerDay === null
              ? 'Unlimited' : data.usage.limitPerDay.toLocaleString('en-IN')} />
        </div>
        {data.baseUrl && (
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
            <code className="flex-1 truncate text-xs text-slate-700">
              {data.baseUrl}/api/v1
            </code>
            <button onClick={() => copy(`${data.baseUrl}/api/v1`, 'base')}
              className="text-slate-500 hover:text-ink">
              {copied === 'base' ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        )}
      </Card>

      {/* A key exists in clear exactly once. That moment gets the whole width. */}
      {madeKey && (
        <Card className="mb-6 border-emerald-300 bg-emerald-50">
          <SectionTitle icon={KeyRound}>Your new key</SectionTitle>
          <div className="flex items-center gap-2 rounded-lg bg-white px-3 py-2">
            <code className="flex-1 break-all text-xs text-slate-800">{madeKey.key}</code>
            <button onClick={() => copy(madeKey.key, 'key')}
              className="shrink-0 text-slate-500 hover:text-ink">
              {copied === 'key' ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <p className="mt-2 text-sm text-emerald-900">{madeKey.warning}</p>
          <Button variant="ghost" onClick={() => setMadeKey(null)}>Done</Button>
        </Card>
      )}

      <SectionTitle icon={KeyRound} note="read-only, always">API keys</SectionTitle>
      <Card className="mb-6">
        {data.keys.length === 0 ? (
          <p className="mb-4 text-sm text-muted">No keys yet.</p>
        ) : (
          <div className="mb-4">
            {data.keys.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center gap-3 border-b
                                         border-slate-50 py-2.5 last:border-0">
                <div className="min-w-[180px] flex-1">
                  <div className="text-sm font-medium text-ink">{k.name}</div>
                  <code className="text-[11px] text-muted">{k.prefix}…</code>
                  <div className="mt-0.5 text-[11px] text-faint">
                    {k.scopes.join(', ')}
                    {k.company ? ` · ${k.company} only` : ''}
                  </div>
                </div>
                <div className="text-xs text-muted">
                  {k.calls.toLocaleString('en-IN')} calls
                  {k.lastUsedAt ? ` · ${ago(k.lastUsedAt)}` : ''}
                </div>
                <Badge tone={k.status === 'active' ? 'ok'
                  : k.status === 'never used' ? 'warn' : 'muted'}>
                  {k.status}
                </Badge>
                {!k.revokedAt && (
                  <Button variant="ghost" icon={Trash2}
                    disabled={busy === k.id}
                    onClick={() => run(k.id, async () => {
                      await del(`/v1/developer/keys/${k.id}`);
                      setSaid(`"${k.name}" was revoked. Anything using it now gets 401s.`);
                    })}>
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {data.enabled && (
          <div className="rounded-lg border border-dashed border-line p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              New key
            </div>
            <input value={keyName} onChange={(e) => setKeyName(e.target.value)}
              placeholder="What is it for? e.g. “Nightly export to our ERP”"
              className="mb-3 w-full rounded-lg border border-line px-3 py-2 text-sm" />
            <div className="mb-3 flex flex-wrap gap-1.5">
              {data.scopes.map((sc) => (
                <button key={sc.key}
                  onClick={() => setKeyScopes(keyScopes.includes(sc.key)
                    ? keyScopes.filter((x) => x !== sc.key) : [...keyScopes, sc.key])}
                  title={sc.label}
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                    keyScopes.includes(sc.key)
                      ? 'border-brand-500 bg-brand-50 text-brand-800'
                      : 'border-line text-muted hover:border-slate-300'}`}>
                  {sc.key}
                </button>
              ))}
            </div>
            <Button icon={Plus} disabled={!keyName || !keyScopes.length || busy === 'newkey'}
              onClick={() => run('newkey', async () => {
                const made = await post<{ key: string; warning: string }>(
                  '/v1/developer/keys', { name: keyName, scopes: keyScopes });
                setMadeKey(made);
                setKeyName(''); setKeyScopes([]);
              })}>
              Create key
            </Button>
          </div>
        )}
      </Card>

      {madeHook && (
        <Card className="mb-6 border-emerald-300 bg-emerald-50">
          <SectionTitle icon={Webhook}>Your signing secret</SectionTitle>
          <div className="flex items-center gap-2 rounded-lg bg-white px-3 py-2">
            <code className="flex-1 break-all text-xs text-slate-800">{madeHook.secret}</code>
            <button onClick={() => copy(madeHook.secret, 'secret')}
              className="shrink-0 text-slate-500 hover:text-ink">
              {copied === 'secret' ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
          <p className="mt-2 text-sm text-emerald-900">{madeHook.warning}</p>
          <p className="mt-2 text-xs text-emerald-800">{madeHook.howToVerify}</p>
          <Button variant="ghost" onClick={() => setMadeHook(null)}>Done</Button>
        </Card>
      )}

      <SectionTitle icon={Webhook} note="Munim calls you">Webhooks</SectionTitle>
      <Card className="mb-6">
        {data.webhooks.length === 0 ? (
          <p className="mb-4 text-sm text-muted">Nothing set up.</p>
        ) : (
          <div className="mb-4">
            {data.webhooks.map((h) => (
              <div key={h.id} className="border-b border-slate-50 py-2.5 last:border-0">
                <div className="flex flex-wrap items-center gap-3">
                  <code className="min-w-[200px] flex-1 truncate text-xs text-slate-700">
                    {h.url}
                  </code>
                  <Badge tone={h.active ? 'ok' : 'bad'}>
                    {h.active ? 'On' : h.disabledAt ? 'Switched off after failures' : 'Off'}
                  </Badge>
                  <Button variant="ghost" icon={Play} disabled={busy === `t${h.id}`}
                    onClick={() => run(`t${h.id}`, async () => {
                      const r = await post<{ message: string }>(
                        `/v1/developer/webhooks/${h.id}/test`, {});
                      setSaid(r.message);
                    })}>
                    Test
                  </Button>
                  <Button variant="ghost"
                    onClick={() => run(`a${h.id}`, () =>
                      patch(`/v1/developer/webhooks/${h.id}`, { active: !h.active }))}>
                    {h.active ? 'Pause' : 'Resume'}
                  </Button>
                  <Button variant="ghost" icon={Trash2}
                    onClick={() => run(`d${h.id}`, () =>
                      del(`/v1/developer/webhooks/${h.id}`))}>
                    Remove
                  </Button>
                </div>
                <div className="mt-1 text-[11px] text-faint">
                  {h.events.join(', ')} · secret {h.secretHint}
                  {h.lastAt && ` · last ${ago(h.lastAt)} (${h.lastStatus ?? 'no answer'})`}
                  {h.failures > 0 && ` · ${h.failures} failures`}
                </div>
                {h.lastError && (
                  <div className="mt-0.5 text-[11px] text-rose-600">{h.lastError}</div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="rounded-lg border border-dashed border-line p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            New webhook
          </div>
          <input value={hookUrl} onChange={(e) => setHookUrl(e.target.value)}
            placeholder="https://your-server.example.com/munim"
            className="mb-3 w-full rounded-lg border border-line px-3 py-2 text-sm" />
          <div className="mb-3 flex flex-wrap gap-1.5">
            {data.events.map((ev) => (
              <button key={ev.key}
                onClick={() => setHookEvents(hookEvents.includes(ev.key)
                  ? hookEvents.filter((x) => x !== ev.key) : [...hookEvents, ev.key])}
                title={ev.label}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                  hookEvents.includes(ev.key)
                    ? 'border-brand-500 bg-brand-50 text-brand-800'
                    : 'border-line text-muted hover:border-slate-300'}`}>
                {ev.key}
              </button>
            ))}
          </div>
          <Button icon={Plus} disabled={!hookUrl || !hookEvents.length || busy === 'newhook'}
            onClick={() => run('newhook', async () => {
              const made = await post<{ secret: string; warning: string;
                                        howToVerify: string }>(
                '/v1/developer/webhooks', { url: hookUrl, events: hookEvents });
              setMadeHook(made);
              setHookUrl(''); setHookEvents([]);
            })}>
            Add webhook
          </Button>
        </div>
      </Card>

      <SectionTitle icon={Activity} note="last fifty">Recent calls</SectionTitle>
      <Card className="mb-6">
        {data.recentCalls.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <tbody>
                {data.recentCalls.map((c, i) => (
                  <tr key={i} className="border-b border-slate-50 last:border-0">
                    <td className="py-1.5 pr-3 text-xs text-muted">{ago(c.at)}</td>
                    <td className="py-1.5 pr-2 font-mono text-[11px] text-slate-500">
                      {c.method}
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-[11px] text-slate-700">
                      {c.path}
                    </td>
                    <td className={`py-1.5 pr-3 text-xs ${
                      c.status >= 400 ? 'text-rose-600' : 'text-emerald-700'}`}>
                      {c.status}
                    </td>
                    <td className="py-1.5 text-right text-xs text-muted">
                      {c.duration_ms}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs
                    text-slate-500">
        <Info size={13} className="mt-0.5 shrink-0" /> {data.note}
      </p>
    </>
  );
}

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </div>
      <div className={`mt-0.5 text-xl font-bold ${bad ? 'text-rose-600' : 'text-ink'}`}>
        {value}
      </div>
    </div>
  );
}
