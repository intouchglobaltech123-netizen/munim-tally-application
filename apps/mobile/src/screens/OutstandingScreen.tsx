import React, { useState } from 'react';
import {
  Alert, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useApp, useApi } from '../lib/store';
import { post, type Outstanding, type OutstandingParty } from '../lib/api';
import { inr, shortDate, mask } from '../lib/format';
import {
  Badge, Button, Card, Empty, ErrorNote, Label, Loading, Muted, OfflineBar, Screen, Title,
  Avatar, Sno,
} from '../components/ui';
import { T } from '../theme';

const BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;

export default function OutstandingScreen({ navigation }: any) {
  const { company, privacy } = useApp();
  const [kind, setKind] = useState<'receivable' | 'payable'>('receivable');
  const [bucket, setBucket] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, string>>({});

  const { data, error, loading, reload, stale, offline } = useApi<Outstanding>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/outstanding?kind=${kind}` : null,
    [company?.tallyGuid, kind],
  );

  const money = (p: number, compact = false) =>
    privacy ? mask(inr(p, { compact })) : inr(p, { compact });

  async function remind(p: OutstandingParty) {
    setSent((s) => ({ ...s, [p.party]: 'sending' }));
    try {
      await post('/v1/reminders/send', {
        party: p.party, phone: p.phone,
        amountPaise: p.overduePaise || p.totalPaise,
        channel: 'whatsapp', companyGuid: company?.tallyGuid,
      });
      setSent((s) => ({ ...s, [p.party]: 'sent' }));
    } catch (e) {
      setSent((s) => ({ ...s, [p.party]: 'error' }));
      Alert.alert('Could not send', (e as Error).message);
    }
  }

  if (!company) return <View style={s.wrap}><Empty title="No company" hint="Connect Tally first." /></View>;
  if (error) return <View style={s.wrap}><ErrorNote message={error} onRetry={reload} /></View>;
  if (loading || !data) return <Loading label="Loading outstanding…" />;

  const needle = q.trim().toLowerCase();
  const items = data.items.filter((p) => {
    if (needle && !p.party.toLowerCase().includes(needle)) return false;
    if (!bucket) return true;
    return p.bills.some((bl) => bl.days > 0 && bucketOf(bl.days) === bucket);
  });

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <Text style={s.headName}>
      <OfflineBar offline={offline} ageMs={stale} />
          {kind === 'receivable' ? 'Who owes you' : 'What you owe'}
        </Text>
      }
    >

      <View style={s.toggle}>
        {(['receivable', 'payable'] as const).map((k) => (
          <Pressable key={k} onPress={() => { setKind(k); setBucket(null); }}
            style={[s.toggleBtn, kind === k && s.toggleOn]}>
            <Text style={[s.toggleText, kind === k && { color: '#fff' }]}>
              {k === 'receivable' ? 'Receivable' : 'Payable'}
            </Text>
          </Pressable>
        ))}
      </View>

      <TextInput value={q} onChangeText={setQ} placeholder="Search party…"
        placeholderTextColor="#9aa8a0" style={s.search} />

      <View style={s.bucketRow}>
        {BUCKETS.map((bk) => {
          const active = bucket === bk;
          return (
            <Pressable key={bk} onPress={() => setBucket(active ? null : bk)}
              style={[s.bucket, active && s.bucketOn]}>
              <Text style={s.bucketLabel}>{bk === '90+' ? '90+ d' : `${bk} d`}</Text>
              <Text style={[s.bucketValue, bk === '90+' && { color: T.red }]}>
                {money(data.totals.buckets[bk] ?? 0, true)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Card style={{ marginBottom: 14 }}>
        <View style={s.summary}>
          <View><Label>Total</Label><Text style={s.big}>{money(data.totals.total, true)}</Text></View>
          <View><Label>Overdue</Label>
            <Text style={[s.big, { color: T.red }]}>{money(data.totals.overdue, true)}</Text></View>
          <View><Label>Parties</Label><Text style={s.big}>{data.items.length}</Text></View>
        </View>
      </Card>

      {items.length === 0 ? <Empty title="Nothing here" hint="No pending amounts match." /> : null}

      {items.map((p, i) => {
        const isOpen = open === p.party;
        const state = sent[p.party];
        return (
          <Card key={p.party} style={{ marginBottom: 10 }}>
            <Pressable onPress={() => setOpen(isOpen ? null : p.party)} style={s.partyHead}>
              {/*
                * Rank and initials. This list is worked down in order - somebody
                * chases from the top - so the position is information, not
                * decoration.
                */}
              <Sno n={i + 1} />
              <Avatar name={p.party} size="sm" />
              <View style={{ flex: 1 }}>
                <Text style={s.partyName} numberOfLines={1}>{p.party}</Text>
                <Text style={s.sub}>
                  {p.bills.length} bill{p.bills.length === 1 ? '' : 's'}
                  {p.phone ? ` · ${p.phone}` : ''}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Text style={s.partyAmount}>{money(p.totalPaise)}</Text>
                {p.oldestDays > 0
                  ? <Badge tone={p.oldestDays > 90 ? 'bad' : 'warn'}>{p.oldestDays}d overdue</Badge>
                  : <Badge tone="ok">On time</Badge>}
              </View>
            </Pressable>

            {isOpen ? (
              <View style={s.details}>
                {p.bills.map((bl) => (
                  <View key={bl.ref} style={s.bill}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.billRef}>{bl.ref}</Text>
                      <Text style={s.sub}>
                        {shortDate(bl.date)} · due {shortDate(bl.dueDate)}
                        {bl.days > 0 ? ` · ${bl.days}d late` : ''}
                      </Text>
                    </View>
                    <Text style={s.billAmount}>{money(bl.pendingPaise)}</Text>
                  </View>
                ))}

                <View style={{ gap: 8, marginTop: 12 }}>
                  <Button
                    title={state === 'sent' ? 'Reminder sent ✓'
                      : state === 'sending' ? 'Sending…' : 'Send WhatsApp reminder'}
                    onPress={() => remind(p)}
                    disabled={state === 'sending' || state === 'sent'} />
                  <Button title="View statement" variant="ghost"
                    onPress={() => navigation.navigate('Party', { name: p.party })} />
                  {p.phone ? (
                    <Button title={`Call ${p.phone}`} variant="ghost"
                      onPress={() => Linking.openURL(`tel:${p.phone}`)} />
                  ) : null}
                </View>
              </View>
            ) : null}
          </Card>
        );
      })}
      <View style={{ height: 24 }} />
    </Screen>
  );
}

function bucketOf(days: number) {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

const s = StyleSheet.create({
  headName: { fontSize: 19, fontFamily: T.font.bold, color: T.ink, letterSpacing: -0.3 },
  headSub: { fontSize: 12.5, color: T.muted, marginTop: 2, fontFamily: T.font.regular },
  wrap: { padding: 16, backgroundColor: T.bg, flexGrow: 1 },
  toggle: { flexDirection: 'row', marginTop: 14, borderRadius: 12,
            borderWidth: 1, borderColor: T.line, overflow: 'hidden', backgroundColor: '#fff' },
  toggleBtn: { flex: 1, minHeight: T.tap, alignItems: 'center', justifyContent: 'center' },
  toggleOn: { backgroundColor: T.green },
  toggleText: { fontFamily: T.font.bold, color: T.ink },
  search: { marginTop: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: T.line,
            borderRadius: 12, paddingHorizontal: 14, minHeight: T.tap, color: T.ink },
  bucketRow: { flexDirection: 'row', gap: 8, marginTop: 12, marginBottom: 12 },
  bucket: { flex: 1, backgroundColor: '#fff', borderWidth: 1, borderColor: T.line,
            borderRadius: 12, padding: 10 },
  bucketOn: { borderColor: T.green, backgroundColor: T.greenSoft },
  bucketLabel: { fontSize: 10, fontFamily: T.font.bold, color: T.muted },
  bucketValue: { fontSize: 13, fontFamily: T.font.bold, color: T.ink, marginTop: 2 },
  summary: { flexDirection: 'row', justifyContent: 'space-between' },
  big: { fontSize: 17, fontFamily: T.font.bold, color: T.ink, marginTop: 2,
         fontVariant: ['tabular-nums'] },
  partyHead: { flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: T.tap },
  partyName: { fontFamily: T.font.bold, color: T.ink, fontSize: 15 },
  partyAmount: { fontFamily: T.font.bold, color: T.ink, fontVariant: ['tabular-nums'] },
  sub: { color: T.muted, fontSize: 12, marginTop: 2 },
  details: { marginTop: 12, borderTopWidth: 1, borderTopColor: T.line, paddingTop: 12 },
  bill: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 12 },
  billRef: { color: T.ink, fontFamily: T.font.semibold },
  billAmount: { fontFamily: T.font.bold, color: T.ink, fontVariant: ['tabular-nums'] },
});
