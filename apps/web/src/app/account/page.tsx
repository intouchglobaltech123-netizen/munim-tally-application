'use client';

import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { get, post, put, shortDate, type AccountStatus, type UsersPayload } from '../../lib/api';
import {
  Badge, Button, Card, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  LifeBuoy, Users2, Download, Trash2, AlertTriangle, ShieldCheck, Info,
  ArrowRightLeft, CheckCircle2,
} from 'lucide-react';

/**
 * The end of the relationship, and the way back into it.
 *
 * Everything on this page is about the moment the person holding the account is
 * no longer the person who should hold it: a shop changes hands, an owner loses
 * their phone, somebody taps delete on a Friday evening. None of that is rare
 * over the life of a business.
 */
export default function AccountPage() {
  const st = useApi<AccountStatus>('/v1/account', []);
  const people = useApi<UsersPayload>("/v1/users", []);

  const [email, setEmail] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [handTo, setHandTo] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reason, setReason] = useState('');
  const [showDanger, setShowDanger] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const data = st.data;
  const recoveryEmail = email ?? data?.recovery.email ?? '';
  const recoveryPhone = phone ?? data?.recovery.phone ?? '';

  async function run(key: string, fn: () => Promise<{ message?: string }>) {
    setBusy(key); setErr(null); setSaid(null);
    try {
      const r = await fn();
      setSaid(r?.message ?? 'Done.');
      st.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not do that.');
    } finally { setBusy(null); }
  }

  async function exportAll() {
    setBusy('export'); setErr(null);
    try {
      const r = await get<{ filename: string; archive: string }>('/v1/account/export');
      const blob = new Blob([r.archive], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = r.filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setSaid('Downloaded.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not export.');
    } finally { setBusy(null); }
  }

  if (st.error) return <ErrorNote message={st.error} onRetry={st.reload} />;
  if (!data) return <Spinner label="Loading your account…" />;

  return (
    <>
      <PageTitle title="Account"
        subtitle="Who owns this business in Munim, and how to get back in." />

      {said && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2
                        text-sm text-emerald-800">
          <CheckCircle2 size={15} /> {said}
        </div>
      )}
      {err && (
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2
                        text-sm text-rose-800">
          <AlertTriangle size={15} /> {err}
        </div>
      )}

      {/* A pending deletion outranks everything else on the page. */}
      {data.deletion && (
        <Card className="mb-6 border-rose-200 bg-rose-50">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-rose-600" />
            <div className="flex-1">
              <div className="font-semibold text-rose-900">
                This account is scheduled for deletion in {data.deletion.daysLeft} day
                {data.deletion.daysLeft === 1 ? '' : 's'}
              </div>
              <p className="mt-1 text-sm text-rose-800">{data.deletion.note}</p>
              <p className="mt-1 text-xs text-rose-700">
                Asked for by {data.deletion.requestedBy} on{' '}
                {shortDate(data.deletion.requestedAt)}
                {data.deletion.reason ? ` — “${data.deletion.reason}”` : ''}
              </p>
              <div className="mt-3 flex gap-2">
                <Button onClick={() => run('cancel',
                  () => post('/v1/account/delete/cancel', {}))}
                  disabled={busy === 'cancel'}>
                  Keep this account
                </Button>
                <Button variant="ghost" icon={Download} onClick={exportAll}
                  disabled={busy === 'export'}>
                  Download everything first
                </Button>
              </div>
            </div>
          </div>
        </Card>
      )}

      <SectionTitle icon={ShieldCheck} note="what protects this account">Safety</SectionTitle>
      <Card className="mb-6">
        <Row label="Sign-in" value="Google only — no password to lose or leak" ok />
        <Row label="Backups"
          value={data.encryptionAtRest
            ? 'Encrypted at rest, with a key held outside the database'
            : 'NOT encrypted — this server has no encryption key set'}
          ok={data.encryptionAtRest} />
        <Row label="Owners"
          value={`${data.owners.length} ${data.owners.length === 1 ? 'person' : 'people'} can change settings and close this account`}
          ok={!data.soleOwner} />
      </Card>

      {data.soleOwner && (
        <Card className="mb-6 border-amber-200 bg-amber-50">
          <div className="flex items-start gap-2 text-sm text-amber-900">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{data.soleOwnerWarning}</span>
          </div>
        </Card>
      )}

      <SectionTitle icon={LifeBuoy} note="not a second login">Recovery contact</SectionTitle>
      <Card className="mb-6">
        <p className="mb-3 text-sm text-muted">{data.recovery.note}</p>
        <div className="flex flex-wrap gap-3">
          <input value={recoveryEmail} onChange={(e) => setEmail(e.target.value)}
            placeholder="Another email address"
            className="min-w-[220px] flex-1 rounded-lg border border-line px-3 py-2 text-sm" />
          <input value={recoveryPhone} onChange={(e) => setPhone(e.target.value)}
            placeholder="Another phone number"
            className="min-w-[180px] rounded-lg border border-line px-3 py-2 text-sm" />
          <Button disabled={busy === 'recovery'}
            onClick={() => run('recovery', () =>
              put('/v1/account/recovery', { email: recoveryEmail, phone: recoveryPhone }))}>
            Save
          </Button>
        </div>
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted">
          <Info size={12} className="mt-0.5 shrink-0" />
          Use an address on a different Google account to the one you sign in with.
          If that account is the one you lose, a recovery address inside it cannot help.
        </p>
      </Card>

      <SectionTitle icon={Users2} note="who can close this account">Owners</SectionTitle>
      <Card className="mb-6">
        {data.owners.map((o) => (
          <div key={o.id} className="flex items-center justify-between border-b border-slate-50
                                     py-2 last:border-0">
            <div>
              <div className="text-sm font-medium text-ink">{o.name || o.email}</div>
              <div className="text-xs text-muted">{o.email}</div>
            </div>
            <Badge tone="ok">Owner</Badge>
          </div>
        ))}
      </Card>

      <SectionTitle icon={ArrowRightLeft} note="when the shop changes hands">
        Hand this business over
      </SectionTitle>
      <Card className="mb-6">
        {data.transfer ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <span className="font-medium text-ink">{data.transfer.to}</span>
              <span className="text-muted"> has been offered this business. Nothing
                changes until they accept. The offer lapses{' '}
                {shortDate(data.transfer.expiresAt)}.</span>
            </div>
            <Button variant="ghost"
              onClick={() => run('cancelT', () =>
                post(`/v1/account/transfer/${data.transfer!.id}/cancel`, {}))}>
              Call it off
            </Button>
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted">
              They have to accept before anything changes, and you stay an owner
              afterwards — handing over is not the same as stepping out.
            </p>
            <div className="flex flex-wrap gap-3">
              <select value={handTo} onChange={(e) => setHandTo(e.target.value)}
                className="min-w-[220px] flex-1 rounded-lg border border-line px-3 py-2 text-sm">
                <option value="">Choose somebody in this account…</option>
                {(people.data?.users ?? [])
                  // Owners are excluded because handing the business to somebody
                  // who already owns it changes nothing.
                  .filter((u) => u.roleKey !== 'owner' && u.status !== 'disabled')
                  .map((u) => (
                    <option key={u.id} value={u.id}>{u.name || u.email}</option>
                  ))}
              </select>
              <Button disabled={!handTo || busy === 'hand'}
                onClick={() => run('hand', () =>
                  post('/v1/account/transfer', { userId: handTo }))}>
                Offer it
              </Button>
            </div>
          </>
        )}
      </Card>

      <SectionTitle icon={Download} note="everything, in one file">Export</SectionTitle>
      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            Every company, every voucher, every person and the audit log. Yours to
            keep, whatever happens to this account.
          </p>
          <Button variant="ghost" icon={Download} onClick={exportAll}
            disabled={busy === 'export'}>
            {busy === 'export' ? 'Preparing…' : 'Download'}
          </Button>
        </div>
      </Card>

      {!data.deletion && (
        <>
          <SectionTitle icon={Trash2} note="there is a way back for 30 days">
            Close this account
          </SectionTitle>
          <Card className="border-rose-100">
            {!showDanger ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted">
                  Deletes everything Munim holds. Your Tally company files are
                  separate and are never touched.
                </p>
                <Button variant="ghost" onClick={() => setShowDanger(true)}>
                  I want to close it
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-ink">
                  Nothing is deleted straight away. Everything stays for 30 days and
                  any owner can call it off — download an export before then.
                </p>
                <input value={reason} onChange={(e) => setReason(e.target.value)}
                  placeholder="Why are you leaving? (optional, and it helps us)"
                  className="w-full rounded-lg border border-line px-3 py-2 text-sm" />
                <input value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Type the business name to confirm"
                  className="w-full rounded-lg border border-rose-200 px-3 py-2 text-sm" />
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => { setShowDanger(false); setConfirm(''); }}>
                    Cancel
                  </Button>
                  <button
                    disabled={!confirm || busy === 'delete'}
                    onClick={() => run('delete', () =>
                      post('/v1/account/delete', { confirm, reason }))}
                    className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold
                               text-white hover:bg-rose-700 disabled:opacity-40">
                    Schedule deletion
                  </button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-50 py-2.5
                    last:border-0">
      <span className="text-sm text-muted">{label}</span>
      <span className={`text-right text-sm ${ok ? 'text-ink' : 'font-medium text-amber-700'}`}>
        {value}
      </span>
    </div>
  );
}
