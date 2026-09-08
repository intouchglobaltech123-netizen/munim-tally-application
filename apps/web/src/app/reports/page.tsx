'use client';

import { useState } from 'react';
import { Scale, Star } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useFavourites } from '../../lib/favourites';
import ReportToolbar from '../../components/ReportToolbar';
import type { Column } from '../../lib/csv';
import type { ViewConfig } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useMoney } from '../../lib/money';
import {
  inr, shortDate, type TrialBalance, type Pnl, type BalanceSheet, type DayBook,
  type SalesAnalysis, type Inactive, type Stock, type PartyWise, type Expenses,
} from '../../lib/api';
import {
  Badge, Card, Empty, ErrorNote, OfflineBar, PageTitle, SectionTitle, Spinner,
} from '../../components/ui';

// The report set a Tally-on-mobile product is expected to have: the accounting
// statements an accountant asks for, plus the analysis an owner actually opens.
const REPORTS = [
  { slug: 'daybook',        label: 'Day Book',        cat: 'Accounting', hint: "Everything posted on one day" },
  { slug: 'trial-balance',  label: 'Trial Balance',   cat: 'Accounting', hint: 'Group-wise, must balance' },
  { slug: 'pnl',            label: 'Profit & Loss',   cat: 'Accounting', hint: 'Income less expenses' },
  { slug: 'balance-sheet',  label: 'Balance Sheet',   cat: 'Accounting', hint: 'Assets against liabilities' },
  { slug: 'group-summary',  label: 'Group Summary',   cat: 'Accounting', hint: 'The account tree, rolled up' },
  { slug: 'expenses',       label: 'Expenses',        cat: 'Accounting', hint: 'Largest first' },

  { slug: 'cash-book',      label: 'Cash Book',       cat: 'Cash & bank', hint: 'Every cash movement, with a running balance' },
  { slug: 'bank-book',      label: 'Bank Book',       cat: 'Cash & bank', hint: 'Every bank movement, with a running balance' },

  { slug: 'sales-register',    label: 'Sales Register',    cat: 'Sales & purchase', hint: 'Every invoice with its tax columns' },
  { slug: 'purchase-register', label: 'Purchase Register', cat: 'Sales & purchase', hint: 'Every bill with its tax columns' },
  { slug: 'sales-analysis', label: 'Sales Analysis',  cat: 'Sales & purchase', hint: 'By month, party or item' },
  { slug: 'party-wise',     label: 'Party-wise',      cat: 'Sales & purchase', hint: 'Sales and purchases per party' },

  { slug: 'due-soon',       label: 'Due Soon',        cat: 'Outstanding', hint: 'Today, this week, this month' },
  { slug: 'inactive',       label: 'Inactive',        cat: 'Outstanding', hint: 'Customers and items gone quiet' },

  { slug: 'stock',          label: 'Stock Summary',   cat: 'Stock', hint: 'Quantity and value on hand' },
  { slug: 'expiry',         label: 'Expiry',          cat: 'Stock', hint: 'Batches going out of date' },
] as const;

/** Fixed order, so the groups do not shuffle as reports are added. */
const CATEGORIES = ['Accounting', 'Cash & bank', 'Sales & purchase',
                    'Outstanding', 'Stock'] as const;


type Slug = (typeof REPORTS)[number]['slug'];

export default function ReportsPage() {
  const { company } = useAuth();
  const [slug, setSlug] = useState<Slug>('trial-balance');
  const [groupBy, setGroupBy] = useState<'month' | 'party' | 'item'>('month');
  const [days, setDays] = useState(90);
  const { isFav, toggle, ready } = useFavourites();
  // The arrangement of whichever report is open. Saved views load into this.
  const [view, setView] = useState<ViewConfig>({});
  const pinned = REPORTS.filter((r) => ready && isFav(r.slug));

  const qs = slug === 'sales-analysis' ? `?groupBy=${groupBy}`
    : slug === 'inactive' ? `?days=${days}` : '';

  const { data, error, loading, reload, stale, offline } = useApi<unknown>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/${slug}${qs}` : null,
    [company?.tallyGuid, slug, groupBy, days],
  );

  if (!company) return <Empty title="No company yet" hint="Connect Tally to see reports." />;

  return (
    <>
      <PageTitle title="Reports" subtitle="Straight from your Tally books." />
      <OfflineBar offline={offline} ageMs={stale} />

      {/*
        * Tabs, not cards.
        *
        * Nine two-line buttons took a third of the screen before a single
        * figure appeared - and the hints ("debit equals credit") explain a
        * report nobody is reading yet. One line each, wrapping, so the report
        * itself starts near the top.
        */}
      {/*
        * Grouped tabs with pinning.
        *
        * Nine flat buttons made every report look equally likely, when in
        * practice a shop opens two of them daily and the rest at month end.
        * Pins float those two to the top; the categories keep the remainder
        * findable instead of merely present.
        */}
      <div className="mb-6 space-y-3 border-b border-line pb-4">
        {ready && pinned.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-amber-600">
              <Star size={12} className="fill-amber-400 text-amber-500" /> Pinned
            </span>
            {pinned.map((r) => (
              <Tab key={r.slug} r={r} active={slug === r.slug} fav
                onPick={() => setSlug(r.slug)} onToggle={() => toggle(r.slug)} />
            ))}
          </div>
        )}
        {CATEGORIES.map((cat) => {
          const inCat = REPORTS.filter((r) => r.cat === cat);
          if (!inCat.length) return null;
          return (
            <div key={cat} className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 w-28 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {cat}
              </span>
              {inCat.map((r) => (
                <Tab key={r.slug} r={r} active={slug === r.slug} fav={ready && isFav(r.slug)}
                  onPick={() => setSlug(r.slug)} onToggle={() => toggle(r.slug)} />
              ))}
            </div>
          );
        })}
      </div>

      {slug === 'sales-analysis' ? (
        <div className="mb-4 inline-flex overflow-hidden rounded-lg border border-line">
          {(['month', 'party', 'item'] as const).map((g) => (
            <button key={g} onClick={() => setGroupBy(g)}
              className={`px-4 py-2 text-sm font-semibold capitalize ${
                groupBy === g ? 'bg-brand-700 text-white' : 'bg-white hover:bg-canvas'}`}>
              {g}
            </button>
          ))}
        </div>
      ) : null}

      {slug === 'inactive' ? (
        <div className="mb-4 inline-flex overflow-hidden rounded-lg border border-line">
          {[30, 60, 90, 180].map((d) => (
            <button key={d} onClick={() => setDays(d)}
              className={`px-4 py-2 text-sm font-semibold ${
                days === d ? 'bg-brand-700 text-white' : 'bg-white hover:bg-canvas'}`}>
              {d} days
            </button>
          ))}
        </div>
      ) : null}

      {error ? <ErrorNote message={error} onRetry={reload} />
        : loading || !data ? <Spinner label="Reading your books…" />
        : (
          <>
            {/* One strip above every report, so it is learned once. */}
            <ReportToolbar
              report={slug}
              title={REPORTS.find((r) => r.slug === slug)?.label ?? slug}
              config={view}
              onConfig={setView}
              company={company?.name}
              {...exportShape(slug, data)}
            />
            <Report slug={slug} data={data} />
          </>
        )}
    </>
  );
}

/**
 * Guard a list before mapping it.
 *
 * The hook now guarantees data matches the request, which removes the cause of
 * a shape mismatch. This makes the symptom impossible too: a report whose shape
 * changes server-side should show "nothing to show", never take the page down.
 */
const list = <X,>(v: X[] | undefined | null): X[] => (Array.isArray(v) ? v : []);

function Report({ slug, data }: { slug: Slug; data: unknown }) {
  switch (slug) {
    case 'trial-balance': return <TrialBalanceView d={data as TrialBalance} />;
    case 'pnl': return <PnlView d={data as Pnl} />;
    case 'balance-sheet': return <BalanceSheetView d={data as BalanceSheet} />;
    case 'daybook': return <DayBookView d={data as DayBook} />;
    case 'sales-analysis': return <BarList rows={(data as SalesAnalysis).rows}
      total={(data as SalesAnalysis).totalPaise} />;
    case 'party-wise': return <PartyWiseView d={data as PartyWise} />;
    case 'inactive': return <InactiveView d={data as Inactive} />;
    case 'stock': return <StockView d={data as Stock} />;
    case 'expenses': return <ExpensesView d={data as Expenses} />;
    case 'cash-book':
    case 'bank-book': return <CashBookView d={data as CashBookData} />;
    case 'group-summary': return <GroupSummaryView d={data as GroupSummaryData} />;
    case 'sales-register':
    case 'purchase-register': return <RegisterView d={data as RegisterData} />;
    case 'due-soon': return <DueSoonView d={data as DueSoonData} />;
    case 'expiry': return <ExpiryView d={data as ExpiryData} />;
  }
}

// --- the reports added in Section 12 ---------------------------------------

type CashBookData = {
  kind: string; openingPaise: number; closingPaise: number;
  accounts: { name: string; group: string; closingPaise: number }[];
  totals: { inPaise: number; outPaise: number };
  rows: { id: string; no: string; type: string; date: string; account: string;
          inPaise: number; outPaise: number; contra: string;
          narration: string; balancePaise: number }[];
  note?: string;
};

/**
 * A cash or bank book.
 *
 * The running balance is the column that matters: a list of receipts and
 * payments is a statement nobody can reconcile, but the balance after each
 * line is what lets somebody find the day it went wrong.
 */
function CashBookView({ d }: { d: CashBookData }) {
  const money = useMoney();
  if (d.note) return <Empty title="Nothing to show" hint={d.note} />;

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <Stat label="Opening" value={money(d.openingPaise)} />
        <Stat label="In" value={money(d.totals.inPaise)} tone="good" />
        <Stat label="Out" value={money(d.totals.outPaise)} tone="bad" />
        <Stat label="Closing" value={money(d.closingPaise)} />
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase
                             tracking-wide text-slate-400">
                <th className="pb-2 pr-3 font-semibold">Date</th>
                <th className="pb-2 pr-3 font-semibold">Particulars</th>
                <th className="pb-2 pr-3 font-semibold">Voucher</th>
                <th className="pb-2 pr-3 text-right font-semibold">In</th>
                <th className="pb-2 pr-3 text-right font-semibold">Out</th>
                <th className="pb-2 text-right font-semibold">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-slate-100 bg-slate-50">
                <td className="py-2 pr-3 text-xs text-slate-500" colSpan={5}>Opening balance</td>
                <td className="py-2 text-right tabular-nums font-semibold">
                  {money(d.openingPaise)}
                </td>
              </tr>
              {list(d.rows).map((r) => (
                <tr key={r.id + r.account} className="border-b border-slate-50 last:border-0">
                  <td className="py-2 pr-3 whitespace-nowrap text-slate-500">
                    {shortDate(r.date)}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="text-slate-800">{r.contra || '—'}</div>
                    {r.narration && (
                      <div className="text-[11px] text-slate-400">{r.narration}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs text-slate-500">
                    {r.type} {r.no}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-emerald-700">
                    {r.inPaise ? money(r.inPaise) : ''}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-rose-700">
                    {r.outPaise ? money(r.outPaise) : ''}
                  </td>
                  <td className="py-2 text-right tabular-nums font-semibold">
                    {money(r.balancePaise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

type GroupNode = {
  name: string; parent: string; orphan: boolean; ledgers: number;
  ownBalancePaise: number; totalBalancePaise: number; totalLedgers: number;
  children: GroupNode[];
};
type GroupSummaryData = {
  groups: GroupNode[];
  counts: { groups: number; roots: number };
  note: string;
};

function GroupSummaryView({ d }: { d: GroupSummaryData }) {
  const money = useMoney();
  return (
    <>
      {d.note && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{d.note}</p>
      )}
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase
                           tracking-wide text-slate-400">
              <th className="pb-2 pr-3 font-semibold">Group</th>
              <th className="pb-2 pr-3 text-right font-semibold">Ledgers</th>
              <th className="pb-2 text-right font-semibold">Balance</th>
            </tr>
          </thead>
          <tbody>
            {list(d.groups).map((g) => <GroupRows key={g.name} g={g} depth={0} money={money} />)}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/** One group and everything under it, indented by depth. */
function GroupRows({ g, depth, money }: {
  g: GroupNode; depth: number; money: (p: number) => string;
}): React.ReactElement {
  return (
    <>
      <tr className="border-b border-slate-50">
        <td className="py-1.5 pr-3" style={{ paddingLeft: depth * 18 }}>
          <span className={depth === 0 ? 'font-semibold text-slate-900' : 'text-slate-700'}>
            {g.name}
          </span>
          {g.orphan && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 text-[10px] text-amber-800">
              not in the group tree
            </span>
          )}
        </td>
        <td className="py-1.5 pr-3 text-right tabular-nums text-slate-500">
          {g.totalLedgers || ''}
        </td>
        <td className={`py-1.5 text-right tabular-nums ${
          depth === 0 ? 'font-bold text-slate-900' : 'text-slate-700'}`}>
          {money(g.totalBalancePaise)}
        </td>
      </tr>
      {g.children.map((c) => <GroupRows key={c.name} g={c} depth={depth + 1} money={money} />)}
    </>
  );
}

type RegisterData = {
  which: string;
  rows: { id: string; no: string; type: string; date: string; party: string;
          gstin: string; taxablePaise: number; cgstPaise: number; sgstPaise: number;
          igstPaise: number; cessPaise: number; taxPaise: number;
          grossPaise: number; isReturn: boolean }[];
  totals: { count: number; taxablePaise: number; cgstPaise: number; sgstPaise: number;
            igstPaise: number; taxPaise: number; grossPaise: number };
};

function RegisterView({ d }: { d: RegisterData }) {
  const money = useMoney();
  if (!d.rows.length) return <Empty title="Nothing in this period" hint="No entries to list." />;

  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase
                           tracking-wide text-slate-400">
              <th className="pb-2 pr-3 font-semibold">Date</th>
              <th className="pb-2 pr-3 font-semibold">No.</th>
              <th className="pb-2 pr-3 font-semibold">Party</th>
              <th className="pb-2 pr-3 text-right font-semibold">Taxable</th>
              <th className="pb-2 pr-3 text-right font-semibold">CGST</th>
              <th className="pb-2 pr-3 text-right font-semibold">SGST</th>
              <th className="pb-2 pr-3 text-right font-semibold">IGST</th>
              <th className="pb-2 text-right font-semibold">Total</th>
            </tr>
          </thead>
          <tbody>
            {list(d.rows).map((r) => (
              <tr key={r.id} className={`border-b border-slate-50 last:border-0 ${
                r.isReturn ? 'text-rose-700' : ''}`}>
                <td className="py-2 pr-3 whitespace-nowrap text-slate-500">{shortDate(r.date)}</td>
                <td className="py-2 pr-3">{r.no}</td>
                <td className="py-2 pr-3">
                  <div className="text-slate-800">{r.party || '—'}</div>
                  {r.gstin && <div className="font-mono text-[11px] text-slate-400">{r.gstin}</div>}
                  {r.isReturn && <span className="text-[11px]">return</span>}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(r.taxablePaise)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                  {r.cgstPaise ? money(r.cgstPaise) : ''}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                  {r.sgstPaise ? money(r.sgstPaise) : ''}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                  {r.igstPaise ? money(r.igstPaise) : ''}
                </td>
                <td className="py-2 text-right tabular-nums font-semibold">
                  {money(r.grossPaise)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-slate-800 font-bold">
              <td className="py-2 pr-3" colSpan={3}>{d.totals.count} entries</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(d.totals.taxablePaise)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(d.totals.cgstPaise)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(d.totals.sgstPaise)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(d.totals.igstPaise)}</td>
              <td className="py-2 text-right tabular-nums">{money(d.totals.grossPaise)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

type DueBill = { ref: string; party: string; billDate: string; dueDate: string;
                 amountPaise: number; days: number; phone: string; email: string };
type DueSoonData = {
  asOf: string;
  groups: Record<string, DueBill[]>;
  totals: Record<string, { count: number; amountPaise: number }>;
};

const DUE_BUCKETS = [
  { key: 'overdue', label: 'Overdue', tone: 'bad' },
  { key: 'today', label: 'Due today', tone: 'bad' },
  { key: 'week', label: 'This week', tone: 'warn' },
  { key: 'month', label: 'This month', tone: 'warn' },
  { key: 'later', label: 'Later', tone: 'ok' },
] as const;

/** Who to ring this morning, which is a different question from how old the money is. */
function DueSoonView({ d }: { d: DueSoonData }) {
  const money = useMoney();
  return (
    <>
      <div className="mb-5 grid gap-3 sm:grid-cols-5">
        {DUE_BUCKETS.map((b) => (
          <Stat key={b.key} label={b.label}
            value={money(d.totals[b.key]?.amountPaise ?? 0)}
            sub={`${d.totals[b.key]?.count ?? 0} bills`}
            tone={b.tone === 'bad' ? 'bad' : b.tone === 'warn' ? 'warn' : undefined} />
        ))}
      </div>

      {DUE_BUCKETS.filter((b) => (d.groups[b.key] ?? []).length > 0).map((b) => (
        <div key={b.key} className="mb-5">
          <SectionTitle>{b.label}</SectionTitle>
          <Card>
            <table className="w-full text-sm">
              <tbody>
                {list(d.groups[b.key]).map((x) => (
                  <tr key={x.ref + x.party} className="border-b border-slate-50 last:border-0">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-slate-800">{x.party}</div>
                      <div className="text-[11px] text-slate-400">
                        {x.ref} · due {shortDate(x.dueDate)}
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      {/* The point of the report is to ring them. */}
                      {x.phone || 'no phone on file'}
                    </td>
                    <td className="py-2 text-right tabular-nums font-semibold">
                      {money(x.amountPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      ))}
    </>
  );
}

type ExpiryData = {
  rows: { item: string; batch: string; godown: string; qty: number;
          valuePaise: number; expiryDate: string; days: number; status: string }[];
  totals: { expired: number; expiredValuePaise: number; soon: number; soonValuePaise: number };
  note: string;
};

function ExpiryView({ d }: { d: ExpiryData }) {
  const money = useMoney();
  if (d.note) return <Empty title="Nothing to show" hint={d.note} />;

  const TONE: Record<string, 'ok' | 'warn' | 'bad'> = {
    expired: 'bad', soon: 'bad', watch: 'warn', ok: 'ok',
  };

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Stat label="Already expired" value={money(d.totals.expiredValuePaise)}
          sub={`${d.totals.expired} batches`} tone={d.totals.expired ? 'bad' : undefined} />
        <Stat label="Within 30 days" value={money(d.totals.soonValuePaise)}
          sub={`${d.totals.soon} batches`} tone={d.totals.soon ? 'warn' : undefined} />
      </div>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase
                           tracking-wide text-slate-400">
              <th className="pb-2 pr-3 font-semibold">Item</th>
              <th className="pb-2 pr-3 font-semibold">Batch</th>
              <th className="pb-2 pr-3 text-right font-semibold">Qty</th>
              <th className="pb-2 pr-3 text-right font-semibold">Value</th>
              <th className="pb-2 font-semibold">Expiry</th>
            </tr>
          </thead>
          <tbody>
            {list(d.rows).map((r) => (
              <tr key={r.item + r.batch + r.godown} className="border-b border-slate-50 last:border-0">
                <td className="py-2 pr-3 text-slate-800">{r.item}</td>
                <td className="py-2 pr-3 text-slate-600">
                  {r.batch}
                  {r.godown && <span className="text-[11px] text-slate-400"> · {r.godown}</span>}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{r.qty}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(r.valuePaise)}</td>
                <td className="py-2">
                  <Badge tone={TONE[r.status]}>
                    {shortDate(r.expiryDate)}
                    {r.days < 0 ? ` · ${Math.abs(r.days)}d ago` : ` · ${r.days}d`}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'warn';
}) {
  return (
    <Card>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={`mt-1 text-lg font-bold tabular-nums ${
        tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-700'
          : tone === 'warn' ? 'text-amber-600' : 'text-slate-900'}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-400">{sub}</div>}
    </Card>
  );
}

/**
 * A financial table.
 *
 * Two things make the difference between this and a spreadsheet dump:
 *
 * - The header sticks. Scrolling a hundred ledgers and losing "Debit / Credit"
 *   means counting columns to work out what a number is.
 * - Figures are tabular and right-aligned, so the rupees line up. Money in a
 *   column that does not align is the clearest sign of an unfinished product.
 *
 * The horizontal scroll stays for genuinely wide tables on a narrow window, but
 * a fade on the right edge shows there is more, rather than leaving somebody to
 * discover it.
 */
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="relative -mx-5 overflow-x-auto px-5">
      <table className="w-full min-w-[420px] text-sm">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-line text-left">
            {head.map((h, i) => (
              <th key={h}
                className={`whitespace-nowrap pb-2.5 pt-1 text-[11px] font-semibold
                            uppercase tracking-[0.07em] text-muted
                            ${i > 0 ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">{children}</tbody>
      </table>
    </div>
  );
}

const Row = ({ children }: { children: React.ReactNode }) => (
  <tr className="transition-colors hover:bg-canvas">{children}</tr>
);

/** A figure. Tabular and tracked tight so columns of rupees line up exactly. */
const Num = ({ children, strong }: { children: React.ReactNode; strong?: boolean }) => (
  <td className={`figure whitespace-nowrap py-2.5 pl-4 text-right
                  ${strong ? 'font-bold' : 'font-semibold'}`}>
    {children}
  </td>
);

/** An empty cell, so a blank does not read as a missing value. */
const Dash = () => <span className="text-faint">—</span>;

function TrialBalanceView({ d }: { d: TrialBalance }) {
  const groups = list(d.groups);
  return (
    <Card>
      <SectionTitle icon={Scale}
        note={d.balanced ? 'debit equals credit' : 'does not balance'}>
        Trial Balance
      </SectionTitle>

      {/* Nature moves onto the group's own line rather than taking a column.
          It is a one-word qualifier, not a figure, and giving it equal width
          pushed the two columns that matter off a narrow screen. */}
      <Table head={['Group', 'Debit', 'Credit']}>
        {groups.map((g) => (
          <Row key={g.group}>
            <td className="py-2.5 pr-4">
              <span className="block font-medium">{g.group}</span>
              <span className="text-xs capitalize text-faint">{g.nature}</span>
            </td>
            <Num>{g.closingPaise >= 0 ? inr(g.closingPaise) : <Dash />}</Num>
            <Num>{g.closingPaise < 0 ? inr(-g.closingPaise) : <Dash />}</Num>
          </Row>
        ))}
        <tr className="border-t-2 border-line">
          <td className="py-3 font-bold">Total</td>
          <Num strong>{inr(d.totals.debitPaise)}</Num>
          <Num strong>{inr(d.totals.creditPaise)}</Num>
        </tr>
      </Table>
      <div className="mt-4">
        <Badge tone={d.balanced ? 'ok' : 'bad'}>
          {d.balanced ? 'Balanced' : `Out by ${inr(Math.abs(d.totals.differencePaise))}`}
        </Badge>
        {!d.balanced ? (
          <p className="mt-2 text-xs text-muted">
            A trial balance that does not balance usually means the sync is
            incomplete. Run the connector again before trusting these figures.
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function PnlView({ d }: { d: Pnl }) {
  const profit = d.totals.profitPaise;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <SectionTitle>Income</SectionTitle>
        <Table head={['Group', 'Amount']}>
          {list(d.income).map((r) => (
            <Row key={r.group}>
              <td className="py-2.5">{r.group}</td><Num>{inr(r.amountPaise)}</Num>
            </Row>
          ))}
        </Table>
      </Card>
      <Card>
        <SectionTitle>Expenses</SectionTitle>
        {list(d.expense).length === 0 ? <p className="text-sm text-muted">No expense ledgers.</p> : (
          <Table head={['Group', 'Amount']}>
            {list(d.expense).map((r) => (
              <Row key={r.group}>
                <td className="py-2.5">{r.group}</td><Num>{inr(r.amountPaise)}</Num>
              </Row>
            ))}
          </Table>
        )}
      </Card>
      <Card className="lg:col-span-2">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">
              {profit >= 0 ? 'Net profit' : 'Net loss'}
            </div>
            <div className={`text-3xl font-bold tabular-nums ${
              profit >= 0 ? 'text-brand-700' : 'text-rose-700'}`}>
              {inr(Math.abs(profit))}
            </div>
          </div>
          <div className="text-sm text-muted">
            {inr(d.totals.incomePaise)} income − {inr(d.totals.expensePaise)} expenses
          </div>
        </div>
      </Card>
    </div>
  );
}

function BalanceSheetView({ d }: { d: BalanceSheet }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <SectionTitle note={inr(d.totals.assetsPaise)}>Assets</SectionTitle>
        <Table head={['Group', 'Amount']}>
          {list(d.assets).map((r) => (
            <Row key={r.group}>
              <td className="py-2.5">{r.group}</td><Num>{inr(r.amountPaise)}</Num>
            </Row>
          ))}
        </Table>
      </Card>
      <Card>
        <SectionTitle note={inr(d.totals.liabilitiesPaise)}>Liabilities</SectionTitle>
        <Table head={['Group', 'Amount']}>
          {list(d.liabilities).map((r) => (
            <Row key={r.group}>
              <td className="py-2.5">{r.group}</td><Num>{inr(r.amountPaise)}</Num>
            </Row>
          ))}
          <Row>
            <td className="py-2.5 italic text-body">Profit &amp; Loss</td>
            <Num>{inr(d.profitPaise)}</Num>
          </Row>
        </Table>
      </Card>
      <Card className="lg:col-span-2">
        <Badge tone={d.totals.differencePaise === 0 ? 'ok' : 'bad'}>
          {d.totals.differencePaise === 0
            ? 'Balanced' : `Out by ${inr(Math.abs(d.totals.differencePaise))}`}
        </Badge>
      </Card>
    </div>
  );
}

function DayBookView({ d }: { d: DayBook }) {
  return (
    <Card>
      <SectionTitle note={`${d.count} vouchers`}>Day Book — {d.date}</SectionTitle>
      <div className="mb-4 flex flex-wrap gap-4">
        {Object.entries(d.totalsByType ?? {}).map(([t, v]) => (
          <div key={t}>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted">{t}</div>
            <div className="text-lg font-bold tabular-nums">{inr(v)}</div>
          </div>
        ))}
      </div>
      <Table head={['No.', 'Type', 'Party', 'Amount']}>
        {list(d.vouchers).map((v, i) => (
          <Row key={`${v.vchType}-${v.vchNo}-${i}`}>
            <td className="py-2.5 tabular-nums text-muted">{v.vchNo}</td>
            <td className="py-2.5 text-right text-body">{v.vchType}</td>
            <td className="py-2.5 text-right">{v.party}</td>
            <Num>{inr(Math.abs(v.amountPaise))}</Num>
          </Row>
        ))}
      </Table>
    </Card>
  );
}

/** A bar list beats a chart here: the label matters as much as the value. */
function BarList({ rows, total }: {
  rows: { label: string; amountPaise: number; count: number }[]; total: number;
}) {
  const max = Math.max(...rows.map((r) => r.amountPaise), 1);
  return (
    <Card>
      <SectionTitle note={`total ${inr(total)}`}>Sales analysis</SectionTitle>
      <ul className="space-y-2.5">
        {rows.map((r) => (
          <li key={r.label}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate">{r.label}</span>
              <span className="shrink-0 font-semibold tabular-nums">
                {inr(r.amountPaise)}
                <span className="ml-2 text-xs font-normal text-faint">{r.count}</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded bg-line-soft">
              <div className="h-full rounded bg-brand-500"
                style={{ width: `${(r.amountPaise / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PartyWiseView({ d }: { d: PartyWise }) {
  return (
    <Card>
      <SectionTitle>Party-wise sales and purchases</SectionTitle>
      <Table head={['Party', 'Sales', 'Purchases', 'Last transaction']}>
        {list(d.rows).map((r) => (
          <Row key={r.name}>
            <td className="py-2.5">{r.name}</td>
            <Num>{inr(r.salesPaise)}</Num>
            <Num>{inr(r.purchasesPaise)}</Num>
            <td className="py-2.5 text-right text-muted">{shortDate(r.lastTxn)}</td>
          </Row>
        ))}
      </Table>
    </Card>
  );
}

function InactiveView({ d }: { d: Inactive }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <SectionTitle note={`no purchase in ${d.days} days`}>Quiet customers</SectionTitle>
        {list(d.parties).length === 0 ? <p className="text-sm text-muted">Everyone has bought recently.</p> : (
          <Table head={['Party', 'Last seen', 'Owes']}>
            {list(d.parties).map((p) => (
              <Row key={p.name}>
                <td className="py-2.5">
                  {p.name}
                  {p.phone ? <span className="ml-2 text-xs text-faint">{p.phone}</span> : null}
                </td>
                <td className="py-2.5 text-right text-muted">
                  {p.daysSince === null ? 'never' : `${p.daysSince} days ago`}
                </td>
                <Num>{inr(p.outstandingPaise)}</Num>
              </Row>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-muted">
          A customer who stopped buying is revenue you can still win back — this
          is the list to call.
        </p>
      </Card>
      <Card>
        <SectionTitle note={`not sold in ${d.days} days`}>Quiet items</SectionTitle>
        {list(d.items).length === 0 ? <p className="text-sm text-muted">Everything is moving.</p> : (
          <Table head={['Item', 'Last sold']}>
            {list(d.items).map((i) => (
              <Row key={i.name}>
                <td className="py-2.5">{i.name}</td>
                <td className="py-2.5 text-right text-muted">
                  {i.daysSince === null ? 'never' : `${i.daysSince} days ago`}
                </td>
              </Row>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

function StockView({ d }: { d: Stock }) {
  return (
    <Card>
      <SectionTitle note={`total ${inr(d.totalValuePaise)}`}>Stock summary</SectionTitle>
      <Table head={['Item', 'Quantity', 'Value']}>
        {list(d.items).map((i) => (
          <Row key={i.name}>
            <td className="py-2.5">{i.name}</td>
            <td className="py-2.5 text-right tabular-nums">
              {i.qty.toLocaleString('en-IN')} {i.unit}
            </td>
            <Num>{inr(i.valuePaise)}</Num>
          </Row>
        ))}
      </Table>
    </Card>
  );
}

function ExpensesView({ d }: { d: Expenses }) {
  return (
    <Card>
      <SectionTitle note={`total ${inr(d.totalPaise)}`}>Expenses</SectionTitle>
      {list(d.items).length === 0 ? <p className="text-sm text-muted">No expense ledgers in this company.</p> : (
        <Table head={['Ledger', 'Group', 'Amount']}>
          {list(d.items).map((i) => (
            <Row key={i.name}>
              <td className="py-2.5">{i.name}</td>
              <td className="py-2.5 text-right text-muted">{i.group}</td>
              <Num>{inr(i.amountPaise)}</Num>
            </Row>
          ))}
        </Table>
      )}
    </Card>
  );
}


/**
 * One report tab, with its pin.
 *
 * The star is a sibling button rather than nested inside the tab: a button
 * inside a button is invalid HTML, and the click target for "open" and for
 * "pin" must not overlap.
 */
function Tab({ r, active, fav, onPick, onToggle }: {
  r: (typeof REPORTS)[number];
  active: boolean;
  fav: boolean;
  onPick: () => void;
  onToggle: () => void;
}) {
  return (
    <span className={`group inline-flex items-center rounded-lg transition ${
      active ? 'bg-brand-700' : 'hover:bg-line-soft'}`}>
      <button onClick={onPick} title={r.hint}
        className={`py-1.5 pl-3 pr-1.5 text-sm font-semibold ${
          active ? 'text-white' : 'text-muted group-hover:text-ink'}`}>
        {r.label}
      </button>
      <button onClick={onToggle} title={fav ? 'Unpin this report' : 'Pin to the top'}
        aria-label={fav ? `Unpin ${r.label}` : `Pin ${r.label}`}
        className="py-1.5 pl-0.5 pr-2">
        <Star size={13}
          className={fav ? 'fill-amber-400 text-amber-500'
            : active ? 'text-white/50 hover:text-white'
                     : 'text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-amber-500'} />
      </button>
    </span>
  );
}


/**
 * What each report exports.
 *
 * Written per report rather than guessed from the shape: a CSV whose columns
 * were inferred is one that changes silently when the API adds a field, and
 * somebody's saved spreadsheet formula breaks with no warning.
 *
 * Anything not listed exports nothing rather than exporting something wrong -
 * an empty file is an obvious problem; a plausible wrong one is not.
 */
function exportShape(slug: string, data: unknown): {
  rows: Record<string, unknown>[];
  columns: Column<Record<string, unknown>>[];
} {
  const money = (p: unknown) => (typeof p === 'number' ? p / 100 : '');
  const col = (key: string, label: string,
    value?: (r: Record<string, unknown>) => string | number)
    : Column<Record<string, unknown>> => ({
      key, label, value: value ?? ((r) => String(r[key] ?? '')),
    });

  switch (slug) {
    case 'trial-balance': {
      const d = data as { rows?: Record<string, unknown>[] };
      return {
        rows: list(d.rows),
        columns: [
          col('group', 'Group'),
          col('debit', 'Debit', (r) => money(r.debitPaise)),
          col('credit', 'Credit', (r) => money(r.creditPaise)),
        ],
      };
    }
    case 'cash-book':
    case 'bank-book': {
      const d = data as { rows?: Record<string, unknown>[] };
      return {
        rows: list(d.rows),
        columns: [
          col('date', 'Date'),
          col('contra', 'Particulars'),
          col('type', 'Voucher type'),
          col('no', 'Voucher no'),
          col('in', 'In', (r) => money(r.inPaise)),
          col('out', 'Out', (r) => money(r.outPaise)),
          col('balance', 'Balance', (r) => money(r.balancePaise)),
        ],
      };
    }
    case 'sales-register':
    case 'purchase-register': {
      const d = data as { rows?: Record<string, unknown>[] };
      return {
        rows: list(d.rows),
        columns: [
          col('date', 'Date'), col('no', 'Number'), col('party', 'Party'),
          col('gstin', 'GSTIN'),
          col('taxable', 'Taxable', (r) => money(r.taxablePaise)),
          col('cgst', 'CGST', (r) => money(r.cgstPaise)),
          col('sgst', 'SGST', (r) => money(r.sgstPaise)),
          col('igst', 'IGST', (r) => money(r.igstPaise)),
          col('gross', 'Total', (r) => money(r.grossPaise)),
        ],
      };
    }
    case 'stock': {
      const d = data as { items?: Record<string, unknown>[]; rows?: Record<string, unknown>[] };
      return {
        rows: list(d.items ?? d.rows),
        columns: [
          col('name', 'Item'),
          col('qty', 'Quantity', (r) => Number(r.closingQty ?? r.qty ?? 0)),
          col('unit', 'Unit'),
          col('value', 'Value', (r) => money(r.closingValuePaise ?? r.valuePaise)),
        ],
      };
    }
    case 'expenses': {
      const d = data as { rows?: Record<string, unknown>[] };
      return {
        rows: list(d.rows),
        columns: [col('name', 'Ledger'), col('amount', 'Amount', (r) => money(r.amountPaise))],
      };
    }
    case 'due-soon': {
      const d = data as { groups?: Record<string, Record<string, unknown>[]> };
      const all = Object.entries(d.groups ?? {}).flatMap(([bucket, bills]) =>
        list(bills).map((b) => ({ ...b, bucket })));
      return {
        rows: all,
        columns: [
          col('bucket', 'When'), col('party', 'Party'), col('ref', 'Bill'),
          col('dueDate', 'Due'), col('phone', 'Phone'),
          col('amount', 'Amount', (r) => money(r.amountPaise)),
        ],
      };
    }
    case 'expiry': {
      const d = data as { rows?: Record<string, unknown>[] };
      return {
        rows: list(d.rows),
        columns: [
          col('item', 'Item'), col('batch', 'Batch'), col('godown', 'Godown'),
          col('qty', 'Quantity'), col('expiryDate', 'Expiry'), col('status', 'Status'),
        ],
      };
    }
    default:
      return { rows: [], columns: [] };
  }
}
