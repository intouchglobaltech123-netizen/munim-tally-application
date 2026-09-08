import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  AlertTriangle, CheckCircle2, TrendingUp, TrendingDown, Minus, Trophy,
  CalendarClock, Hourglass,
} from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { inr, shortDate, mask } from '../lib/format';
import {
  Card, EmptyState, ErrorNote, Loading, Muted, OfflineBar, Screen, Title,
} from '../components/ui';
import { T } from '../theme';

/**
 * The numbers a shop owner acts on.
 *
 * Problems come first and figures second, which is the opposite of an
 * accounting report. A healthy total at the top hides the one customer who has
 * stopped paying, and that customer is the reason to open the app.
 */

type Attention = {
  asOf: string; quietDays: number;
  items: { key: string; label: string; count: number; amountPaise: number | null;
           tone: 'ok' | 'warn' | 'bad'; hint: string }[];
};
type Ageing = {
  asOf: string; buckets: { label: string; amountPaise: number }[];
  totalPaise: number; overduePaise: number;
};
type Projections = {
  asOf: string; next15Paise: number; next60Paise: number; overduePaise: number;
};
type Top = {
  by: string; label: string; days: number; totalPaise: number;
  rows: { label: string; amountPaise: number; count: number; sharePct: number }[];
};
type Trends = {
  asOf: string;
  windows: { days: number; amountPaise: number; prevPaise: number; changePct: number | null }[];
};

const DIMENSIONS = [
  { key: 'customer', label: 'Customers' },
  { key: 'item', label: 'Items' },
  { key: 'debtor', label: 'Owes most' },
  { key: 'supplier', label: 'Suppliers' },
  { key: 'voucher-type', label: 'Types' },
];

// Later buckets are older money, so the colour walks from healthy to alarming.
const BUCKET_COLOURS = [T.positive, '#6FA82B', T.warn, '#C4610A', T.negative, '#7A1A15'];

export default function InsightsScreen() {
  const { company, privacy } = useApp();
  const [by, setBy] = useState('customer');

  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;
  const attn = useApi<Attention>(base && `${base}/attention`, [company?.tallyGuid]);
  const age = useApi<Ageing>(base && `${base}/ageing`, [company?.tallyGuid]);
  const proj = useApi<Projections>(base && `${base}/projections`, [company?.tallyGuid]);
  const trend = useApi<Trends>(base && `${base}/trends`, [company?.tallyGuid]);
  const top = useApi<Top>(base && `${base}/top?by=${by}&days=365&limit=10`,
    [company?.tallyGuid, by]);

  const money = (p: number, compact = false) =>
    privacy ? mask(inr(p, { compact })) : inr(p, { compact });

  if (!company) {
    return (
      <Screen>
        <EmptyState title="No company yet" icon={Trophy}
          hint="Connect the computer running Tally and these fill in on their own." />
      </Screen>
    );
  }
  if (attn.error) return <Screen><ErrorNote message={attn.error} onRetry={attn.reload} /></Screen>;
  if (attn.loading && !attn.data) return <Loading label="Reading your books…" />;

  return (
    <Screen onRefresh={attn.reload} refreshing={attn.loading} tabBar={false}>
      <OfflineBar offline={attn.offline} ageMs={attn.stale} />
      <Title>Insights</Title>
      <Muted>
        What to act on today{attn.data ? `, as on ${shortDate(attn.data.asOf)}` : ''}.
      </Muted>

      <Text style={s.section}>Needs attention</Text>
      {attn.data?.items.map((it) => (
        <AttentionRow key={it.key} item={it} money={money} />
      ))}

      <Text style={s.section}>How old the money is</Text>
      {age.data && <AgeingCard data={age.data} money={money} />}

      <Text style={s.section}>What is coming in</Text>
      {proj.data && <ProjectionCard data={proj.data} money={money} />}

      <Text style={s.section}>Sales momentum</Text>
      {trend.data && (
        <View style={{ gap: 10 }}>
          {trend.data.windows.map((w) => <TrendRow key={w.days} w={w} money={money} />)}
        </View>
      )}

      <Text style={s.section}>Rankings</Text>
      {/* Horizontal chips rather than a dropdown: switching dimension is the
          main thing done on this card, and a picker hides that. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingBottom: 12, paddingRight: 4 }}>
        {DIMENSIONS.map((d) => (
          <Pressable key={d.key} onPress={() => setBy(d.key)}
            style={[s.chip, by === d.key && s.chipOn]}>
            <Text style={[s.chipText, by === d.key && s.chipTextOn]}>{d.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Card>
        {top.loading && !top.data ? <Muted>Loading…</Muted>
          : !top.data?.rows.length
            ? <Muted>Nothing to rank yet. This fills in as soon as Tally has entries of this kind.</Muted>
            : <Ranking data={top.data} money={money} />}
      </Card>
    </Screen>
  );
}

type Money = (p: number, compact?: boolean) => string;

function AttentionRow({ item, money }: { item: Attention['items'][number]; money: Money }) {
  const clean = item.count === 0;
  const tone = clean
    ? { bg: T.positiveSoft, fg: T.positive, Icon: CheckCircle2 }
    : item.tone === 'bad'
      ? { bg: T.negativeSoft, fg: T.negative, Icon: AlertTriangle }
      : { bg: T.warnSoft, fg: T.warn, Icon: AlertTriangle };

  return (
    <View style={[s.attn, { backgroundColor: tone.bg }]}>
      <tone.Icon size={18} color={tone.fg} style={{ marginTop: 2 }} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 7 }}>
          <Text style={[s.attnCount, { color: tone.fg }]}>{item.count}</Text>
          <Text style={s.attnLabel}>{item.label}</Text>
        </View>
        {item.amountPaise != null && item.amountPaise > 0 && (
          <Text style={s.attnAmount}>{money(item.amountPaise)}</Text>
        )}
        <Text style={s.attnHint}>{clean ? 'Nothing to do here.' : item.hint}</Text>
      </View>
    </View>
  );
}

function AgeingCard({ data, money }: { data: Ageing; money: Money }) {
  if (data.totalPaise === 0) {
    return <Card><Muted>Nothing outstanding — every bill is settled.</Muted></Card>;
  }
  const max = Math.max(...data.buckets.map((b) => b.amountPaise), 1);
  const pct = Math.round((data.overduePaise / data.totalPaise) * 100);

  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 }}>
        <View>
          <Text style={s.big}>{money(data.totalPaise, true)}</Text>
          <Text style={s.small}>owed to you</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={[s.big, { color: T.negative }]}>{money(data.overduePaise, true)}</Text>
          <Text style={s.small}>{pct}% past due</Text>
        </View>
      </View>
      {data.buckets.map((b, i) => (
        <View key={b.label} style={s.bar}>
          <Text style={s.barLabel}>{b.label}d</Text>
          <View style={s.barTrack}>
            <View style={{
              height: '100%', borderRadius: 999,
              backgroundColor: BUCKET_COLOURS[i] ?? T.muted,
              width: `${(b.amountPaise / max) * 100}%`,
            }} />
          </View>
          <Text style={s.barValue}>
            {b.amountPaise > 0 ? money(b.amountPaise, true) : '—'}
          </Text>
        </View>
      ))}
    </Card>
  );
}

function ProjectionCard({ data, money }: { data: Projections; money: Money }) {
  const rows = [
    { label: 'Already overdue', paise: data.overduePaise, colour: T.negative,
      hint: 'Due date has passed. Chase these.' },
    { label: 'Due in 15 days', paise: data.next15Paise, colour: T.warn,
      hint: 'Expect this in the next fortnight.' },
    { label: 'Due in 60 days', paise: data.next60Paise, colour: T.positive,
      hint: 'Includes the 15-day figure above.' },
  ];
  return (
    <Card>
      {rows.map((r, i) => (
        <View key={r.label} style={[s.projRow, i > 0 && s.projDivider]}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={s.projLabel}>{r.label}</Text>
            <Text style={s.attnHint}>{r.hint}</Text>
          </View>
          <Text style={[s.projValue, { color: r.colour }]}>{money(r.paise, true)}</Text>
        </View>
      ))}
    </Card>
  );
}

function TrendRow({ w, money }: { w: Trends['windows'][number]; money: Money }) {
  const flat = w.changePct == null || w.changePct === 0;
  const up = w.changePct != null && w.changePct > 0;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  const colour = flat ? T.muted : up ? T.positive : T.negative;
  const name = w.days === 7 ? 'This week' : w.days === 30 ? 'This month' : 'This quarter';

  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={s.small}>{name}</Text>
          <Text style={s.big}>{money(w.amountPaise, true)}</Text>
          <Text style={s.small}>previous {w.days} days: {money(w.prevPaise, true)}</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon size={16} color={colour} />
          <Text style={{ color: colour, fontFamily: T.font.bold, fontSize: 15 }}>
            {w.changePct == null ? '—' : `${w.changePct > 0 ? '+' : ''}${w.changePct}%`}
          </Text>
        </View>
      </View>
    </Card>
  );
}

function Ranking({ data, money }: { data: Top; money: Money }) {
  const max = Math.max(...data.rows.map((r) => r.amountPaise), 1);
  return (
    <View>
      {data.rows.map((r, i) => (
        <View key={r.label} style={s.rankRow}>
          <Text style={s.rankNum}>{i + 1}</Text>
          <View style={{ flex: 1 }}>
            <Text style={s.rankLabel} numberOfLines={1}>{r.label}</Text>
            <View style={[s.barTrack, { marginTop: 6, height: 5 }]}>
              <View style={{
                height: '100%', borderRadius: 999, backgroundColor: T.greenMid,
                width: `${(r.amountPaise / max) * 100}%`,
              }} />
            </View>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={s.rankValue}>{money(r.amountPaise, true)}</Text>
            <Text style={s.small}>{r.sharePct}%</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  section: {
    fontFamily: T.font.bold, fontSize: 13, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.6,
    marginTop: 26, marginBottom: 10,
  },
  attn: {
    flexDirection: 'row', gap: 11, padding: 14,
    borderRadius: T.radiusSm, marginBottom: 9,
  },
  attnCount: { fontFamily: T.font.bold, fontSize: 22 },
  attnLabel: { fontFamily: T.font.semibold, fontSize: 14, color: T.inkSoft, flex: 1 },
  attnAmount: { fontFamily: T.font.semibold, fontSize: 14, color: T.ink, marginTop: 1 },
  attnHint: { fontFamily: T.font.regular, fontSize: 12, color: T.muted, marginTop: 3, lineHeight: 17 },

  big: { fontFamily: T.font.bold, fontSize: 21, color: T.ink },
  small: { fontFamily: T.font.regular, fontSize: 12, color: T.muted },

  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  barLabel: { width: 58, fontFamily: T.font.medium, fontSize: 11, color: T.muted },
  barTrack: { flex: 1, height: 8, borderRadius: 999, backgroundColor: T.lineSoft, overflow: 'hidden' },
  barValue: { width: 78, textAlign: 'right', fontFamily: T.font.semibold, fontSize: 11, color: T.inkSoft },

  projRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  projDivider: { borderTopWidth: 1, borderTopColor: T.lineSoft },
  projLabel: { fontFamily: T.font.semibold, fontSize: 14, color: T.inkSoft },
  projValue: { fontFamily: T.font.bold, fontSize: 17 },

  chip: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
    backgroundColor: T.lineSoft,
  },
  chipOn: { backgroundColor: T.green },
  chipText: { fontFamily: T.font.semibold, fontSize: 13, color: T.inkSoft },
  chipTextOn: { color: T.card },

  rankRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 9 },
  rankNum: { width: 18, textAlign: 'center', fontFamily: T.font.bold, fontSize: 12, color: T.faint },
  rankLabel: { fontFamily: T.font.medium, fontSize: 14, color: T.ink },
  rankValue: { fontFamily: T.font.semibold, fontSize: 14, color: T.ink },
});
