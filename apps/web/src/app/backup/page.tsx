'use client';

import { useRef, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { get, post, patch, ago, type BackupList } from '../../lib/api';
import {
  Badge, Button, Card, Empty, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  Database, Download, Upload, ShieldCheck, AlertTriangle, Clock3, Info,
  HardDrive, RotateCcw, Check,
} from 'lucide-react';

/**
 * Backups of Munim's copy of the books.
 *
 * The boundary is stated at the top and repeated on every destructive action,
 * because "my accounting is backed up" is the belief this screen could most
 * easily and most expensively create. Munim never writes to Tally, so it
 * cannot restore into it either.
 */

const kb = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export default function BackupPage() {
  const { company } = useAuth();
  const list = useApi<BackupList>('/v1/backups', []);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function take(kind: 'full' | 'incremental') {
    if (!company) return;
    setBusy(kind); setMsg(null);
    try {
      const r = await post<{ backup: { sizeBytes: number }; note: string }>(
        `/v1/companies/${encodeURIComponent(company.tallyGuid)}/backup`, { kind });
      setMsg({ text: `Backup taken — ${kb(r.backup.sizeBytes)}. ${r.note}` });
      list.reload();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'Could not take a backup.', bad: true });
    } finally { setBusy(null); }
  }

  async function download(id: string, name: string) {
    setBusy(id);
    try {
      const r = await get<{ filename: string; archive: string }>(`/v1/backups/${id}/download`);
      const blob = new Blob([r.archive], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = r.filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'Could not download.', bad: true });
    } finally { setBusy(null); }
  }

  async function verify(id: string) {
    setBusy(id);
    try {
      const r = await get<{ ok: boolean; reason: string }>(`/v1/backups/${id}/verify`);
      setMsg({ text: r.reason, bad: !r.ok });
    } finally { setBusy(null); }
  }

  async function restore(body: Record<string, unknown>) {
    setBusy('restore'); setMsg(null);
    try {
      const r = await post<{ restored: Record<string, number>; note: string }>(
        '/v1/backups/restore', body);
      const total = Object.values(r.restored).reduce((n, x) => n + x, 0);
      setMsg({ text: `Restored ${total.toLocaleString('en-IN')} rows. ${r.note}` });
      setConfirmRestore(null);
      list.reload();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'Could not restore.', bad: true });
    } finally { setBusy(null); }
  }

  if (list.error) return <ErrorNote message={list.error} onRetry={list.reload} />;
  if (list.loading && !list.data) return <Spinner label="Loading your backups…" />;

  const settings = list.data?.settings;

  return (
    <>
      <PageTitle title="Backup" subtitle="A copy of what Munim holds, in a file you own." />

      {/* Said first, and said plainly. */}
      <div className="mb-5 flex items-start gap-2.5 rounded-lg bg-amber-50 px-4 py-3
                      text-sm ring-1 ring-amber-200">
        <AlertTriangle size={17} className="mt-0.5 shrink-0 text-amber-600" />
        <div className="text-amber-900">
          <b>This is not a Tally backup.</b> Munim reads your Tally and never writes to
          it, so this backs up Munim&apos;s copy and restores into Munim. Keep taking
          Tally&apos;s own backups as well — they are the ones your accountant needs.
        </div>
      </div>

      {msg && (
        <div className={`mb-4 rounded-lg px-4 py-3 text-sm ring-1 ${
          msg.bad ? 'bg-rose-50 text-rose-800 ring-rose-200'
                  : 'bg-emerald-50 text-emerald-900 ring-emerald-200'}`}>
          {msg.text}
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        <Button icon={Database} onClick={() => take('full')} disabled={!!busy || !company}>
          {busy === 'full' ? 'Taking…' : 'Take a full backup'}
        </Button>
        <Button variant="ghost" icon={Clock3} onClick={() => take('incremental')}
          disabled={!!busy || !company}>
          {busy === 'incremental' ? 'Taking…' : 'Only what changed'}
        </Button>
        <Button variant="ghost" icon={Upload} onClick={() => fileRef.current?.click()}
          disabled={!!busy}>
          Restore from a file
        </Button>
        <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            // Read here rather than posting the file: the archive is JSON and
            // the endpoint takes it as text, so there is no upload path to
            // build or secure.
            restore({ archive: await f.text() });
          }} />
      </div>

      <SectionTitle icon={HardDrive}>How often, and how many to keep</SectionTitle>
      <Card className="mb-6">
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <div className="mb-1.5 text-xs font-semibold text-slate-600">Automatic</div>
            <div className="flex gap-1.5">
              {['off', 'daily', 'weekly'].map((sch) => (
                <button key={sch}
                  onClick={async () => { await patch('/v1/backups/settings', { schedule: sch }); list.reload(); }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold capitalize transition ${
                    settings?.schedule === sch ? 'bg-brand-700 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                  {sch}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-xs font-semibold text-slate-600">Keep the last</div>
            <div className="flex gap-1.5">
              {[5, 10, 30].map((n) => (
                <button key={n}
                  onClick={async () => { await patch('/v1/backups/settings', { keep: n }); list.reload(); }}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    settings?.keep === n ? 'bg-brand-700 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                  {n}
                </button>
              ))}
            </div>
          </div>
          {settings?.lastAt && (
            <div className="text-xs text-slate-500">Last automatic backup {ago(settings.lastAt)}</div>
          )}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Automatic backups run when the connector next checks in — nothing in Munim
          runs on a timer of its own, and your data is only worth copying when your
          PC is on anyway.
        </p>
      </Card>

      <SectionTitle icon={Database}>History</SectionTitle>
      {!list.data?.backups.length ? (
        <Empty title="No backups yet" icon={Database}
          hint="Take one above. It takes a second and the file is yours." />
      ) : (
        <div className="space-y-2">
          {list.data.backups.map((b) => (
            <Card key={b.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{b.companyName}</span>
                    <Badge tone={b.kind === 'full' ? 'ok' : 'warn'}>
                      {b.kind === 'full' ? 'Full' : 'Changes only'}
                    </Badge>
                    {b.trigger === 'scheduled' && <Badge tone="ok">Automatic</Badge>}
                    {!b.available && <Badge tone="warn">File no longer kept</Badge>}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {ago(b.createdAt)}
                    {b.available && ` · ${kb(b.sizeBytes)} (from ${kb(b.rawBytes)})`}
                    {b.by && ` · ${b.by}`}
                  </div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    {Object.entries(b.counts)
                      .filter(([, n]) => n > 0)
                      .map(([k, n]) => `${n.toLocaleString('en-IN')} ${k.replace(/_/g, ' ')}`)
                      .join(' · ') || 'nothing in it'}
                  </div>
                </div>

                {b.available && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="ghost" icon={ShieldCheck} disabled={busy === b.id}
                      onClick={() => verify(b.id)}>Verify</Button>
                    <Button variant="ghost" icon={Download} disabled={busy === b.id}
                      onClick={() => download(b.id, b.companyName)}>Download</Button>
                    <Button variant="ghost" icon={RotateCcw} disabled={!!busy}
                      onClick={() => setConfirmRestore(b.id)}>Restore</Button>
                  </div>
                )}
              </div>

              {confirmRestore === b.id && (
                <div className="mt-3 rounded-lg bg-rose-50 p-3 ring-1 ring-rose-200">
                  <div className="flex items-center gap-2 text-sm font-semibold text-rose-900">
                    <AlertTriangle size={15} /> Restore this backup?
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-rose-800">
                    {b.kind === 'full'
                      ? <>A full restore <b>replaces</b> everything Munim holds for{' '}
                        {b.companyName} with what was in this backup. Anything synced since
                        will be gone until the connector fetches it again.</>
                      : <>This adds back only what had changed. Nothing is deleted.</>}
                    {' '}Your Tally file is not touched either way.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <Button variant="danger" icon={RotateCcw} disabled={busy === 'restore'}
                      onClick={() => restore({ backupId: b.id })}>
                      {busy === 'restore' ? 'Restoring…' : 'Yes, restore'}
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirmRestore(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <p className="mt-6 flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2
                    text-xs text-slate-500">
        <Info size={13} className="mt-0.5 shrink-0" />
        {list.data?.note} Every backup carries a checksum, and both download and
        restore refuse a file that does not match it.
      </p>
    </>
  );
}
