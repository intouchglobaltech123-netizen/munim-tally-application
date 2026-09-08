'use client';

import { useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import {
  post, patch, del, ago,
  type UsersPayload, type RolesPayload, type OrgUser, type Role,
} from '../../lib/api';
import {
  Badge, Button, Card, Empty, ErrorNote, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';
import {
  Users, UserPlus, Shield, Mail, Ban, Check, Trash2, Smartphone,
  Info, X, Pencil,
} from 'lucide-react';

/**
 * Who else may see the books.
 *
 * Sign-in is Google-only, so nobody is handed a password - there is none to
 * hand. Somebody is invited by the address they sign in with, and whoever
 * proves to Google they own it becomes that person.
 */

export default function UsersPage() {
  const { me } = useAuth();
  const list = useApi<UsersPayload>('/v1/users', []);
  const roles = useApi<RolesPayload>('/v1/roles', []);

  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleKey, setRoleKey] = useState('employee');
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<Role | null>(null);

  const canManage = me?.permissions?.users?.create ?? false;

  async function doInvite() {
    setBusy('invite'); setErr(null); setSaid(null);
    try {
      const r = await post<{ note: string }>('/v1/users/invite', { email, name, roleKey });
      setSaid(r.note);
      setEmail(''); setName(''); setInviting(false);
      list.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send that invitation.');
    } finally { setBusy(null); }
  }

  async function act(fn: () => Promise<unknown>, key: string) {
    setBusy(key); setErr(null); setSaid(null);
    try {
      const r = await fn() as { note?: string };
      if (r?.note) setSaid(r.note);
      list.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.');
    } finally { setBusy(null); }
  }

  if (list.error) return <ErrorNote message={list.error} onRetry={list.reload} />;
  if (list.loading && !list.data) return <Spinner label="Loading your team…" />;

  const rolesById = new Map((roles.data?.roles ?? []).map((r) => [r.key, r]));

  return (
    <>
      <PageTitle
        title="Users & roles"
        subtitle="Who can see your books, and exactly how much of them."
        right={canManage ? (
          <Button icon={UserPlus} onClick={() => setInviting(!inviting)}>Invite someone</Button>
        ) : undefined}
      />

      {err && (
        <div className="mb-4 rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-200">
          {err}
        </div>
      )}
      {said && (
        <div className="mb-4 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
          {said}
        </div>
      )}

      {inviting && (
        <Card className="mb-6">
          <SectionTitle icon={Mail}>Invite by Google address</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="text-xs font-semibold text-slate-600">Google email</label>
              <input value={email} onChange={(e) => setEmail(e.target.value)}
                placeholder="accountant@gmail.com" type="email"
                className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm
                           outline-none focus:border-brand-500" />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600">Name (optional)</label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm
                           outline-none focus:border-brand-500" />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-600">Role</label>
              <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)}
                className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm
                           outline-none focus:border-brand-500">
                {(roles.data?.roles ?? []).filter((r) => r.key !== 'owner').map((r) => (
                  <option key={r.key} value={r.key}>{r.name}</option>
                ))}
              </select>
            </div>
          </div>
          {rolesById.get(roleKey) && (
            <p className="mt-2 text-xs text-slate-500">{rolesById.get(roleKey)!.description}</p>
          )}
          <div className="mt-4 flex gap-2">
            <Button icon={UserPlus} onClick={doInvite} disabled={busy === 'invite' || !email}>
              {busy === 'invite' ? 'Inviting…' : 'Send invitation'}
            </Button>
            <Button variant="ghost" onClick={() => setInviting(false)}>Cancel</Button>
          </div>
          {/* No email is sent - sending costs money and needs a domain. */}
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-brand-50 px-3 py-2
                        text-xs leading-relaxed text-brand-900">
            <Info size={13} className="mt-0.5 shrink-0" />
            Munim does not send an email. Tell them to sign in with that Google
            account and they will land straight in your books.
          </p>
        </Card>
      )}

      <SectionTitle icon={Users}>
        People ({(list.data?.users.length ?? 0) + (list.data?.invites.length ?? 0)})
      </SectionTitle>
      <div className="space-y-3">
        {list.data?.users.map((u) => (
          <PersonCard key={u.id} u={u} roles={roles.data?.roles ?? []}
            canManage={canManage} busy={busy}
            isSelf={u.id === me?.user.id}
            onRole={(rk) => act(() => patch(`/v1/users/${u.id}`, { roleKey: rk }), u.id)}
            onStatus={(st) => act(() => post(`/v1/users/${u.id}/status`, { status: st }), u.id)}
            onDelete={() => act(() => del(`/v1/users/${u.id}`), u.id)}
            onField={(f, v) => act(() => patch(`/v1/users/${u.id}`, { [f]: v }), u.id)} />
        ))}

        {list.data?.invites.map((i) => (
          <Card key={i.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-800">{i.name || i.email}</span>
                  <Badge tone="warn">Invited</Badge>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {i.email} · {i.roleName} · invited {ago(i.invitedAt)}
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  Waiting for them to sign in with Google.
                </div>
              </div>
              {canManage && (
                <Button variant="ghost" icon={X} disabled={busy === i.id}
                  onClick={() => act(() => del(`/v1/invites/${i.id}`), i.id)}>
                  Cancel
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      <SectionTitle icon={Shield} note="what each role can see">Roles</SectionTitle>
      {roles.loading && !roles.data ? <Spinner /> : (
        <div className="grid gap-3 md:grid-cols-2">
          {(roles.data?.roles ?? []).map((r) => (
            <RoleCard key={r.id} r={r} catalogue={roles.data!.catalogue}
              onEdit={() => setEditing(r)} canManage={canManage} />
          ))}
        </div>
      )}

      {editing && roles.data && (
        <RoleEditor role={editing} catalogue={roles.data.catalogue}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); roles.reload(); }} />
      )}
    </>
  );
}

function PersonCard({ u, roles, canManage, busy, isSelf, onRole, onStatus, onDelete, onField }: {
  u: OrgUser; roles: Role[]; canManage: boolean; busy: string | null; isSelf: boolean;
  onRole: (k: string) => void; onStatus: (s: string) => void; onDelete: () => void;
  onField: (f: string, v: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const isOwner = u.roleName === 'Owner';
  const disabled = u.status === 'disabled';

  return (
    <Card className={disabled ? 'opacity-60' : ''}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-900">{u.name || u.email}</span>
            {isSelf && <Badge tone="ok">You</Badge>}
            {isOwner && <Badge tone="ok">Owner</Badge>}
            {disabled && <Badge tone="bad">Disabled</Badge>}
            {u.isSalesperson && <Badge tone="warn">Salesperson</Badge>}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {u.email}
            {u.branch && ` · ${u.branch}`}
            {u.lastSeenAt ? ` · seen ${ago(u.lastSeenAt)}` : ' · never signed in'}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-400">
            <Smartphone size={12} />
            {u.activeDevices} device{u.activeDevices === 1 ? '' : 's'}
            {u.deviceLimit > 0 && ` (limit ${u.deviceLimit})`}
            {u.companies.length > 0
              ? ` · ${u.companies.length} book(s)`
              : ' · all books'}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canManage && !isOwner ? (
            <select value={u.roleKey ?? ''} disabled={busy === u.id}
              onChange={(e) => onRole(e.target.value)}
              className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold
                         outline-none focus:border-brand-500">
              {roles.filter((r) => r.key !== 'owner').map((r) => (
                <option key={r.key} value={r.key}>{r.name}</option>
              ))}
            </select>
          ) : (
            <Badge tone="ok">{u.roleName}</Badge>
          )}

          {canManage && !isOwner && !isSelf && (
            <>
              <Button variant="ghost" icon={disabled ? Check : Ban} disabled={busy === u.id}
                onClick={() => onStatus(disabled ? 'active' : 'disabled')}>
                {disabled ? 'Enable' : 'Disable'}
              </Button>
              <Button variant="ghost" icon={Pencil} onClick={() => setOpen(!open)}>More</Button>
            </>
          )}
        </div>
      </div>

      {open && canManage && (
        <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-3">
          <Field label="Branch" value={u.branch}
            onSave={(v) => onField('branch', v)} placeholder="Ranipet" />
          <Field label="Salesperson name in Tally" value={u.salespersonName}
            onSave={(v) => onField('salespersonName', v)} placeholder="R. Kumar" />
          <Field label="Device limit (0 = plan default)" value={String(u.deviceLimit)}
            onSave={(v) => onField('deviceLimit', Number(v) || 0)} placeholder="0" />
          <div className="sm:col-span-3">
            {/* Deleting throws away which person did what, which is exactly
                what an audit trail exists to preserve. */}
            <Button variant="danger" icon={Trash2} disabled={busy === u.id} onClick={onDelete}>
              Remove from account
            </Button>
            <span className="ml-2 text-xs text-slate-500">
              Disabling is usually better — it keeps their history.
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

function Field({ label, value, onSave, placeholder }: {
  label: string; value: string; onSave: (v: string) => void; placeholder?: string;
}) {
  const [v, setV] = useState(value);
  return (
    <div>
      <label className="text-xs font-semibold text-slate-600">{label}</label>
      <div className="mt-1 flex gap-1.5">
        <input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder}
          className="min-w-0 flex-1 rounded-lg border border-line px-2.5 py-1.5 text-sm
                     outline-none focus:border-brand-500" />
        {v !== value && (
          <Button variant="ghost" onClick={() => onSave(v)}>Save</Button>
        )}
      </div>
    </div>
  );
}

function RoleCard({ r, catalogue, onEdit, canManage }: {
  r: Role; catalogue: RolesPayload['catalogue']; onEdit: () => void; canManage: boolean;
}) {
  const granted = Object.keys(r.permissions);
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-900">{r.name}</span>
            {r.builtIn && <Badge tone="ok">Built in</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-slate-500">{r.description}</p>
        </div>
        {canManage && r.key !== 'owner' && (
          <Button variant="ghost" icon={Pencil} onClick={onEdit}>Edit</Button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1">
        {granted.length === 0 ? (
          <span className="text-xs text-slate-400">No access to anything yet.</span>
        ) : granted.map((m) => (
          <span key={m} className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
            {catalogue.modules[m]?.label ?? m}
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-slate-400">
        {r.users} {r.users === 1 ? 'person' : 'people'}
      </p>
    </Card>
  );
}

/** The permission grid. Modules down, actions across. */
function RoleEditor({ role, catalogue, onClose, onSaved }: {
  role: Role; catalogue: RolesPayload['catalogue'];
  onClose: () => void; onSaved: () => void;
}) {
  const [perms, setPerms] = useState<Record<string, string[]>>(role.permissions);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggle(mod: string, act: string) {
    setPerms((p) => {
      const have = p[mod] ?? [];
      const next = have.includes(act) ? have.filter((a) => a !== act) : [...have, act];
      const out = { ...p };
      // Dropping the module entirely rather than leaving an empty list: those
      // two states mean the same thing, so only one of them should exist.
      if (next.length) out[mod] = next; else delete out[mod];
      // Turning off "view" turns off everything - the rest are meaningless
      // without it, and leaving them on suggests access that does not work.
      if (act === 'read' && !next.includes('read')) delete out[mod];
      return out;
    });
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      await patch(`/v1/roles/${role.id}`, { permissions: perms });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save.');
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto
                    bg-slate-900/40 p-4 sm:p-8">
      <Card className="w-full max-w-4xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-900">{role.name}</h2>
            <p className="text-xs text-slate-500">{role.description}</p>
          </div>
          <Button variant="ghost" icon={X} onClick={onClose}>Close</Button>
        </div>

        {err && <p className="mt-3 text-sm text-rose-600">{err}</p>}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="pb-2 pr-3 text-left text-xs font-semibold uppercase
                               tracking-wide text-slate-400">Section</th>
                {Object.entries(catalogue.actions).map(([k, a]) => (
                  <th key={k} title={a.hint}
                    className="pb-2 px-1.5 text-center text-xs font-semibold text-slate-500">
                    {a.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(catalogue.modules).map(([mk, m]) => (
                <tr key={mk} className="border-b border-slate-50 last:border-0">
                  <td className="py-2 pr-3">
                    <div className="text-sm font-medium text-slate-800">{m.label}</div>
                    <div className="text-[11px] text-slate-400">{m.hint}</div>
                  </td>
                  {Object.keys(catalogue.actions).map((ak) => {
                    const on = (perms[mk] ?? []).includes(ak);
                    const canView = (perms[mk] ?? []).includes('read');
                    return (
                      <td key={ak} className="px-1.5 py-2 text-center">
                        <button onClick={() => toggle(mk, ak)}
                          disabled={ak !== 'read' && !canView}
                          className={`h-6 w-6 rounded border transition disabled:opacity-25 ${
                            on ? 'border-brand-600 bg-brand-600 text-white'
                               : 'border-slate-300 hover:border-brand-400'}`}>
                          {on && <Check size={13} className="mx-auto" />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 flex gap-2">
          <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save role'}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </Card>
    </div>
  );
}
