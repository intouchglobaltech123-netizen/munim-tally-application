'use client';

import { useMemo, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import type { CompanySummary } from '../../lib/api';
import { post } from '../../lib/api';
import { ago, shortDate, type CompanyCard } from '../../lib/api';
import CompanySettings from '../../components/CompanySettings';
import {
  Badge, Button, Card, Empty, ErrorNote, OfflineBar, PageTitle, Spinner,
} from '../../components/ui';
import {
  Building2, Search, Check, AlertCircle, Pause, Play, MapPin, Phone, Mail,
  Hash, FileText, Users, Package, Receipt, ArrowUpDown, Settings2, ChevronDown,
  Wifi, WifiOff,
} from 'lucide-react';

/**
 * Every book in the account, and whether each can be believed.
 *
 * A shop with four companies in Tally needs to answer two questions here:
 * which one am I looking at, and is it current. Both are on the card, because
 * discovering that a figure was three days stale after acting on it is the
 * failure this screen exists to prevent.
 */

const SORTS = [
  { key: 'name', label: 'Name' },
  { key: 'activity', label: 'Recently synced' },
  { key: 'size', label: 'Biggest' },
] as const;

type SortKey = (typeof SORTS)[number]['key'];

const TONE: Record<string, { badge: 'ok' | 'warn' | 'bad'; dot: string }> = {
  live: { badge: 'ok', dot: 'bg-emerald-500' },
  quiet: { badge: 'ok', dot: 'bg-emerald-400' },
  stale: { badge: 'bad', dot: 'bg-rose-500' },
  never: { badge: 'warn', dot: 'bg-amber-500' },
  paused: { badge: 'warn', dot: 'bg-slate-400' },
};

export default function CompaniesPage() {
  const { company, setCompanyGuid, refresh } = useAuth();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const [busy, setBusy] = useState<string | null>(null);
  const [openSettings, setOpenSettings] = useState<string | null>(null);

  const { data, error, loading, reload, stale, offline } =
    useApi<{ companies: CompanyCard[] }>('/v1/companies/all', []);

  // Whether the connector is alive is a property of the account, not of any one
  // book, so it is asked for once and shown above the list rather than
  // repeated on every card.
  const conn = useApi<CompanySummary>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/summary` : null,
    [company?.tallyGuid]);

  const shown = useMemo(() => {
    const all = data?.companies ?? [];
    const needle = q.trim().toLowerCase();
    // Search covers GSTIN too: an accountant handling several firms knows the
    // GSTIN more reliably than whatever the book was named in Tally.
    const hit = needle
      ? all.filter((c) =>
          c.profile.name.toLowerCase().includes(needle) ||
          c.profile.gstin.toLowerCase().includes(needle) ||
          c.profile.state.toLowerCase().includes(needle))
      : all;

    const by: Record<SortKey, (a: CompanyCard, b: CompanyCard) => number> = {
      name: (a, b) => a.profile.name.localeCompare(b.profile.name),
      activity: (a, b) =>
        new Date(b.lastSyncAt ?? 0).getTime() - new Date(a.lastSyncAt ?? 0).getTime(),
      size: (a, b) => b.counts.vouchers - a.counts.vouchers,
    };
    return [...hit].sort(by[sort]);
  }, [data, q, sort]);

  async function toggleSync(c: CompanyCard) {
    setBusy(c.tallyGuid);
    try {
      await post('/v1/companies/sync', { tallyGuid: c.tallyGuid, enabled: !c.enabled });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading && !data) return <Spinner label="Finding your books…" />;

  const all = data?.companies ?? [];
  if (all.length === 0) {
    return (
      <>
        <PageTitle title="Companies" subtitle="Every book Munim can see in your Tally." />
        <Empty title="No companies yet" icon={Building2}
          hint="Open a company in Tally and leave the connector running. It appears here on its own." />
      </>
    );
  }

  return (
    <>
      <PageTitle
        title="Companies"
        subtitle={`${all.length} ${all.length === 1 ? 'book' : 'books'} in your Tally.`}
      />
      <OfflineBar offline={offline} ageMs={stale} />
      {conn.data && <ConnectionBar c={conn.data.connection} />}

      {all.length > 3 && (
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, GSTIN or state"
              className="w-full rounded-lg border border-line py-2 pl-9 pr-3 text-sm
                         outline-none focus:border-brand-500" />
          </div>
          <div className="flex items-center gap-1.5">
            <ArrowUpDown size={14} className="text-slate-400" />
            {SORTS.map((sOpt) => (
              <button key={sOpt.key} onClick={() => setSort(sOpt.key)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                  sort === sOpt.key ? 'bg-slate-800 text-white'
                                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                {sOpt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <Empty title="Nothing matches" icon={Search} hint={`No book matches "${q}".`} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {shown.map((c) => (
            <CompanyBlock key={c.tallyGuid} c={c}
              current={company?.tallyGuid === c.tallyGuid}
              busy={busy === c.tallyGuid}
              onOpen={() => { setCompanyGuid(c.tallyGuid); refresh(); }}
              onToggle={() => toggleSync(c)}
              settingsOpen={openSettings === c.tallyGuid}
              onSettings={() => setOpenSettings(
                openSettings === c.tallyGuid ? null : c.tallyGuid)}
              onChanged={reload}
              onRemoved={() => { setOpenSettings(null); reload(); refresh(); }} />
          ))}
        </div>
      )}
    </>
  );
}

function CompanyBlock({
  c, current, busy, onOpen, onToggle, settingsOpen, onSettings, onChanged, onRemoved,
}: {
  c: CompanyCard; current: boolean; busy: boolean;
  onOpen: () => void; onToggle: () => void;
  settingsOpen: boolean; onSettings: () => void;
  onChanged: () => void; onRemoved: () => void;
}) {
  const tone = TONE[c.health.state] ?? TONE.paused;
  const p = c.profile;

  return (
    <Card className={current ? 'ring-2 ring-brand-500' : ''}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
            <h3 className="truncate text-base font-bold text-slate-900">{p.name}</h3>
            {current && <Badge tone="ok">Open</Badge>}
          </div>
          {p.formalName !== p.name && (
            <div className="mt-0.5 truncate text-xs text-slate-500">{p.formalName}</div>
          )}
        </div>
        <Badge tone={tone.badge}>{c.health.label}</Badge>
      </div>

      <p className="mt-2 text-xs text-slate-500">
        {c.health.hint}
        {c.lastSyncAt && ` Last sync ${ago(c.lastSyncAt)}.`}
      </p>

      {/* Identity, only what Tally actually has. Empty rows are omitted rather
          than shown blank - a row reading "GSTIN —" looks like a fault. */}
      {(p.address || p.gstin || p.phone || p.email) && (
        <div className="mt-4 space-y-1.5 border-t border-slate-100 pt-3 text-xs text-slate-600">
          {p.address && <Field icon={MapPin}>{[p.address, p.state, p.pincode].filter(Boolean).join(', ')}</Field>}
          {p.gstin && <Field icon={Hash}><span className="font-mono">{p.gstin}</span></Field>}
          {p.phone && <Field icon={Phone}>{p.phone}</Field>}
          {p.email && <Field icon={Mail}>{p.email}</Field>}
        </div>
      )}

      <div className="mt-4 grid grid-cols-4 gap-2 border-t border-slate-100 pt-3">
        <Count icon={Receipt} n={c.counts.vouchers} label="vouchers" />
        <Count icon={Users} n={c.counts.customers} label="customers" />
        <Count icon={FileText} n={c.counts.ledgers} label="ledgers" />
        <Count icon={Package} n={c.counts.items} label="items" />
      </div>

      {c.completeness.missing.length > 0 && (
        <div className="mt-4 rounded-lg bg-amber-50 p-3 ring-1 ring-amber-200">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800">
            <AlertCircle size={13} />
            Missing from Tally: {c.completeness.missing.map((m) => m.label).join(', ')}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-amber-700">
            {c.completeness.missing[0].why} {c.completeness.fixHint}
          </p>
        </div>
      )}

      {p.fyStart && (
        <p className="mt-3 text-xs text-slate-400">
          Financial year from {shortDate(p.fyStart)}
          {p.fyEnd ? ` to ${shortDate(p.fyEnd)}` : ''}
          {p.booksFrom && p.booksFrom !== p.fyStart ? ` · books from ${shortDate(p.booksFrom)}` : ''}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button onClick={onOpen} variant={current ? "ghost" : "primary"}
          icon={current ? Check : Building2}>
          {current ? 'Currently open' : 'Open this book'}
        </Button>
        <Button onClick={onToggle} variant="ghost" icon={c.enabled ? Pause : Play}>
          {busy ? '…' : c.enabled ? 'Pause sync' : 'Resume sync'}
        </Button>
        <Button onClick={onSettings} variant="ghost" icon={settingsOpen ? ChevronDown : Settings2}>
          Settings
        </Button>
      </div>

      {settingsOpen && (
        <div className="mt-4">
          <CompanySettings c={c} onChanged={onChanged} onRemoved={onRemoved} />
        </div>
      )}
    </Card>
  );
}

function Field({ icon: Icon, children }: {
  icon: typeof MapPin; children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon size={13} className="mt-0.5 shrink-0 text-slate-400" />
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function Count({ icon: Icon, n, label }: { icon: typeof Users; n: number; label: string }) {
  return (
    <div className="text-center">
      <Icon size={13} className="mx-auto text-slate-400" />
      <div className="mt-1 text-sm font-bold tabular-nums text-slate-800">
        {n.toLocaleString('en-IN')}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
    </div>
  );
}


/**
 * Whether the computer running Tally is actually reachable.
 *
 * Separate from each book's sync status, because the fixes are different: a
 * stale book with a live connector means Tally is closed, and a live book with
 * a dead connector is impossible. Saying which one is wrong saves the support
 * call.
 */
function ConnectionBar({ c }: { c: CompanySummary['connection'] }) {
  const good = c.online && c.tallyUp && c.queuedBatches === 0;
  const tone = good
    ? 'bg-emerald-50 text-emerald-800 ring-emerald-200'
    : c.online
      ? 'bg-amber-50 text-amber-800 ring-amber-200'
      : 'bg-rose-50 text-rose-800 ring-rose-200';

  return (
    <div className={`mb-5 flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-sm ring-1 ${tone}`}>
      {c.online ? <Wifi size={16} className="mt-0.5 shrink-0" />
                : <WifiOff size={16} className="mt-0.5 shrink-0" />}
      <div className="min-w-0">
        <span className="font-semibold">{c.label}</span>
        {c.machineName ? <span className="opacity-70"> · {c.machineName}</span> : null}
        <div className="mt-0.5 text-xs opacity-90">{c.hint}</div>
        {c.lastError ? (
          <div className="mt-1 font-mono text-xs opacity-75">{c.lastError}</div>
        ) : null}
      </div>
    </div>
  );
}
