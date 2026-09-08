import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  TrendingUp, TrendingDown, Minus, ShoppingCart, ArrowDownLeft, ArrowUpRight,
  Wallet, Landmark, Package, Receipt, FileWarning, Clock3, Percent, Coins,
  Users, Truck, Boxes, Layers, Eye, EyeOff, AlertTriangle, ChevronRight,
  Filter, X,
} from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { useMoney } from '../lib/money';
import { ago } from '../lib/format';
import {
  Badge, Button, Card, ErrorNote, Label, Loading, Muted, OfflineBar, Screen, Title,
} from '../components/ui';
import { TrendChart, CashFlowChart, RankBars, Donut, Spark } from '../components/charts';
import { notifyIfNewVouchers } from '../lib/notify';
import { T } from '../theme';

/**
 * The whole business, on a phone.
 *
 * Same eighteen figures and same twelve charts as the web, ordered the way an
 * owner reads them: today first, because that is what they opened the app to
 * see, then the period, then what they are owed, then the charts that explain
 * it.
 */

type Metric = { paise: number; prev?: number; changePct?: number | null;
                count?: number; note?: string };
type Overview = {
  company: { tallyGuid: string; name: string };
  asOf: string;
  period: { key: string; from: string; to: string; label: string };
  metrics: Record<string, Metric>;
  counts?: { salesVouchers: number; vouchersTotal: number };
  charts: {
    salesTrend: { at: string; value: number }[];
    purchaseTrend: { at: string; value: number }[];
    profitTrend: { at: string; value: number }[];
    expenseTrend: { at: string; value: number }[];
    cashFlow: { at: string; in: number; out: number; net: number }[];
    topCustomers: { label: string; value: number }[];
    topSuppliers: { label: string; value: number }[];
    topProducts: { label: string; value: number }[];
    salespeople: { label: string; value: number }[];
    categories: { label: string; value: number }[];
  };
};

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'fy', label: 'Year' },
];

export default function DashboardScreen({ navigation }: any) {
  const { me, company, privacy, togglePrivacy } = useApp();
  const money = useMoney();
  const [period, setPeriod] = useState('fy');
  const [party, setParty] = useState('');
  const [showFilter, setShowFilter] = useState(false);

  const qs = new URLSearchParams({ period });
  if (party) qs.set('party', party);

  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;
  const { data, error, loading, reload, stale, offline } =
    useApi<Overview>(base && `${base}/overview?${qs}`, [company?.tallyGuid, period, party]);

  const attn = useApi<{ items: { key: string; label: string; count: number;
                                tone: 'ok' | 'warn' | 'bad' }[] }>(
    base && `${base}/attention`, [company?.tallyGuid]);

  const opts = useApi<{ parties: string[] }>(base && `${base}/filters`, [company?.tallyGuid]);

  if (!me) return <Loading />;

  if (me.companies.length === 0) {
    return (
      <Screen>
        <Title>Welcome, {me.org.name}</Title>
        <Muted>One step left: connect the computer that runs Tally.</Muted>
        <Card style={{ marginTop: 16 }}>
          <Text style={s.body}>
            Munim reads your books straight from Tally. Nothing to import, and
            nothing to keep updating by hand.
          </Text>
          <Button title="Connect your Tally" onPress={() => navigation.navigate('LinkTally')} />
          <Text style={s.readOnly}>
            Munim reads your Tally data. The only thing it writes is a voucher
            you create here and send. Nothing already in your books is changed.
          </Text>
        </Card>
      </Screen>
    );
  }

  if (error) return <Screen><ErrorNote message={error} onRetry={reload} /></Screen>;
  if (loading && !data) return <Loading label="Adding everything up…" />;
  if (!data) return <Loading />;

  // Fire-and-forget: a notification that fails must never break the screen
  // that was about to show the figures.
  void notifyIfNewVouchers(data.company.name, data.counts?.vouchersTotal ?? 0, true);
  const m = data.metrics;

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <View style={s.head}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.headName} numberOfLines={1}>{data.company.name}</Text>
            <View style={{ flexDirection: 'row', marginTop: 5 }}>
              <Badge tone="ok">{data.period.label} · books to {data.asOf}</Badge>
            </View>
          </View>
          {/* Owners open this in front of staff. One tap hides every figure. */}
          <Pressable onPress={togglePrivacy} style={s.eye} hitSlop={12}>
            {privacy ? <Eye size={18} color={T.muted} /> : <EyeOff size={18} color={T.muted} />}
          </Pressable>
        </View>
      }
    >
      <OfflineBar offline={offline} ageMs={stale} />

      {/* Problems before totals. A healthy sales figure buries the customer
          who has stopped paying, and that is why the app was opened. */}
      <AttentionBanner items={attn.data?.items} onPress={() => navigation.navigate('Insights')} />

      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 7, paddingBottom: 12 }}>
        {PERIODS.map((p) => (
          <Pressable key={p.key} onPress={() => setPeriod(p.key)}
            style={[s.chip, period === p.key && s.chipOn]}>
            <Text style={[s.chipText, period === p.key && s.chipTextOn]}>{p.label}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setShowFilter(!showFilter)}
          style={[s.chip, party ? s.chipFiltered : null]}>
          <Filter size={13} color={party ? T.card : T.inkSoft} />
        </Pressable>
      </ScrollView>

      {showFilter ? (
        <Card style={{ marginBottom: 14 }}>
          <Label>Show only one party</Label>
          <ScrollView style={{ maxHeight: 180 }}>
            {(opts.data?.parties ?? []).slice(0, 60).map((p) => (
              <Pressable key={p} onPress={() => { setParty(party === p ? '' : p); }}
                style={s.partyRow}>
                <Text style={[s.partyText, party === p && { color: T.green, fontFamily: T.font.bold }]}>
                  {p}
                </Text>
                {party === p ? <X size={14} color={T.green} /> : null}
              </Pressable>
            ))}
          </ScrollView>
        </Card>
      ) : null}

      <Text style={s.section}>Today</Text>
      <View style={s.grid}>
        <Tile label="Sales" m={m.todaySales} icon={TrendingUp} money={money} tone="good" />
        <Tile label="Purchases" m={m.todayPurchases} icon={ShoppingCart} money={money} />
        <Tile label="Received" m={m.todayReceipts} icon={ArrowDownLeft} money={money} tone="good" />
        <Tile label="Paid" m={m.todayPayments} icon={ArrowUpRight} money={money} tone="bad" />
      </View>

      <Text style={s.section}>{data.period.label}</Text>
      <View style={s.grid}>
        <Tile label="Sales" m={m.sales} icon={TrendingUp} money={money} tone="good"
          spark={data.charts.salesTrend} />
        <Tile label="Purchases" m={m.purchases} icon={ShoppingCart} money={money}
          spark={data.charts.purchaseTrend} />
        <Tile label="Gross profit" m={m.grossProfit} icon={Percent} money={money}
          tone={m.grossProfit.paise >= 0 ? 'good' : 'bad'} />
        <Tile label="Net profit" m={m.netProfit} icon={Coins} money={money}
          tone={m.netProfit.paise >= 0 ? 'good' : 'bad'} />
      </View>

      <Text style={s.section}>Money</Text>
      <View style={s.grid}>
        <Tile label="Receivables" m={m.receivables} icon={ArrowDownLeft} money={money} tone="good" />
        <Tile label="Payables" m={m.payables} icon={ArrowUpRight} money={money} tone="bad" />
        <Tile label="Cash" m={m.cash} icon={Wallet} money={money} />
        <Tile label="Bank" m={m.bank} icon={Landmark} money={money} />
        <Tile label="Stock" m={m.stock} icon={Package} money={money} />
        <Tile label="Expenses" m={m.expenses} icon={Receipt} money={money} tone="bad" />
        <Tile label="GST payable" m={m.gstPayable} icon={FileWarning} money={money} tone="bad" />
        <Tile label="GST credit" m={m.gstReceivable} icon={FileWarning} money={money} tone="good" />
      </View>

      <Pressable onPress={() => navigation.navigate('Outstanding')}>
        <Card style={{ marginTop: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Text style={s.small}>Overdue</Text>
              <Text style={[s.big, { color: T.negative }]}>
                {money(m.overdueInvoices.paise)}
              </Text>
              <Text style={s.small}>
                {m.overdueInvoices.count} of {m.outstandingInvoices.count} bills past due
              </Text>
            </View>
            <ChevronRight size={18} color={T.faint} />
          </View>
        </Card>
      </Pressable>

      <Text style={s.section}>Cash flow</Text>
      <Card><CashFlowChart data={data.charts.cashFlow} money={money} /></Card>

      <Text style={s.section}>Sales trend</Text>
      <Card><TrendChart data={data.charts.salesTrend} money={money} /></Card>

      <Text style={s.section}>Purchase trend</Text>
      <Card><TrendChart data={data.charts.purchaseTrend} colour={T.info} money={money} /></Card>

      <Text style={s.section}>Profit trend</Text>
      <Card><TrendChart data={data.charts.profitTrend} colour={T.gold} money={money} /></Card>

      <Text style={s.section}>Payments out</Text>
      <Card><TrendChart data={data.charts.expenseTrend} colour={T.negative} money={money} /></Card>

      <Text style={s.section}>Top customers</Text>
      <Card><RankBars data={data.charts.topCustomers} money={money} /></Card>

      <Text style={s.section}>Top suppliers</Text>
      <Card><RankBars data={data.charts.topSuppliers} colour={T.info} money={money} /></Card>

      <Text style={s.section}>Top products</Text>
      <Card><RankBars data={data.charts.topProducts} colour={T.gold} money={money} /></Card>

      {data.charts.salespeople.length > 0 ? (
        <>
          <Text style={s.section}>Salespeople</Text>
          <Card><RankBars data={data.charts.salespeople} colour="#6FA82B" money={money} /></Card>
        </>
      ) : null}

      <Text style={s.section}>Sales by category</Text>
      <Card><Donut data={data.charts.categories} money={money} /></Card>
    </Screen>
  );
}

function Tile({ label, m, icon: Icon, money, tone, spark }: {
  label: string; m: Metric; icon: typeof TrendingUp;
  money: (p: number, o?: { compact?: boolean }) => string; tone?: 'good' | 'bad';
  spark?: { at: string; value: number }[];
}) {
  const colour = tone === 'good' ? T.positive : tone === 'bad' ? T.negative : T.ink;
  const up = m.changePct != null && m.changePct > 0;
  const flat = m.changePct == null || m.changePct === 0;
  const Delta = flat ? Minus : up ? TrendingUp : TrendingDown;
  const deltaColour = flat ? T.muted : up ? T.positive : T.negative;

  return (
    <View style={s.tile}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={s.tileLabel}>{label}</Text>
        <Icon size={14} color={T.faint} />
      </View>
      <Text style={[s.tileValue, { color: colour }]} numberOfLines={1}>
        {money(m.paise, { compact: true })}
      </Text>
      {m.changePct != null ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 }}>
          <Delta size={11} color={deltaColour} />
          <Text style={[s.tileDelta, { color: deltaColour }]}>
            {m.changePct > 0 ? '+' : ''}{m.changePct}%
          </Text>
        </View>
      ) : null}
      {spark && spark.length > 1 ? (
        <View style={{ marginTop: 4 }}>
          <Spark data={spark} colour={tone === 'bad' ? T.negative : T.green} />
        </View>
      ) : null}
    </View>
  );
}

function AttentionBanner({ items, onPress }: {
  items?: { key: string; label: string; count: number; tone: 'ok' | 'warn' | 'bad' }[];
  onPress: () => void;
}) {
  if (!items) return null;
  const bad = items.filter((i) => i.count > 0);
  if (!bad.length) return null;
  const urgent = bad.some((i) => i.tone === 'bad');
  const colour = urgent ? T.negative : T.warn;

  return (
    <Pressable onPress={onPress}
      style={[s.banner, { backgroundColor: urgent ? T.negativeSoft : T.warnSoft }]}>
      <AlertTriangle size={18} color={colour} />
      <View style={{ flex: 1 }}>
        <Text style={[s.bannerTitle, { color: colour }]}>
          {bad.length === 1 ? '1 thing needs attention' : `${bad.length} things need attention`}
        </Text>
        <Text style={s.bannerBody} numberOfLines={1}>
          {bad.map((i) => `${i.count} ${i.label.toLowerCase()}`).join(' · ')}
        </Text>
      </View>
      <ChevronRight size={16} color={colour} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headName: { fontFamily: T.font.bold, fontSize: 17, color: T.ink },
  eye: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  section: {
    fontFamily: T.font.bold, fontSize: 13, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 22, marginBottom: 10,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: {
    flexGrow: 1, flexBasis: '46%', backgroundColor: T.card,
    borderRadius: T.radiusSm, padding: 12, ...T.shadow,
  },
  tileLabel: { fontFamily: T.font.medium, fontSize: 11, color: T.muted },
  tileValue: { fontFamily: T.font.bold, fontSize: 18, marginTop: 4 },
  tileDelta: { fontFamily: T.font.semibold, fontSize: 11 },
  big: { fontFamily: T.font.bold, fontSize: 21, color: T.ink, marginTop: 2 },
  small: { fontFamily: T.font.regular, fontSize: 11, color: T.muted },
  body: { fontFamily: T.font.regular, fontSize: 14, color: T.inkSoft, lineHeight: 21 },
  readOnly: {
    fontFamily: T.font.regular, fontSize: 12, color: T.greenDark,
    backgroundColor: T.greenSoft, borderRadius: T.radiusSm,
    padding: 10, marginTop: 14, lineHeight: 17,
  },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    backgroundColor: T.lineSoft, flexDirection: 'row', alignItems: 'center', gap: 5,
  },
  chipOn: { backgroundColor: T.green },
  chipFiltered: { backgroundColor: T.gold },
  chipText: { fontFamily: T.font.semibold, fontSize: 12, color: T.inkSoft },
  chipTextOn: { color: T.card },
  partyRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 9, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  partyText: { fontFamily: T.font.regular, fontSize: 13, color: T.inkSoft, flex: 1 },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 11,
    borderRadius: T.radiusSm, padding: 14, marginBottom: 14,
  },
  bannerTitle: { fontFamily: T.font.semibold, fontSize: 14 },
  bannerBody: { fontFamily: T.font.regular, fontSize: 12, color: T.inkSoft, marginTop: 2 },
});
