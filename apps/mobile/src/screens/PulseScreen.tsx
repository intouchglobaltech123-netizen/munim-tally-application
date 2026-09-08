import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp, useApi } from '../lib/store';
import { type Pulse, type Mover, type RhythmDay } from '../lib/api';
import { inr } from '../lib/format';
import {
  Badge, Card, CardSkeleton, Empty, ErrorNote, Label, Loading, Muted, OfflineBar,
  Screen, Settling,
} from '../components/ui';
import { T } from '../theme';
import { Info } from 'lucide-react-native';

/**
 * The questions the totals do not answer.
 *
 * Same four as the web: who is slow, what moved, when the shop sells, how long
 * the money lasts. Runway leads because it is the only one that can be an
 * emergency, and an owner checking their phone at 11pm is usually checking for
 * an emergency.
 */
export default function PulseScreen() {
  const { company } = useApp();
  const [window, setWindow] = useState(90);
  const guid = company?.tallyGuid;

  const { data, error, loading, refreshing, reload, stale, offline } = useApi<Pulse>(
    guid ? `/v1/companies/${encodeURIComponent(guid)}/pulse?days=${window}` : null);

  if (!guid) {
    return (
      <View style={s.wrap}>
        <Empty title="No company yet"
          hint="Connect Tally and these fill in on their own." />
      </View>
    );
  }
  if (error) return <View style={s.wrap}><ErrorNote message={error} onRetry={reload} /></View>;

  /*
   * Skeletons only on a genuine first load. Changing the window keeps the
   * screen and greys the figures instead - see Settling below.
   */
  if (!data) {
    return (
      <View style={s.wrap}>
        <Text style={s.headName}>Pulse</Text>
        <CardSkeleton count={4} />
      </View>
    );
  }

  const { payers, movers, rhythm, runway } = data;
  const runwayTone = runway.tone === 'bad' ? s.bad
    : runway.tone === 'warn' ? s.warn : s.plain;

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <View>
          <OfflineBar offline={offline} ageMs={stale} />
          <Text style={s.headName}>Pulse</Text>
          <Text style={s.headSub}>What the totals do not tell you</Text>
        </View>
      }
    >
      <View style={s.chips}>
        {[30, 90, 365].map((d) => (
          <Pressable key={d} onPress={() => setWindow(d)}
            style={[s.chip, window === d && s.chipOn]}>
            <Text style={[s.chipText, window === d && s.chipTextOn]}>
              {d === 365 ? '1 year' : `${d} days`}
            </Text>
          </Pressable>
        ))}
      </View>

      <Settling when={refreshing}>
      {/* Runway first: the only one that can be an emergency. */}
      <View style={{ marginTop: 18 }}><Label>How long the money lasts</Label></View>
      <Card style={{ ...runwayTone, marginTop: 10 }}>
        <Text style={s.runwayFigure}>
          {runway.months === null ? 'Unknown' : `${runway.months} months`}
        </Text>
        {runway.monthsWithReceivables !== null ? (
          <Text style={s.runwaySub}>
            {runway.monthsWithReceivables} months if everything owed comes in
          </Text>
        ) : null}
        <View style={s.runwayGrid}>
          <Small k="Cash & bank" v={inr(runway.liquidPaise)} />
          <Small k="Monthly spend"
            v={runway.monthlyBurnPaise ? inr(runway.monthlyBurnPaise) : '—'} />
          <Small k="Owed to you" v={inr(runway.receivablePaise)} />
        </View>
        <Text style={s.basis}>{runway.basis}</Text>
      </Card>

      <View style={{ marginTop: 20 }}><Label>Slowest to pay</Label></View>
      {payers.worst.length === 0 ? (
        <Card style={{ marginTop: 10 }}>
          <Muted>
            {payers.payers.length
              ? 'Nobody is consistently late.'
              : 'Nothing settled in this window yet, so there is no pattern to read.'}
          </Muted>
        </Card>
      ) : payers.worst.map((p) => (
        <Card key={p.party} style={{ marginTop: 8 }}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{p.party}</Text>
              <Text style={s.sub}>
                {p.bills} bills · {p.averageDays} days on average · {p.verdict}
              </Text>
            </View>
            <Badge tone="bad">
              {p.daysAgainstTerms === null ? 'no terms' : `${p.daysAgainstTerms}d late`}
            </Badge>
          </View>
        </Card>
      ))}

      <View style={{ marginTop: 20 }}><Label>What changed</Label></View>
      <MoverList title="Buying more" rows={movers.grew} good />
      <MoverList title="Buying less" rows={movers.shrank} />
      <MoverList title="Stopped buying" rows={movers.lost} field="beforePaise" />
      <MoverList title="New customers" rows={movers.won} field="nowPaise" good />

      <View style={{ marginTop: 20 }}><Label>When you sell</Label></View>
      <Card style={{ marginTop: 10 }}>
        <Text style={s.summary}>{rhythm.summary}</Text>
        <View style={{ marginTop: 10 }}>
          {rhythm.byDay.map((d) => <DayBar key={d.day} d={d} days={rhythm.byDay} />)}
        </View>
        {rhythm.closedOn.length ? (
          <Text style={s.basis}>No trading on {rhythm.closedOn.join(', ')}.</Text>
        ) : null}
      </Card>

      <View style={s.note}>
        <Info size={12} strokeWidth={2.2} color={T.faint} />
        <Text style={s.noteText}>{payers.note}</Text>
      </View>
      </Settling>
    </Screen>
  );
}

function MoverList({ title, rows, field = 'changePaise', good }: {
  title: string; rows: Mover[];
  field?: 'changePaise' | 'nowPaise' | 'beforePaise'; good?: boolean;
}) {
  if (!rows.length) return null;
  return (
    <Card style={{ marginTop: 8 }}>
      <Text style={s.moverTitle}>{title}</Text>
      {rows.slice(0, 5).map((r) => (
        <View key={r.party} style={s.moverRow}>
          <Text style={s.moverName} numberOfLines={1}>{r.party}</Text>
          <Text style={[s.moverValue, { color: good ? '#047857' : '#b91c1c' }]}>
            {field === 'changePaise' && r.changePaise > 0 ? '+' : ''}
            {inr(Math.abs(r[field]))}
          </Text>
        </View>
      ))}
    </Card>
  );
}

/** Averages per trading day, so a closed day is not read as a bad day. */
function DayBar({ d, days }: { d: RhythmDay; days: RhythmDay[] }) {
  const max = Math.max(...days.map((x) => x.averagePaise), 1);
  return (
    <View style={s.dayRow}>
      <Text style={s.dayName}>{d.short}</Text>
      <View style={s.dayTrack}>
        {d.daysOpen > 0 ? (
          <View style={[s.dayFill,
            { width: `${Math.max(2, (d.averagePaise / max) * 100)}%` }]} />
        ) : null}
      </View>
      <Text style={s.dayValue}>
        {d.daysOpen === 0 ? 'closed' : inr(d.averagePaise)}
      </Text>
    </View>
  );
}

function Small({ k, v }: { k: string; v: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={s.smallK}>{k}</Text>
      <Text style={s.smallV}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 16, backgroundColor: T.bg },
  headName: { fontSize: 24, fontWeight: '800', color: T.ink },
  headSub: { fontSize: 13, color: T.muted, marginTop: 2 },
  chips: { flexDirection: 'row', gap: 6, marginTop: 16 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
          borderWidth: 1, borderColor: T.line },
  chipOn: { backgroundColor: T.ink, borderColor: T.ink },
  chipText: { fontSize: 12, fontWeight: '600', color: T.muted },
  chipTextOn: { color: '#fff' },
  plain: {},
  warn: { backgroundColor: '#fffbeb', borderColor: '#fde68a', borderWidth: 1 },
  bad: { backgroundColor: '#fef2f2', borderColor: '#fecaca', borderWidth: 1 },
  runwayFigure: { fontSize: 30, fontWeight: '800', color: T.ink },
  runwaySub: { fontSize: 12, color: T.muted, marginTop: 2 },
  runwayGrid: { flexDirection: 'row', gap: 12, marginTop: 14 },
  smallK: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase',
            letterSpacing: 0.5, color: T.muted },
  smallV: { fontSize: 14, fontWeight: '700', color: T.ink, marginTop: 2 },
  basis: { fontSize: 11, color: T.faint, marginTop: 10, lineHeight: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { fontSize: 14, fontWeight: '600', color: T.ink },
  sub: { fontSize: 11, color: T.faint, marginTop: 2 },
  moverTitle: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase',
                letterSpacing: 0.5, color: T.muted, marginBottom: 6 },
  moverRow: { flexDirection: 'row', alignItems: 'center', gap: 10,
              paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: T.line },
  moverName: { flex: 1, fontSize: 13, color: T.ink },
  moverValue: { fontSize: 13, fontWeight: '700' },
  summary: { fontSize: 13, color: T.ink, lineHeight: 19 },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 3 },
  dayName: { width: 34, fontSize: 11, fontWeight: '600', color: T.muted },
  dayTrack: { flex: 1, height: 18, borderRadius: 5, backgroundColor: T.bg,
              overflow: 'hidden' },
  dayFill: { height: '100%', borderRadius: 5, backgroundColor: T.green },
  dayValue: { width: 86, fontSize: 11, color: T.ink, textAlign: 'right' },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 18,
          marginBottom: 12, backgroundColor: T.bg, borderRadius: 8, padding: 8 },
  noteText: { flex: 1, fontSize: 11, color: T.faint, lineHeight: 16 },
});
