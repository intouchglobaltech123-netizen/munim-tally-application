import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  Users, Search, Truck, Hash, Phone, AlertTriangle, ChevronRight, Info,
} from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { useMoney } from '../lib/money';
import {
  Avatar, Badge, Card, EmptyState, ErrorNote, Loading, Muted, OfflineBar, Screen, Title,
  Sno,
} from '../components/ui';
import { T } from '../theme';

/**
 * Everyone you trade with.
 *
 * Customers and suppliers share a screen because they share a record in Tally,
 * differing only by the group they sit in.
 */

type Party = {
  name: string; group: string; nature: string; kind: string;
  closingPaise: number; creditDays: number; creditLimitPaise: number; overLimit: boolean;
  contact: { phone: string; email: string; state: string };
  tax: { gstin: string }; tags: string[];
};
type Payload = {
  parties: Party[];
  totals: { count: number; owedToYouPaise: number; youOwePaise: number };
  tags: string[]; readOnly: string;
};

const KINDS = [
  { key: 'customer', label: 'Customers', icon: Users },
  { key: 'supplier', label: 'Suppliers', icon: Truck },
  { key: 'all', label: 'All', icon: Hash },
];

export default function PartiesScreen({ navigation }: any) {
  const { company } = useApp();
  const money = useMoney();
  const [kind, setKind] = useState('customer');
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');

  const qs = new URLSearchParams({ kind, sort: 'balance' });
  if (q.trim()) qs.set('q', q.trim());
  if (tag) qs.set('tag', tag);

  const { data, error, loading, reload, stale, offline } = useApi<Payload>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/parties?${qs}` : null,
    [company?.tallyGuid, kind, q, tag]);

  if (error) return <Screen><ErrorNote message={error} onRetry={reload} /></Screen>;
  if (loading && !data) return <Loading label="Loading your parties…" />;

  return (
    <Screen onRefresh={reload} refreshing={loading} tabBar={false}>
      <OfflineBar offline={offline} ageMs={stale} />
      <Title>Parties</Title>
      <Muted>Customers, suppliers and every other ledger.</Muted>

      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 7, paddingVertical: 14 }}>
        {KINDS.map((k) => (
          <Pressable key={k.key} onPress={() => setKind(k.key)}
            style={[s.chip, kind === k.key && s.chipOn]}>
            <k.icon size={13} color={kind === k.key ? T.card : T.inkSoft} />
            <Text style={[s.chipText, kind === k.key && s.chipTextOn]}>{k.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={s.searchRow}>
        <Search size={15} color={T.muted} />
        <TextInput value={q} onChangeText={setQ}
          placeholder="Name, GSTIN or phone" placeholderTextColor={T.faint}
          style={s.searchInput} autoCorrect={false} autoCapitalize="none" />
      </View>

      {data && data.tags.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingBottom: 12 }}>
          {data.tags.map((t) => (
            <Pressable key={t} onPress={() => setTag(tag === t ? '' : t)}
              style={[s.tagChip, tag === t && s.chipOn]}>
              <Text style={[s.tagText, tag === t && s.chipTextOn]}>{t}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {data ? (
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
          <Stat label="Owed to you" value={money(data.totals.owedToYouPaise, { compact: true })}
            tone={T.positive} />
          <Stat label="You owe" value={money(data.totals.youOwePaise, { compact: true })}
            tone={T.negative} />
          <Stat label="Parties" value={String(data.totals.count)} />
        </View>
      ) : null}

      {!data?.parties.length ? (
        <EmptyState title="Nothing here" icon={Users}
          hint={q ? `No party matches “${q}”.` : 'Parties appear as Tally syncs them.'} />
      ) : data.parties.map((p, i) => (
        <Pressable key={p.name}
          onPress={() => navigation.navigate('Party', { name: p.name })}>
          <Card style={{ marginBottom: 9 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              {/*
                * A serial number and initials down the left edge - the same two
                * marks this customer carries on the web, so arriving at their
                * page from either is visibly the same person.
                */}
              <Sno n={i + 1} />
              <Avatar name={p.name} size="sm" />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Text style={s.name} numberOfLines={1}>{p.name}</Text>
                  {p.overLimit ? (
                    <Badge tone="bad">Over limit</Badge>
                  ) : null}
                </View>
                <Text style={s.sub} numberOfLines={1}>
                  {p.group}
                  {p.tax.gstin ? ` · ${p.tax.gstin}` : ''}
                  {p.contact.phone ? ` · ${p.contact.phone}` : ''}
                </Text>
                {p.tags.length ? (
                  <Text style={s.tagLine} numberOfLines={1}>{p.tags.join(' · ')}</Text>
                ) : null}
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[s.amount, {
                  color: p.closingPaise > 0 ? T.positive
                    : p.closingPaise < 0 ? T.negative : T.muted,
                }]}>
                  {money(Math.abs(p.closingPaise), { compact: true })}
                </Text>
                <Text style={s.tiny}>
                  {p.closingPaise > 0 ? 'owes you' : p.closingPaise < 0 ? 'you owe' : 'settled'}
                </Text>
              </View>
              <ChevronRight size={16} color={T.faint} />
            </View>
          </Card>
        </Pressable>
      ))}

      {data ? (
        <View style={s.note}>
          <Info size={13} color={T.muted} style={{ marginTop: 1 }} />
          <Text style={s.noteText}>{data.readOnly} Munim never writes to your books.</Text>
        </View>
      ) : null}
    </Screen>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, tone ? { color: tone } : null]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999,
    backgroundColor: T.lineSoft,
  },
  chipOn: { backgroundColor: T.green },
  chipText: { fontFamily: T.font.semibold, fontSize: 12, color: T.inkSoft },
  chipTextOn: { color: T.card },
  tagChip: {
    paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999,
    backgroundColor: T.lineSoft,
  },
  tagText: { fontFamily: T.font.medium, fontSize: 11, color: T.inkSoft },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm,
    paddingHorizontal: 12, marginBottom: 12,
  },
  searchInput: {
    flex: 1, paddingVertical: 10, fontFamily: T.font.regular,
    fontSize: 14, color: T.ink,
  },
  stat: { flex: 1, backgroundColor: T.card, borderRadius: T.radiusSm, padding: 11, ...T.shadow },
  statLabel: { fontFamily: T.font.medium, fontSize: 10, color: T.muted },
  statValue: { fontFamily: T.font.bold, fontSize: 15, color: T.ink, marginTop: 3 },
  name: { fontFamily: T.font.bold, fontSize: 14, color: T.ink, flexShrink: 1 },
  sub: { fontFamily: T.font.regular, fontSize: 11, color: T.muted, marginTop: 2 },
  tagLine: { fontFamily: T.font.medium, fontSize: 10, color: T.green, marginTop: 2 },
  amount: { fontFamily: T.font.bold, fontSize: 14 },
  tiny: { fontFamily: T.font.regular, fontSize: 10, color: T.muted },
  note: { flexDirection: 'row', gap: 8, marginTop: 16, paddingHorizontal: 2 },
  noteText: { flex: 1, fontFamily: T.font.regular, fontSize: 11, color: T.muted, lineHeight: 16 },
});
