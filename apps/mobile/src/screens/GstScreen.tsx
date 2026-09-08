import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  Receipt, AlertTriangle, CheckCircle2, Hash, Users, Scale, Info,
} from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { useMoney } from '../lib/money';
import {
  Badge, Card, EmptyState, ErrorNote, Loading, Muted, Screen, Title,
} from '../components/ui';
import { T } from '../theme';

/**
 * GST on a phone.
 *
 * The checks lead, not the totals. A shop owner opening this before filing
 * needs to know what will be rejected — the amount owed they can read anywhere.
 */

type Bucket = { cgst: number; sgst: number; igst: number; cess: number; other: number };
type Leg = { taxable: number; tax: Bucket; count: number; taxTotal: number };
type Summary = {
  company: { name: string; gstin: string; gstinCheck: { valid: boolean; message: string;
             stateName?: string } };
  period: { label: string; from: string; to: string };
  outward: Leg; inward: Leg; creditNotes: Leg; debitNotes: Leg; b2b: Leg; b2c: Leg;
  byRate: (Leg & { ratePct: number })[];
  position: { outputTaxPaise: number; inputTaxPaise: number; netPaise: number;
              direction: 'payable' | 'credit' | 'nil' };
  note: string;
};
type Health = {
  findings: { key: string; label: string; count: number; tone: string; detail: string }[];
  total: number; note: string;
};

const PERIODS = [
  { key: 'month', label: 'Month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'fy', label: 'Year' },
];

export default function GstScreen() {
  const { company } = useApp();
  const money = useMoney();
  const [period, setPeriod] = useState('fy');

  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;
  const sum = useApi<Summary>(base && `${base}/gst?period=${period}`,
    [company?.tallyGuid, period]);
  const health = useApi<Health>(base && `${base}/gst-health?period=${period}`,
    [company?.tallyGuid, period]);

  if (sum.error) return <Screen><ErrorNote message={sum.error} onRetry={sum.reload} /></Screen>;
  if (sum.loading && !sum.data) return <Loading label="Adding up your GST…" />;
  if (!sum.data) return <Screen><EmptyState title="Nothing yet" icon={Receipt}
    hint="Connect Tally first." /></Screen>;

  const d = sum.data;
  const pos = d.position;

  return (
    <Screen onRefresh={sum.reload} refreshing={sum.loading} tabBar={false}>
      <Title>GST</Title>
      <Muted>{d.period.label} · {d.period.from} to {d.period.to}</Muted>

      <View style={[s.gstin, {
        backgroundColor: d.company.gstinCheck.valid ? T.positiveSoft : T.negativeSoft,
      }]}>
        {d.company.gstinCheck.valid
          ? <CheckCircle2 size={16} color={T.positive} />
          : <AlertTriangle size={16} color={T.negative} />}
        <View style={{ flex: 1 }}>
          <Text style={s.gstinValue}>{d.company.gstin || 'No GSTIN set in Tally'}</Text>
          <Text style={s.tiny}>{d.company.gstinCheck.message}</Text>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 7, paddingVertical: 14 }}>
        {PERIODS.map((p) => (
          <Pressable key={p.key} onPress={() => setPeriod(p.key)}
            style={[s.chip, period === p.key && s.chipOn]}>
            <Text style={[s.chipText, period === p.key && s.chipTextOn]}>{p.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* What will be rejected, before what is owed. */}
      {health.data ? (
        health.data.total === 0 ? (
          <View style={[s.banner, { backgroundColor: T.positiveSoft }]}>
            <CheckCircle2 size={16} color={T.positive} />
            <Text style={[s.bannerText, { color: T.positive, flex: 1 }]}>
              Nothing wrong found in this period.
            </Text>
          </View>
        ) : (
          <Card style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={16} color={T.negative} />
              <Text style={s.findingsTitle}>
                {health.data.total} thing{health.data.total === 1 ? '' : 's'} to fix before filing
              </Text>
            </View>
            {health.data.findings.filter((f) => f.count > 0).map((f) => (
              <View key={f.key} style={s.finding}>
                <Badge tone={f.tone === 'bad' ? 'bad' : 'warn'}>{String(f.count)}</Badge>
                <View style={{ flex: 1 }}>
                  <Text style={s.findingLabel}>{f.label}</Text>
                  <Text style={s.tiny}>{f.detail}</Text>
                </View>
              </View>
            ))}
          </Card>
        )
      ) : null}

      <Text style={s.section}>Position</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9 }}>
        <Stat label="Output tax" value={money(pos.outputTaxPaise, { compact: true })}
          sub={`${d.outward.count} invoices`} />
        <Stat label="Input tax" value={money(pos.inputTaxPaise, { compact: true })}
          sub={`${d.inward.count} bills`} />
        <Stat
          label={pos.direction === 'credit' ? 'Credit forward'
            : pos.direction === 'payable' ? 'Payable' : 'Net'}
          value={money(Math.abs(pos.netPaise), { compact: true })}
          sub={pos.direction === 'credit' ? 'nothing to pay' : 'output less input'}
          tone={pos.direction === 'payable' ? T.negative
            : pos.direction === 'credit' ? T.positive : undefined} />
      </View>

      <Text style={s.section}>Outward supplies</Text>
      <Card>
        <Row k="B2B (registered)" v={money(d.b2b.taxable)} sub={`${d.b2b.count}`} />
        <Row k="B2C (unregistered)" v={money(d.b2c.taxable)} sub={`${d.b2c.count}`} />
        <Row k="Taxable value" v={money(d.outward.taxable)} strong />
        <Row k="CGST" v={money(d.outward.tax.cgst)} />
        <Row k="SGST" v={money(d.outward.tax.sgst)} />
        <Row k="IGST" v={money(d.outward.tax.igst)} />
        <Row k="Total tax" v={money(d.outward.taxTotal)} strong />
      </Card>

      <Text style={s.section}>Inward supplies</Text>
      <Card>
        <Row k="Taxable value" v={money(d.inward.taxable)} strong />
        <Row k="CGST" v={money(d.inward.tax.cgst)} />
        <Row k="SGST" v={money(d.inward.tax.sgst)} />
        <Row k="IGST" v={money(d.inward.tax.igst)} />
        <Row k="Total tax" v={money(d.inward.taxTotal)} strong />
      </Card>

      {d.byRate.length > 0 ? (
        <>
          <Text style={s.section}>By rate</Text>
          <Card>
            {d.byRate.map((r) => (
              <View key={r.ratePct} style={s.rateRow}>
                <Text style={s.rateLabel}>{r.ratePct}%</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.tiny}>{r.count} invoice{r.count === 1 ? '' : 's'}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={s.rateValue}>{money(r.taxable, { compact: true })}</Text>
                  <Text style={s.tiny}>tax {money(r.taxTotal, { compact: true })}</Text>
                </View>
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <View style={s.note}>
        <Info size={13} color={T.muted} style={{ marginTop: 1 }} />
        <Text style={s.noteText}>{d.note}</Text>
      </View>
    </Screen>
  );
}

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub: string; tone?: string;
}) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, tone ? { color: tone } : null]}>{value}</Text>
      <Text style={s.tiny}>{sub}</Text>
    </View>
  );
}

function Row({ k, v, sub, strong }: { k: string; v: string; sub?: string; strong?: boolean }) {
  return (
    <View style={[s.row, strong && s.rowStrong]}>
      <Text style={[s.k, strong && s.kStrong]}>
        {k}{sub ? ` · ${sub}` : ''}
      </Text>
      <Text style={[s.v, strong && s.vStrong]}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  section: {
    fontFamily: T.font.bold, fontSize: 13, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 22, marginBottom: 10,
  },
  gstin: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: T.radiusSm, padding: 13, marginTop: 14,
  },
  gstinValue: { fontFamily: T.font.bold, fontSize: 14, color: T.ink },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: T.lineSoft },
  chipOn: { backgroundColor: T.green },
  chipText: { fontFamily: T.font.semibold, fontSize: 12, color: T.inkSoft },
  chipTextOn: { color: T.card },
  banner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: T.radiusSm, padding: 13, marginBottom: 14,
  },
  bannerText: { fontFamily: T.font.semibold, fontSize: 13 },
  findingsTitle: { fontFamily: T.font.bold, fontSize: 14, color: T.negative },
  finding: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    paddingVertical: 9, borderTopWidth: 1, borderTopColor: T.lineSoft, marginTop: 9,
  },
  findingLabel: { fontFamily: T.font.semibold, fontSize: 13, color: T.ink },
  stat: {
    flexGrow: 1, flexBasis: '30%', backgroundColor: T.card,
    borderRadius: T.radiusSm, padding: 11, ...T.shadow,
  },
  statLabel: { fontFamily: T.font.medium, fontSize: 10, color: T.muted },
  statValue: { fontFamily: T.font.bold, fontSize: 16, color: T.ink, marginTop: 3 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: T.lineSoft,
  },
  rowStrong: { borderBottomWidth: 0, borderTopWidth: 1, borderTopColor: T.line, marginTop: 4 },
  k: { fontFamily: T.font.regular, fontSize: 13, color: T.muted },
  kStrong: { fontFamily: T.font.semibold, color: T.ink },
  v: { fontFamily: T.font.medium, fontSize: 13, color: T.inkSoft },
  vStrong: { fontFamily: T.font.bold, color: T.ink },
  rateRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  rateLabel: { fontFamily: T.font.bold, fontSize: 15, color: T.ink, width: 50 },
  rateValue: { fontFamily: T.font.semibold, fontSize: 13, color: T.ink },
  tiny: { fontFamily: T.font.regular, fontSize: 11, color: T.muted, marginTop: 2 },
  note: { flexDirection: 'row', gap: 8, marginTop: 18 },
  noteText: { flex: 1, fontFamily: T.font.regular, fontSize: 11, color: T.muted, lineHeight: 16 },
});
