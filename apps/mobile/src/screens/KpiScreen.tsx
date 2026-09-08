import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp, useApi } from '../lib/store';
import { type Kpis } from '../lib/api';
import { inr } from '../lib/format';
import {
  Card, Empty, ErrorNote, Label, Loading, Muted, OfflineBar, Screen, StatTile,
} from '../components/ui';
import { T } from '../theme';
import { TrendingUp, TrendingDown, Info, AlertTriangle } from 'lucide-react-native';

/**
 * The numbers a business is run on, on the phone.
 *
 * Same figures as the web, same caveats. The caveats travel with the numbers
 * rather than being dropped for space: a shop owner reading "40% margin" on a
 * phone will act on it exactly as readily as on a desk, and the reason that
 * figure is approximate does not get less important on a smaller screen.
 */
export default function KpiScreen() {
  const { company } = useApp();
  const guid = company?.tallyGuid;
  const { data, error, loading, reload, stale, offline } =
    useApi<Kpis>(guid ? `/v1/companies/${encodeURIComponent(guid)}/kpi` : null);

  if (!guid) {
    return (
      <View style={s.wrap}>
        <Empty title="No company yet"
          hint="Connect the computer running Tally and these fill in on their own." />
      </View>
    );
  }
  if (error) return <View style={s.wrap}><ErrorNote message={error} onRetry={reload} /></View>;
  if (!data) return <Loading label="Working out your numbers…" />;

  const { sales: sa, collection: c, purchases: p, inventory: i, profitability: pr } = data;

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <View>
          <OfflineBar offline={offline} ageMs={stale} />
          <Text style={s.headName}>Key numbers</Text>
          <Text style={s.headSub}>{company?.name} · {sa.period.label}</Text>
        </View>
      }
    >
      <View style={{ marginTop: 18 }}><Label>Sales</Label></View>
      <View style={s.grid}>
        <Metric label="Revenue" value={inr(sa.revenuePaise)} delta={sa.growthPercent} />
        <Metric label="Invoices" value={sa.invoices.toLocaleString('en-IN')} />
        <Metric label="Average invoice" value={inr(sa.averageInvoicePaise)} />
        <Metric label="Biggest customer"
          value={sa.concentration ? `${sa.concentration.topCustomerPercent}%` : '—'}
          sub={sa.topCustomers[0]?.party ?? ''}
          warn={Boolean(sa.concentration && sa.concentration.topCustomerPercent > 40)} />
      </View>

      {sa.topCustomers.length > 0 ? (
        <Card style={{ marginTop: 12 }}>
          <Label>Top customers</Label>
          {sa.topCustomers.slice(0, 5).map((x) => (
            <Row key={x.party} left={x.party} right={inr(x.amountPaise)}
              sub={`${x.sharePercent}% of revenue`} />
          ))}
        </Card>
      ) : null}

      <View style={{ marginTop: 20 }}><Label>Collection</Label></View>
      <View style={s.grid}>
        <Metric label="Receivable" value={inr(c.receivablePaise)}
          sub={`${c.bills} open bills`} />
        <Metric label="Overdue" value={inr(c.overduePaise)}
          sub={c.overdueBills ? `oldest ${c.oldestOverdueDays}d` : 'nothing overdue'}
          warn={c.overduePaise > 0} />
        <Metric label="Days to pay"
          value={c.averagePaymentDays === null ? '—' : String(c.averagePaymentDays)}
          sub={c.averagePaymentBasis} />
        <Metric label="DSO"
          value={c.dsoDays === null ? '—' : `${c.dsoDays}d`} sub={c.dsoNote} />
      </View>

      <View style={{ marginTop: 20 }}><Label>Purchases</Label></View>
      <View style={s.grid}>
        <Metric label="Purchases" value={inr(p.amountPaise)} delta={p.growthPercent} />
        <Metric label="Bills" value={p.bills.toLocaleString('en-IN')} />
      </View>
      {p.concentration?.warning ? (
        <Card style={{ ...s.warn, marginTop: 12 }}>
          <View style={s.warnRow}>
            <AlertTriangle size={15} strokeWidth={2.2} color="#b45309" />
            <Text style={s.warnText}>
              {p.concentration.warning} If they raise prices or close, there is no
              second source in your books.
            </Text>
          </View>
        </Card>
      ) : null}

      <View style={{ marginTop: 20 }}><Label>Stock</Label></View>
      <View style={s.grid}>
        <Metric label="Stock value" value={inr(i.stockValuePaise)} sub={`${i.items} items`} />
        <Metric label="Turns"
          value={i.turnsBySalesValue === null ? '—' : `${i.turnsBySalesValue}×`}
          sub="by sales value" />
        <Metric label="Dead stock" value={inr(i.deadStock.valuePaise)}
          sub={`${i.deadStock.count} items`} warn={i.deadStock.count > 0} />
        <Metric label="Low stock" value={String(i.lowStock)} warn={i.lowStock > 0} />
      </View>
      <Note>{i.turnoverNote}</Note>
      {i.negativeStock.note ? <Note>{i.negativeStock.note}</Note> : null}

      <View style={{ marginTop: 20 }}><Label>Profitability</Label></View>
      <View style={s.grid}>
        <Metric label="Gross profit" value={inr(pr.grossProfitPaise)}
          sub={pr.grossMarginPercent === null ? '' : `${pr.grossMarginPercent}% margin`} />
        <Metric label="Net profit" value={inr(pr.netProfitPaise)}
          sub={pr.netMarginPercent === null ? '' : `${pr.netMarginPercent}% margin`}
          warn={pr.netProfitPaise < 0} />
        <Metric label="Expenses"
          value={inr(pr.directExpensesPaise + pr.indirectExpensesPaise)}
          sub={pr.expenseRatioPercent === null ? '' : `${pr.expenseRatioPercent}% of sales`} />
        <Metric label="Other income" value={inr(pr.otherIncomePaise)} />
      </View>
      <Note>{pr.basis}</Note>

      <View style={{ height: 12 }} />
    </Screen>
  );
}

function Metric({ label, value, sub, delta, warn }: {
  label: string; value: string; sub?: string; delta?: number | null; warn?: boolean;
}) {
  return (
    <View style={s.cell}>
      <Card style={warn ? { borderColor: '#fde68a', borderWidth: 1 } : undefined}>
        <Text style={s.mLabel}>{label}</Text>
        <Text style={[s.mValue, warn && { color: '#b45309' }]} numberOfLines={1}>
          {value}
        </Text>
        <View style={s.mFoot}>
          {delta !== undefined && delta !== null ? (
            <View style={s.delta}>
              {delta >= 0
                ? <TrendingUp size={11} strokeWidth={2.4} color="#047857" />
                : <TrendingDown size={11} strokeWidth={2.4} color="#b91c1c" />}
              <Text style={[s.deltaText, { color: delta >= 0 ? '#047857' : '#b91c1c' }]}>
                {Math.abs(delta)}%
              </Text>
            </View>
          ) : null}
          {sub ? <Text style={s.mSub} numberOfLines={2}>{sub}</Text> : null}
        </View>
      </Card>
    </View>
  );
}

function Row({ left, right, sub }: { left: string; right: string; sub: string }) {
  return (
    <View style={s.row}>
      <View style={{ flex: 1 }}>
        <Text style={s.rowLeft} numberOfLines={1}>{left}</Text>
        <Text style={s.rowSub}>{sub}</Text>
      </View>
      <Text style={s.rowRight}>{right}</Text>
    </View>
  );
}

/** A caveat that belongs next to the number, not in a footnote nobody reads. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <View style={s.note}>
      <Info size={12} strokeWidth={2.2} color={T.faint} />
      <Text style={s.noteText}>{children}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 16, backgroundColor: T.bg },
  headName: { fontSize: 24, fontWeight: '800', color: T.ink },
  headSub: { fontSize: 13, color: T.muted, marginTop: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10, marginHorizontal: -4 },
  cell: { width: '50%', paddingHorizontal: 4, paddingBottom: 8 },
  mLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.6,
            textTransform: 'uppercase', color: T.muted },
  mValue: { fontSize: 19, fontWeight: '800', color: T.ink, marginTop: 4 },
  mFoot: { marginTop: 4, gap: 2 },
  delta: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  deltaText: { fontSize: 11, fontWeight: '700' },
  mSub: { fontSize: 10, color: T.faint, lineHeight: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7,
         borderBottomWidth: 1, borderBottomColor: T.line },
  rowLeft: { fontSize: 13, color: T.ink },
  rowSub: { fontSize: 11, color: T.faint, marginTop: 1 },
  rowRight: { fontSize: 13, fontWeight: '700', color: T.ink },
  warn: { backgroundColor: '#fffbeb', borderColor: '#fde68a', borderWidth: 1 },
  warnRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  warnText: { flex: 1, fontSize: 12, color: '#78350f', lineHeight: 18 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8,
          backgroundColor: T.bg, borderRadius: 8, padding: 8 },
  noteText: { flex: 1, fontSize: 11, color: T.faint, lineHeight: 16 },
});
