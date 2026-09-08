import React, { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp, useApi } from '../lib/store';
import { inr, shortDate, mask } from '../lib/format';
import type {
  TrialBalance, Pnl, BalanceSheet, DayBook, SalesAnalysis,
  Inactive, Stock, PartyWise, Expenses,
} from '../lib/api';
import {
  Badge, BarRow, Card, Empty, ErrorNote, Label, LineRow, Loading, Muted, OfflineBar, Screen, Title,
} from '../components/ui';
import { Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, X, Check } from 'lucide-react-native';
import { T } from '../theme';

// The same report set as the web app. An owner and their accountant should not
// have to learn two products.
/*
 * Grouped, because nine reports in one flat strip is a wall.
 *
 * "The books" is what an accountant asks for; "Where the money is" is what an
 * owner asks for. Naming the groups is what turns a list into somewhere you can
 * find something.
 */
const REPORTS = [
  { slug: 'trial-balance', label: 'Trial Balance', group: 'The books',
    hint: 'Every group, debit against credit' },
  { slug: 'pnl', label: 'Profit & Loss', group: 'The books',
    hint: 'What you earned and what it cost' },
  { slug: 'balance-sheet', label: 'Balance Sheet', group: 'The books',
    hint: 'What you own against what you owe' },
  { slug: 'daybook', label: 'Day Book', group: 'The books',
    hint: 'Every voucher, one day at a time' },

  { slug: 'sales-analysis', label: 'Sales', group: 'Where the money is',
    hint: 'By month, party or item' },
  { slug: 'party-wise', label: 'Party-wise', group: 'Where the money is',
    hint: 'Sales and dues for each customer' },
  { slug: 'expenses', label: 'Expenses', group: 'Where the money is',
    hint: 'What you are spending on' },
  { slug: 'stock', label: 'Stock', group: 'Where the money is',
    hint: 'What is sitting on the shelf' },
  { slug: 'inactive', label: 'Gone quiet', group: 'Where the money is',
    hint: 'Customers who stopped buying' },

  { slug: 'cash-book', label: 'Cash Book', group: 'Cash & bank',
    hint: 'Every cash movement, with a running balance' },
  { slug: 'bank-book', label: 'Bank Book', group: 'Cash & bank',
    hint: 'Every bank movement, with a running balance' },

  { slug: 'due-soon', label: 'Due Soon', group: 'Chasing money',
    hint: 'Who to ring today, this week, this month' },
  { slug: 'group-summary', label: 'Group Summary', group: 'The books',
    hint: 'The account tree, rolled up' },
  { slug: 'sales-register', label: 'Sales Register', group: 'Where the money is',
    hint: 'Every invoice with its tax columns' },
  { slug: 'expiry', label: 'Expiry', group: 'Where the money is',
    hint: 'Batches going out of date' },
] as const;

const GROUPS = ['The books', 'Where the money is'] as const;

type Slug = (typeof REPORTS)[number]['slug'];

/**
 * Guard a list before mapping it.
 *
 * Clearing stale data when the path changes fixes the cause of a shape
 * mismatch; this makes the symptom impossible. A report whose shape changes
 * server-side should show "nothing to show", never take the screen down.
 */
const list = <X,>(v: X[] | undefined | null): X[] => (Array.isArray(v) ? v : []);

export default function ReportsScreen() {
  const { company, privacy } = useApp();
  const [slug, setSlug] = useState<Slug>('trial-balance');
  const [picking, setPicking] = useState(false);
  const [groupBy, setGroupBy] = useState<'month' | 'party' | 'item'>('month');
  const [days, setDays] = useState(90);

  const qs = slug === 'sales-analysis' ? `?groupBy=${groupBy}`
    : slug === 'inactive' ? `?days=${days}` : '';

  const { data, error, loading, reload, stale, offline } = useApi<unknown>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/${slug}${qs}` : null,
    [company?.tallyGuid, slug, groupBy, days],
  );

  // Owners open this in front of staff, so the privacy toggle has to reach
  // every figure - reports included, not just the dashboard.
  const money = (p: number, compact = false) =>
    privacy ? mask(inr(p, { compact })) : inr(p, { compact });

  const current = REPORTS.find((r) => r.slug === slug) ?? REPORTS[0];

  if (!company) {
    return <View style={s.wrap}><Empty title="No company" hint="Connect Tally first." /></View>;
  }

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <OfflineBar offline={offline} ageMs={stale} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.headName} numberOfLines={1}>{company.name}</Text>
            <Text style={s.headSub}>Straight from your Tally books</Text>
          </View>
        </View>
      }
    >

      {/*
        * One button, not a strip of nine.
        *
        * A horizontal row meant swiping past reports to find one, with no sign
        * it even scrolled - and the four at the end were effectively hidden.
        * This says which report you are reading and opens a list of all of
        * them, grouped, with a line explaining each.
        */}
      <Pressable onPress={() => setPicking(true)} style={s.picker}>
        <View style={{ flex: 1 }}>
          <Text style={s.pickerLabel}>Report</Text>
          <Text style={s.pickerValue}>{current.label}</Text>
        </View>
        <ChevronDown size={19} strokeWidth={2.2} color={T.muted} />
      </Pressable>

      {slug === 'sales-analysis' ? (
        <Segmented options={['month', 'party', 'item']} value={groupBy}
          onChange={(v) => setGroupBy(v as typeof groupBy)} />
      ) : null}
      {slug === 'inactive' ? (
        <Segmented options={['30', '60', '90', '180']} value={String(days)}
          suffix="d" onChange={(v) => setDays(Number(v))} />
      ) : null}

      {error ? <ErrorNote message={error} onRetry={reload} />
        : loading || !data ? <Loading label="Reading your books…" />
        : <Report slug={slug} data={data} money={money} />}

      <View style={{ height: 28 }} />
      {picking ? (
        <ReportPicker
          value={slug}
          onPick={(next) => { setSlug(next); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </Screen>
  );
}

/**
 * The report list, as a sheet.
 *
 * Grouped and described, because "Party-wise" and "Inactive" mean nothing to a
 * shop owner until somebody says what they show. Full height rather than a
 * dropdown: nine items with a line of explanation each does not fit in a popup,
 * and cramming it is how you end up back at a strip of chips.
 */
function ReportPicker({ value, onPick, onClose }: {
  value: Slug; onPick: (s: Slug) => void; onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={s.grabber} />
        <View style={s.sheetHead}>
          <Text style={s.sheetTitle}>Reports</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <X size={20} strokeWidth={2.2} color={T.muted} />
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false}>
          {GROUPS.map((g) => (
            <View key={g} style={{ marginBottom: 6 }}>
              <Text style={s.sheetGroup}>{g}</Text>
              {REPORTS.filter((r) => r.group === g).map((r) => {
                const on = r.slug === value;
                return (
                  <Pressable key={r.slug} onPress={() => onPick(r.slug)}
                    style={[s.sheetRow, on && s.sheetRowOn]}>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.sheetLabel, on && { color: T.green }]}>{r.label}</Text>
                      <Text style={s.sheetHint}>{r.hint}</Text>
                    </View>
                    {on ? <Check size={18} strokeWidth={2.5} color={T.green} /> : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

function Segmented({ options, value, onChange, suffix = '' }: {
  options: string[]; value: string; onChange: (v: string) => void; suffix?: string;
}) {
  return (
    <View style={s.seg}>
      {options.map((o) => (
        <Pressable key={o} onPress={() => onChange(o)}
          style={[s.segBtn, value === o && s.segOn]}>
          <Text style={[s.segText, value === o && { color: '#fff' }]}>{o}{suffix}</Text>
        </Pressable>
      ))}
    </View>
  );
}

type Money = (p: number, compact?: boolean) => string;

function Report({ slug, data, money }: { slug: Slug; data: unknown; money: Money }) {
  switch (slug) {
    case 'trial-balance': return <TrialBalanceView d={data as TrialBalance} money={money} />;
    case 'pnl': return <PnlView d={data as Pnl} money={money} />;
    case 'balance-sheet': return <BalanceSheetView d={data as BalanceSheet} money={money} />;
    case 'daybook': return <DayBookView d={data as DayBook} money={money} />;
    case 'sales-analysis': return <SalesView d={data as SalesAnalysis} money={money} />;
    case 'party-wise': return <PartyWiseView d={data as PartyWise} money={money} />;
    case 'inactive': return <InactiveView d={data as Inactive} money={money} />;
    case 'stock': return <StockView d={data as Stock} money={money} />;
    case 'expenses': return <ExpensesView d={data as Expenses} money={money} />;
    case 'cash-book':
    case 'bank-book': return <CashBookView d={data as CashBookData} money={money} />;
    case 'group-summary': return <GroupSummaryView d={data as GroupSummaryData} money={money} />;
    case 'sales-register': return <RegisterView d={data as RegisterData} money={money} />;
    case 'due-soon': return <DueSoonView d={data as DueSoonData} money={money} />;
    case 'expiry': return <ExpiryView d={data as ExpiryData} money={money} />;
  }
}

// --- the reports added in Section 12 ---------------------------------------

type CashBookData = {
  openingPaise: number; closingPaise: number;
  totals: { inPaise: number; outPaise: number };
  rows: { id: string; no: string; type: string; date: string; account: string;
          inPaise: number; outPaise: number; contra: string;
          balancePaise: number }[];
  note?: string;
};

/**
 * A cash or bank book on a phone.
 *
 * The running balance stays visible on every line: it is the column that
 * turns a list of movements into something reconcilable.
 */
function CashBookView({ d, money }: { d: CashBookData; money: Money }) {
  if (d.note) return <Empty title="Nothing to show" hint={d.note} />;
  return (
    <View>
      <View style={rs.statRow}>
        <MiniStat label="Opening" value={money(d.openingPaise, true)} />
        <MiniStat label="In" value={money(d.totals.inPaise, true)} tone={T.positive} />
        <MiniStat label="Out" value={money(d.totals.outPaise, true)} tone={T.negative} />
        <MiniStat label="Closing" value={money(d.closingPaise, true)} />
      </View>
      {d.rows.map((r) => (
        <View key={r.id + r.account} style={rs.bookRow}>
          <View style={{ flex: 1 }}>
            <Text style={rs.bookParty} numberOfLines={1}>{r.contra || r.type}</Text>
            <Text style={rs.bookMeta}>{shortDate(r.date)} · {r.type} {r.no}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[rs.bookAmt, { color: r.inPaise ? T.positive : T.negative }]}>
              {r.inPaise ? '+' : '−'}{money(r.inPaise || r.outPaise, true)}
            </Text>
            <Text style={rs.bookBal}>{money(r.balancePaise, true)}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

type GroupNode = {
  name: string; orphan: boolean; totalBalancePaise: number;
  totalLedgers: number; children: GroupNode[];
};
type GroupSummaryData = { groups: GroupNode[]; note: string };

function GroupSummaryView({ d, money }: { d: GroupSummaryData; money: Money }) {
  const render = (nodes: GroupNode[], depth = 0): React.ReactNode[] =>
    nodes.flatMap((g) => [
      <View key={g.name + depth} style={[rs.groupRow, { paddingLeft: depth * 14 }]}>
        <Text style={[rs.groupName, depth === 0 && { fontFamily: T.font.bold }]}
          numberOfLines={1}>{g.name}</Text>
        <Text style={rs.groupValue}>{money(g.totalBalancePaise, true)}</Text>
      </View>,
      ...render(g.children, depth + 1),
    ]);

  return (
    <View>
      {d.note ? <Muted>{d.note}</Muted> : null}
      {render(d.groups)}
    </View>
  );
}

type RegisterData = {
  rows: { id: string; no: string; date: string; party: string;
          taxablePaise: number; taxPaise: number; grossPaise: number;
          isReturn: boolean }[];
  totals: { count: number; taxablePaise: number; taxPaise: number; grossPaise: number };
};

function RegisterView({ d, money }: { d: RegisterData; money: Money }) {
  if (!d.rows.length) {
    return <Empty title="Nothing in this period" hint="No entries to list." />;
  }
  return (
    <View>
      <View style={rs.statRow}>
        <MiniStat label="Entries" value={String(d.totals.count)} />
        <MiniStat label="Taxable" value={money(d.totals.taxablePaise, true)} />
        <MiniStat label="Tax" value={money(d.totals.taxPaise, true)} />
        <MiniStat label="Total" value={money(d.totals.grossPaise, true)} />
      </View>
      {d.rows.map((r) => (
        <View key={r.id} style={rs.bookRow}>
          <View style={{ flex: 1 }}>
            <Text style={rs.bookParty} numberOfLines={1}>{r.party || '—'}</Text>
            <Text style={rs.bookMeta}>
              {shortDate(r.date)} · {r.no}{r.isReturn ? ' · return' : ''}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[rs.bookAmt, r.isReturn && { color: T.negative }]}>
              {money(r.grossPaise, true)}
            </Text>
            {r.taxPaise ? (
              <Text style={rs.bookBal}>tax {money(r.taxPaise, true)}</Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

type DueBill = { ref: string; party: string; dueDate: string;
                 amountPaise: number; phone: string };
type DueSoonData = {
  groups: Record<string, DueBill[]>;
  totals: Record<string, { count: number; amountPaise: number }>;
};

const DUE_BUCKETS = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'later', label: 'Later' },
];

/** Who to ring this morning. */
function DueSoonView({ d, money }: { d: DueSoonData; money: Money }) {
  return (
    <View>
      <View style={rs.statRow}>
        {DUE_BUCKETS.slice(0, 4).map((b) => (
          <MiniStat key={b.key} label={b.label}
            value={money(d.totals[b.key]?.amountPaise ?? 0, true)}
            tone={b.key === 'overdue' || b.key === 'today' ? T.negative : undefined} />
        ))}
      </View>
      {DUE_BUCKETS.filter((b) => (d.groups[b.key] ?? []).length > 0).map((b) => (
        <View key={b.key}>
          <Text style={rs.subhead}>{b.label}</Text>
          {d.groups[b.key].map((x) => (
            <View key={x.ref + x.party} style={rs.bookRow}>
              <View style={{ flex: 1 }}>
                <Text style={rs.bookParty} numberOfLines={1}>{x.party}</Text>
                <Text style={rs.bookMeta}>
                  {x.ref} · due {shortDate(x.dueDate)} · {x.phone || 'no phone on file'}
                </Text>
              </View>
              <Text style={rs.bookAmt}>{money(x.amountPaise, true)}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

type ExpiryData = {
  rows: { item: string; batch: string; qty: number; valuePaise: number;
          expiryDate: string; days: number; status: string }[];
  totals: { expired: number; soon: number };
  note: string;
};

function ExpiryView({ d, money }: { d: ExpiryData; money: Money }) {
  if (d.note) return <Empty title="Nothing to show" hint={d.note} />;
  return (
    <View>
      <View style={rs.statRow}>
        <MiniStat label="Expired" value={String(d.totals.expired)} tone={T.negative} />
        <MiniStat label="Within 30 days" value={String(d.totals.soon)} tone={T.warn} />
      </View>
      {d.rows.map((r) => (
        <View key={r.item + r.batch} style={rs.bookRow}>
          <View style={{ flex: 1 }}>
            <Text style={rs.bookParty} numberOfLines={1}>{r.item}</Text>
            <Text style={rs.bookMeta}>
              {r.batch} · {r.qty} · {shortDate(r.expiryDate)}
            </Text>
          </View>
          <Badge tone={r.status === 'ok' ? 'ok' : r.status === 'watch' ? 'warn' : 'bad'}>
            {r.days < 0 ? `${Math.abs(r.days)}d ago` : `${r.days}d`}
          </Badge>
        </View>
      ))}
    </View>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={rs.miniStat}>
      <Text style={rs.miniLabel}>{label}</Text>
      <Text style={[rs.miniValue, tone ? { color: tone } : null]}>{value}</Text>
    </View>
  );
}

const rs = StyleSheet.create({
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  miniStat: {
    flexGrow: 1, flexBasis: '22%', backgroundColor: T.lineSoft,
    borderRadius: T.radiusSm, padding: 9,
  },
  miniLabel: { fontFamily: T.font.medium, fontSize: 9, color: T.muted },
  miniValue: { fontFamily: T.font.bold, fontSize: 13, color: T.ink, marginTop: 2 },
  bookRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  bookParty: { fontFamily: T.font.semibold, fontSize: 13, color: T.ink },
  bookMeta: { fontFamily: T.font.regular, fontSize: 10, color: T.muted, marginTop: 2 },
  bookAmt: { fontFamily: T.font.bold, fontSize: 13, color: T.ink },
  bookBal: { fontFamily: T.font.regular, fontSize: 10, color: T.muted, marginTop: 2 },
  groupRow: {
    flexDirection: 'row', justifyContent: 'space-between', gap: 10,
    paddingVertical: 7, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  groupName: { flex: 1, fontFamily: T.font.medium, fontSize: 13, color: T.ink },
  groupValue: { fontFamily: T.font.semibold, fontSize: 13, color: T.ink },
  subhead: {
    fontFamily: T.font.bold, fontSize: 11, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 16, marginBottom: 4,
  },
});

/**
 * Trial Balance on a phone.
 *
 * A four-column accounting table does not fit 360 points, and forcing it to
 * means horizontal scrolling - which on a table with a hundred rows is
 * unusable, because the row you are reading slides out from under you.
 *
 * So it becomes a list. Debit and credit are the same column, told apart by a
 * coloured tag, which is what an accountant reads anyway.
 */
function TrialBalanceView({ d, money }: { d: TrialBalance; money: Money }) {
  const groups = list(d.groups);
  return (
    <Card style={{ marginTop: 14 }}>
      <View style={s.tbHead}>
        <Label>Trial Balance</Label>
        <Badge tone={d.balanced ? 'ok' : 'bad'}>
          {d.balanced ? 'Balanced' : 'Out of balance'}
        </Badge>
      </View>

      <View style={{ marginTop: 4 }}>
        {groups.map((g) => {
          const debit = g.closingPaise >= 0;
          return (
            <View key={g.group} style={s.tbRow}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={s.tbName} numberOfLines={1}>{g.group}</Text>
                <Text style={s.tbNature}>{g.nature}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={s.tbAmount}>{money(Math.abs(g.closingPaise))}</Text>
                <View style={[s.tbTag, debit ? s.tbDebit : s.tbCredit]}>
                  <Text style={[s.tbTagText, { color: debit ? T.info : T.gold }]}>
                    {debit ? 'DR' : 'CR'}
                  </Text>
                </View>
              </View>
            </View>
          );
        })}
      </View>

      <View style={s.tbTotals}>
        <View style={s.tbTotal}>
          <Text style={s.tbTotalLabel}>Total debit</Text>
          <Text style={s.tbTotalValue}>{money(d.totals.debitPaise)}</Text>
        </View>
        <View style={s.tbTotal}>
          <Text style={s.tbTotalLabel}>Total credit</Text>
          <Text style={s.tbTotalValue}>{money(d.totals.creditPaise)}</Text>
        </View>
      </View>
      {!d.balanced ? (
        <Text style={s.tbOut}>
          Out by {money(Math.abs(d.totals.differencePaise))}. This usually means
          the sync is incomplete — run the connector again before trusting these
          figures.
        </Text>
      ) : null}
    </Card>
  );
}

function PnlView({ d, money }: { d: Pnl; money: Money }) {
  const profit = d.totals.profitPaise;
  return (
    <>
      <Card style={{ marginTop: 14 }}>
        <Label>{profit >= 0 ? 'Net profit' : 'Net loss'}</Label>
        <Text style={[s.big, { color: profit >= 0 ? T.green : T.red }]}>
          {money(Math.abs(profit))}
        </Text>
        <Muted>
          {money(d.totals.incomePaise, true)} income − {money(d.totals.expensePaise, true)} expenses
        </Muted>
      </Card>
      <Card style={{ marginTop: 12 }}>
        <Label>Income</Label>
        {list(d.income).map((x) => (
          <LineRow key={x.group} left={x.group} right={money(x.amountPaise)} />
        ))}
      </Card>
      <Card style={{ marginTop: 12 }}>
        <Label>Expenses</Label>
        {list(d.expense).length === 0 ? <Muted>No expense ledgers.</Muted>
          : list(d.expense).map((x) => (
            <LineRow key={x.group} left={x.group} right={money(x.amountPaise)} />
          ))}
      </Card>
    </>
  );
}

function BalanceSheetView({ d, money }: { d: BalanceSheet; money: Money }) {
  return (
    <>
      <Card style={{ marginTop: 14 }}>
        <Label>Assets</Label>
        {list(d.assets).map((x) => (
          <LineRow key={x.group} left={x.group} right={money(x.amountPaise)} />
        ))}
        <LineRow strong left="Total assets" right={money(d.totals.assetsPaise)} />
      </Card>
      <Card style={{ marginTop: 12 }}>
        <Label>Liabilities</Label>
        {list(d.liabilities).map((x) => (
          <LineRow key={x.group} left={x.group} right={money(x.amountPaise)} />
        ))}
        <LineRow left="Profit & Loss" right={money(d.profitPaise)} />
        <LineRow strong left="Total" right={money(d.totals.liabilitiesPaise)} />
      </Card>
      <View style={{ marginTop: 12 }}>
        <Badge tone={d.totals.differencePaise === 0 ? 'ok' : 'bad'}>
          {d.totals.differencePaise === 0
            ? 'Balanced' : `Out by ${money(Math.abs(d.totals.differencePaise))}`}
        </Badge>
      </View>
    </>
  );
}

function DayBookView({ d, money }: { d: DayBook; money: Money }) {
  return (
    <Card style={{ marginTop: 14 }}>
      <Label>Day Book — {d.date}</Label>
      <Muted>{d.count} vouchers</Muted>
      <View style={{ marginTop: 8 }}>
        {Object.entries(d.totalsByType ?? {}).map(([t, v]) => (
          <LineRow key={t} left={t} right={money(v)} strong />
        ))}
      </View>
      <View style={{ marginTop: 10 }}>
        {list(d.vouchers).map((v, i) => (
          <LineRow key={`${v.vchType}-${v.vchNo}-${i}`}
            left={v.party || v.vchType} sub={`${v.vchNo} · ${v.vchType}`}
            right={money(Math.abs(v.amountPaise))} />
        ))}
      </View>
    </Card>
  );
}

function SalesView({ d, money }: { d: SalesAnalysis; money: Money }) {
  const max = Math.max(...list(d.rows).map((r) => r.amountPaise), 1);
  return (
    <Card style={{ marginTop: 14 }}>
      <Label>Sales analysis · total {money(d.totalPaise, true)}</Label>
      <View style={{ marginTop: 8 }}>
        {list(d.rows).map((r) => (
          <BarRow key={r.label} label={r.label} value={money(r.amountPaise, true)}
            fraction={r.amountPaise / max} note={String(r.count)} />
        ))}
      </View>
    </Card>
  );
}

function PartyWiseView({ d, money }: { d: PartyWise; money: Money }) {
  return (
    <Card style={{ marginTop: 14 }}>
      <Label>Party-wise sales and purchases</Label>
      {list(d.rows).map((r) => (
        <LineRow key={r.name} left={r.name} sub={`last ${shortDate(r.lastTxn)}`}
          right={money(r.salesPaise, true)}
          subRight={r.purchasesPaise ? `buy ${money(r.purchasesPaise, true)}` : undefined} />
      ))}
    </Card>
  );
}

function InactiveView({ d, money }: { d: Inactive; money: Money }) {
  return (
    <>
      <Card style={{ marginTop: 14 }}>
        <Label>Quiet customers · no purchase in {d.days} days</Label>
        {list(d.parties).length === 0 ? <Muted>Everyone has bought recently.</Muted>
          : list(d.parties).map((p) => (
            <LineRow key={p.name} left={p.name} sub={p.phone || undefined}
              right={money(p.outstandingPaise)}
              subRight={p.daysSince === null ? 'never bought' : `${p.daysSince}d ago`} />
          ))}
        <Text style={s.note}>
          A customer who stopped buying is revenue you can still win back. This
          is the list to call.
        </Text>
      </Card>
      <Card style={{ marginTop: 12 }}>
        <Label>Quiet items · not sold in {d.days} days</Label>
        {list(d.items).length === 0 ? <Muted>Everything is moving.</Muted>
          : list(d.items).map((i) => (
            <LineRow key={i.name} left={i.name}
              right={i.daysSince === null ? 'never' : `${i.daysSince}d`} />
          ))}
      </Card>
    </>
  );
}

function StockView({ d, money }: { d: Stock; money: Money }) {
  return (
    <Card style={{ marginTop: 14 }}>
      <Label>Stock · total {money(d.totalValuePaise, true)}</Label>
      {list(d.items).map((i) => (
        <LineRow key={i.name} left={i.name}
          sub={`${i.qty.toLocaleString('en-IN')} ${i.unit}`}
          right={money(i.valuePaise)} />
      ))}
    </Card>
  );
}

function ExpensesView({ d, money }: { d: Expenses; money: Money }) {
  return (
    <Card style={{ marginTop: 14 }}>
      <Label>Expenses · total {money(d.totalPaise, true)}</Label>
      {list(d.items).length === 0 ? <Muted>No expense ledgers in this company.</Muted>
        : list(d.items).map((i) => (
          <LineRow key={i.name} left={i.name} sub={i.group} right={money(i.amountPaise)} />
        ))}
    </Card>
  );
}

const s = StyleSheet.create({
  wrap: { padding: 16, backgroundColor: T.bg, flexGrow: 1 },
  headName: { fontSize: 19, fontFamily: T.font.bold, color: T.ink, letterSpacing: -0.3 },
  headSub: { fontSize: 12.5, color: T.muted, marginTop: 2, fontFamily: T.font.regular },
  picker: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: T.card, borderRadius: T.radius, borderWidth: 1,
    borderColor: T.line, paddingHorizontal: 16, paddingVertical: 12,
    marginTop: 14, ...T.shadow,
  },
  pickerLabel: { fontSize: 10.5, fontFamily: T.font.semibold, color: T.muted,
                 textTransform: 'uppercase', letterSpacing: 0.8 },
  pickerValue: { fontSize: 16, fontFamily: T.font.bold, color: T.ink, marginTop: 3 },

  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6,53,31,0.35)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '82%',
    backgroundColor: T.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 16, paddingTop: 10,
  },
  grabber: { width: 38, height: 4, borderRadius: 2, backgroundColor: T.line,
             alignSelf: 'center', marginBottom: 12 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
               marginBottom: 10 },
  sheetTitle: { fontSize: 19, fontFamily: T.font.bold, color: T.ink, letterSpacing: -0.3 },
  sheetGroup: { fontSize: 10.5, fontFamily: T.font.semibold, color: T.muted,
                textTransform: 'uppercase', letterSpacing: 0.8,
                marginTop: 12, marginBottom: 4 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 10,
              paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12 },
  sheetRowOn: { backgroundColor: T.greenSoft },
  sheetLabel: { fontSize: 15, fontFamily: T.font.semibold, color: T.ink },
  sheetHint: { fontSize: 12.5, color: T.muted, marginTop: 2, fontFamily: T.font.regular },
  tbHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  tbRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
           borderTopWidth: 1, borderTopColor: T.lineSoft },
  tbName: { fontSize: 14, color: T.ink, fontFamily: T.font.medium },
  tbNature: { fontSize: 11, color: T.faint, marginTop: 2,
              fontFamily: T.font.regular, textTransform: 'capitalize' },
  tbAmount: { fontSize: 14.5, color: T.ink, fontFamily: T.font.semibold,
              letterSpacing: -0.2, fontVariant: ['tabular-nums'] },
  tbTag: { marginTop: 3, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  tbDebit: { backgroundColor: T.infoSoft },
  tbCredit: { backgroundColor: T.goldSoft },
  tbTagText: { fontSize: 9.5, fontFamily: T.font.bold, letterSpacing: 0.5 },
  tbTotals: { flexDirection: 'row', gap: 10, marginTop: 14, paddingTop: 14,
              borderTopWidth: 1.5, borderTopColor: T.line },
  tbTotal: { flex: 1, backgroundColor: T.bg, borderRadius: 12, padding: 11 },
  tbTotalLabel: { fontSize: 10.5, color: T.muted, fontFamily: T.font.semibold,
                  textTransform: 'uppercase', letterSpacing: 0.6 },
  tbTotalValue: { fontSize: 15, color: T.ink, marginTop: 4,
                  fontFamily: T.font.bold, fontVariant: ['tabular-nums'] },
  tbOut: { marginTop: 10, fontSize: 12.5, color: T.negative,
           fontFamily: T.font.medium, lineHeight: 18 },
  seg: {
    flexDirection: 'row', borderRadius: 12, overflow: 'hidden',
    borderWidth: 1, borderColor: T.line, backgroundColor: '#fff', marginBottom: 4,
  },
  segBtn: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: T.green },
  segText: { fontFamily: T.font.bold, color: T.ink, textTransform: 'capitalize' },
  big: { fontSize: 28, fontFamily: T.font.bold, marginTop: 4, fontVariant: ['tabular-nums'] },
  note: { color: T.muted, fontSize: 12, marginTop: 10, lineHeight: 18 },
});
