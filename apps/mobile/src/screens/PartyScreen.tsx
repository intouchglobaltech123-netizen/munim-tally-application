import React from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp, useApi } from '../lib/store';
import type { Statement, PartyDetail } from '../lib/api';
import { inr, shortDate, mask } from '../lib/format';
import {
  Button, Card, ErrorNote, Label, Loading, Muted, Screen, Title, Avatar,
} from '../components/ui';
import ShareSheet from '../components/ShareSheet';
import { T } from '../theme';

export default function PartyScreen({ route }: any) {
  const party: string = route.params?.name ?? '';
  const { company, privacy } = useApp();

  const { data, error, loading, reload } = useApi<Statement>(
    company
      ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/statement?ledger=${encodeURIComponent(party)}`
      : null,
    [company?.tallyGuid, party],
  );

  /*
   * The detail the web screen has had all along and this one did not.
   *
   * A running statement answers "what happened"; it does not answer the two
   * things somebody actually opens a customer to find out - can I trust them to
   * pay, and how much of what they owe is already late. Fetched separately
   * rather than folded into the statement so a slow detail query never delays
   * the ledger somebody came here to read.
   */
  const detail = useApi<PartyDetail>(
    company
      ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/parties/${encodeURIComponent(party)}`
      : null,
    [company?.tallyGuid, party],
  );

  const money = (p: number) => (privacy ? mask(inr(p)) : inr(p));

  if (error) return <View style={s.wrap}><ErrorNote message={error} onRetry={reload} /></View>;
  if (loading || !data) return <Loading label="Loading statement…" />;

  const { ledger, rows } = data;
  const receivable = ledger.closingPaise >= 0;

  return (
    <Screen>
      {/*
        * The same disc that identifies this party in every list, at the head of
        * their own screen - so arriving here from a list is visibly the same
        * customer rather than a name that happens to match.
        */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar name={ledger.name} size="lg" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Title>{ledger.name}</Title>
          <Muted>
            {[ledger.parentGroup, ledger.phone, ledger.gstin,
              ledger.creditDays ? `${ledger.creditDays} day credit` : null]
              .filter(Boolean).join(' · ')}
          </Muted>
        </View>
      </View>

      {/* The two things anyone actually sends a customer. */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <ShareSheet kind="outstanding" subject={ledger.name} label="Send dues" />
        <ShareSheet kind="statement" subject={ledger.name} label="Statement" />
      </View>

      {/*
        * How they pay, and how exposed you are. Above the ledger because they
        * are the questions; the ledger is the evidence.
        */}
      {detail.data?.behaviour ? (
        <Card style={{ marginTop: 16 }}>
          <Label>How they pay</Label>
          <Text style={[s.verdict, {
            color: (detail.data.behaviour.daysAgainstTerms ?? 0) > 15 ? '#b91c1c'
              : (detail.data.behaviour.daysAgainstTerms ?? 0) > 3 ? '#b45309' : T.ink,
          }]}>
            {detail.data.behaviour.verdict}
          </Text>
          <View style={s.factGrid}>
            <Fact k="Average" v={`${detail.data.behaviour.averageDays}d`} />
            <Fact k="Slowest" v={`${detail.data.behaviour.worstDays}d`} />
            <Fact k="On time" v={`${detail.data.behaviour.onTimePercent}%`} />
          </View>
          <Text style={s.basis}>
            {detail.data.behaviour.confident
              ? `Based on ${detail.data.behaviour.bills} settled bills.`
              : `Only ${detail.data.behaviour.bills} settled bill`
                + `${detail.data.behaviour.bills === 1 ? '' : 's'} — not yet a pattern.`}
          </Text>
        </Card>
      ) : null}

      {detail.data && detail.data.ageing.totalPaise > 0 ? (
        <Card style={{ marginTop: 12 }}>
          <View style={s.ageHead}>
            <Label>Outstanding</Label>
            {detail.data.ageing.overduePercent > 0 ? (
              <Text style={[s.overdue, {
                color: detail.data.ageing.overduePercent > 50 ? '#b91c1c' : '#b45309',
              }]}>
                {detail.data.ageing.overduePercent}% overdue
              </Text>
            ) : null}
          </View>
          <AgeBar label="Not due yet" paise={detail.data.ageing.notDuePaise}
            total={detail.data.ageing.totalPaise} ok />
          {detail.data.ageing.buckets.filter((b) => b.paise > 0).map((b) => (
            <AgeBar key={b.label} label={b.label} paise={b.paise}
              total={detail.data!.ageing.totalPaise} />
          ))}
        </Card>
      ) : null}

      <Card style={{ marginTop: 16 }}>
        <Label>{receivable ? 'They owe you' : 'You owe them'}</Label>
        <Text style={[s.closing, { color: receivable ? T.green : T.red }]}>
          {money(Math.abs(ledger.closingPaise))}
        </Text>
        <View style={s.metaRow}>
          <View><Label>Opening</Label><Text style={s.meta}>{money(ledger.openingPaise)}</Text></View>
          <View><Label>Entries</Label><Text style={s.meta}>{rows.length}</Text></View>
        </View>
      </Card>

      {ledger.phone ? (
        <View style={{ marginTop: 14 }}>
          <Button title={`Call ${ledger.phone}`}
            onPress={() => Linking.openURL(`tel:${ledger.phone}`)} />
        </View>
      ) : null}

      <Card style={{ marginTop: 16, marginBottom: 24 }}>
        <Label>Statement</Label>
        <View style={[s.row, s.rowOpening]}>
          <Text style={s.rowLeft}>Opening balance</Text>
          <Text style={s.rowBal}>{money(ledger.openingPaise)}</Text>
        </View>
        {rows.map((r, i) => (
          <View key={`${r.vchNo}-${r.date}-${i}`} style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowLeft}>{r.vchType}</Text>
              <Text style={s.sub}>{shortDate(r.date)} · {r.vchNo}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[s.rowAmt, { color: r.amountPaise >= 0 ? T.ink : T.green }]}>
                {r.amountPaise >= 0 ? money(r.amountPaise) : `- ${money(-r.amountPaise)}`}
              </Text>
              <Text style={s.sub}>bal {money(r.balancePaise)}</Text>
            </View>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={s.factK}>{k}</Text>
      <Text style={s.factV}>{v}</Text>
    </View>
  );
}

/**
 * One ageing bucket as a share of what is owed.
 *
 * A length rather than two numbers to divide: the question is "how much of this
 * is late", and a proportion is read far faster than it is computed.
 */
function AgeBar({ label, paise, total, ok }: {
  label: string; paise: number; total: number; ok?: boolean;
}) {
  if (paise <= 0) return null;
  const pct = total ? (paise / total) * 100 : 0;
  return (
    <View style={s.ageRow}>
      <Text style={s.ageLabel}>{label}</Text>
      <View style={s.ageTrack}>
        <View style={[s.ageFill, {
          width: `${Math.max(2, pct)}%`,
          backgroundColor: ok ? T.green : '#dc2626',
        }]} />
      </View>
      <Text style={s.ageValue}>{inr(paise)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  verdict: { fontSize: 17, fontWeight: '800', marginTop: 4 },
  factGrid: { flexDirection: 'row', gap: 10, marginTop: 12 },
  factK: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase',
           letterSpacing: 0.5, color: T.muted },
  factV: { fontSize: 15, fontWeight: '700', color: T.ink, marginTop: 2 },
  basis: { fontSize: 11, color: T.faint, marginTop: 10 },
  ageHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  overdue: { fontSize: 12, fontWeight: '700' },
  ageRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 7 },
  ageLabel: { width: 78, fontSize: 11, color: T.muted },
  ageTrack: { flex: 1, height: 8, borderRadius: 999, backgroundColor: T.bg,
              overflow: 'hidden' },
  ageFill: { height: '100%', borderRadius: 999 },
  ageValue: { width: 84, fontSize: 11, fontWeight: '600', color: T.ink,
              textAlign: 'right' },
  wrap: { padding: 16, backgroundColor: T.bg, flexGrow: 1 },
  closing: { fontSize: 28, fontFamily: T.font.bold, marginTop: 4, fontVariant: ['tabular-nums'] },
  metaRow: { flexDirection: 'row', gap: 32, marginTop: 14 },
  meta: { fontFamily: T.font.bold, color: T.ink, marginTop: 2, fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12,
         paddingVertical: 10, borderTopWidth: 1, borderTopColor: T.line },
  rowOpening: { borderTopWidth: 0 },
  rowLeft: { color: T.ink, fontFamily: T.font.semibold },
  rowAmt: { fontFamily: T.font.bold, fontVariant: ['tabular-nums'] },
  rowBal: { fontFamily: T.font.bold, color: T.ink, fontVariant: ['tabular-nums'] },
  sub: { color: T.muted, fontSize: 11, marginTop: 2 },
});
