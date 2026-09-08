import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useApi } from '../lib/store';
import { type Billing, type UsageLine } from '../lib/api';
import { shortDate } from '../lib/format';
import {
  Badge, Card, ErrorNote, Label, Loading, Muted, OfflineBar, Screen,
} from '../components/ui';
import { T } from '../theme';
import { AlertTriangle } from 'lucide-react-native';

/**
 * The plan, on the phone.
 *
 * Read-only. Choosing a plan means typing a coupon, reading a tax breakdown and
 * committing money — all of it easier on a screen with room, and none of it
 * something anybody does standing at a counter. What matters here is knowing
 * you are at a limit or that a payment failed, which is exactly what stops the
 * app working and is worth seeing wherever you are.
 */
export default function BillingScreen() {
  const { data, error, loading, reload, stale, offline } = useApi<Billing>('/v1/billing');

  if (error) return <View style={s.wrap}><ErrorNote message={error} onRetry={reload} /></View>;
  if (!data) return <Loading />;

  const sub = data.subscription;

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <View>
          <OfflineBar offline={offline} ageMs={stale} />
          <Text style={s.headName}>Plan & billing</Text>
          <Text style={s.headSub}>What you are on, and what you are using</Text>
        </View>
      }
    >
      {sub && ['grace', 'past_due'].includes(sub.status) ? (
        <Card style={{ ...s.warn, marginTop: 16 }}>
          <View style={s.warnHead}>
            <AlertTriangle size={16} strokeWidth={2.2} color="#b45309" />
            <Text style={s.warnText}>{sub.message}</Text>
          </View>
        </Card>
      ) : null}

      {data.atLimit.length > 0 ? (
        <Card style={{ ...s.warn, marginTop: 12 }}>
          <Text style={s.warnText}>
            You are at your limit for {data.atLimit.join(', ').toLowerCase()}.
            Anything new of that kind will be refused until you upgrade.
          </Text>
        </Card>
      ) : null}

      <Card style={{ marginTop: 16 }}>
        <View style={s.planHead}>
          <Text style={s.planName}>{sub?.planLabel ?? data.plan.label}</Text>
          {data.trial.trial ? (
            <Badge tone={data.trial.expired ? 'bad' : 'warn'}>
              {data.trial.expired ? 'Trial ended' : `${data.trial.daysLeft}d left`}
            </Badge>
          ) : null}
        </View>
        <Text style={s.planMsg}>{sub?.message ?? 'No paid plan yet.'}</Text>
        {sub?.pendingPlanLabel ? (
          <Text style={s.pending}>
            Moving to {sub.pendingPlanLabel} at the end of this period.
          </Text>
        ) : null}
      </Card>

      <View style={{ marginTop: 20 }}><Label>Usage</Label></View>
      <Card style={{ marginTop: 10 }}>
        {data.usage.map((u) => <Usage key={u.key} u={u} />)}
      </Card>

      <View style={{ marginTop: 20 }}><Label>Payments</Label></View>
      {data.payments.length === 0 ? (
        <Card style={{ marginTop: 10 }}>
          <Muted>Nothing yet.</Muted>
        </Card>
      ) : data.payments.slice(0, 12).map((p) => (
        <Card key={p.id} style={{ marginTop: 10 }}>
          <View style={s.payRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.payAmount}>{p.totalLabel}</Text>
              <Text style={s.paySub}>
                {shortDate(p.createdAt)}
                {p.invoiceNumber ? ` · ${p.invoiceNumber}` : ''}
              </Text>
              {p.failureReason ? (
                <Text style={s.payFail}>{p.failureReason}</Text>
              ) : null}
            </View>
            <Badge tone={p.status === 'paid' ? 'ok' : p.status === 'failed' ? 'bad' : 'warn'}>
              {p.status === 'paid' ? 'Paid' : p.status === 'failed' ? 'Failed' : p.status}
            </Badge>
          </View>
        </Card>
      ))}

      <View style={{ marginTop: 20, marginBottom: 10 }}>
        <Muted>
          Changing plans, coupons and invoices are on the web, where there is room
          to read the tax breakdown before committing to it.
        </Muted>
      </View>
    </Screen>
  );
}

function Usage({ u }: { u: UsageLine }) {
  return (
    <View style={s.usage}>
      <View style={s.usageHead}>
        <Text style={s.usageLabel}>{u.label}</Text>
        <Text style={[s.usageValue, u.over && { color: '#b91c1c', fontWeight: '700' }]}>
          {u.summary}
        </Text>
      </View>
      {!u.unlimited ? (
        <View style={s.bar}>
          <View style={[s.barFill, {
            width: `${Math.max(2, u.pct)}%`,
            backgroundColor: u.over ? '#dc2626' : u.pct >= 80 ? '#d97706' : T.green,
          }]} />
        </View>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 16, backgroundColor: T.bg },
  headName: { fontSize: 24, fontWeight: '800', color: T.ink },
  headSub: { fontSize: 13, color: T.muted, marginTop: 2 },
  warn: { backgroundColor: '#fffbeb', borderColor: '#fde68a', borderWidth: 1 },
  warnHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  warnText: { flex: 1, fontSize: 13, color: '#78350f', lineHeight: 19 },
  planHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  planName: { flex: 1, fontSize: 20, fontWeight: '800', color: T.ink },
  planMsg: { fontSize: 13, color: T.muted, marginTop: 4, lineHeight: 19 },
  pending: { fontSize: 12, color: '#b45309', marginTop: 6 },
  usage: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.line },
  usageHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  usageLabel: { fontSize: 13, color: T.ink },
  usageValue: { fontSize: 12, color: T.muted },
  bar: { height: 5, borderRadius: 999, backgroundColor: T.line, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 999 },
  payRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  payAmount: { fontSize: 15, fontWeight: '700', color: T.ink },
  paySub: { fontSize: 12, color: T.muted, marginTop: 2 },
  payFail: { fontSize: 11, color: '#b91c1c', marginTop: 3 },
});
