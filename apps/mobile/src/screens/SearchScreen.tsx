import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  Search, X, Users, Truck, Package, Receipt, ShoppingCart, FileText, Wallet,
  SlidersHorizontal,
} from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { useMoney } from '../lib/money';
import {
  Card, EmptyState, ErrorNote, Muted, Screen, Title,
} from '../components/ui';
import { T } from '../theme';

/**
 * One box that finds anything, on the phone.
 *
 * Grouped by kind, because "Royal Tiles the customer" and "the invoice that
 * mentions Royal Tiles" are different answers to the same three letters — and
 * on a small screen an undifferentiated list of both is unreadable.
 */

type Hit = {
  title: string; subtitle: string; amountPaise: number;
  link: { screen?: string; id?: string; name?: string };
};
type Results = {
  q: string;
  groups: { kind: string; label: string; results: Hit[] }[];
  total: number; hint: string;
};
type Options = { voucherTypes: string[]; kinds: { key: string; label: string }[] };

const ICON: Record<string, typeof Users> = {
  customer: Users, supplier: Truck, ledger: Wallet, item: Package,
  invoice: Receipt, purchase: ShoppingCart, payment: Wallet,
  order: FileText, bill: Receipt,
};

export default function SearchScreen({ navigation }: any) {
  const { company } = useApp();
  const money = useMoney();
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Below what a person notices, above what a fast typist generates.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 250);
    return () => clearTimeout(t);
  }, [term]);

  const qs = new URLSearchParams({ q: debounced, limit: '6' });
  if (kind) qs.set('kind', kind);

  const results = useApi<Results>(
    company && debounced.length >= 2
      ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/search?${qs}` : null,
    [debounced, kind]);
  const opts = useApi<Options>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/search-options` : null,
    [company?.tallyGuid]);

  function go(hit: Hit) {
    const l = hit.link ?? {};
    if (l.screen === 'party' && l.name) navigation.navigate('Party', { name: l.name });
    else if (l.screen === 'item' && l.name) navigation.navigate('Item', { name: l.name });
    else if (l.screen === 'voucher' && l.id) navigation.navigate('Invoice', { id: l.id });
  }

  return (
    <Screen tabBar={false}>
      <Title>Search</Title>

      <View style={s.box}>
        <Search size={16} color={T.muted} />
        <TextInput value={term} onChangeText={setTerm} autoFocus
          placeholder="Name, invoice number, GSTIN, phone"
          placeholderTextColor={T.faint}
          style={s.input} autoCorrect={false} autoCapitalize="none"
          returnKeyType="search" />
        {term ? (
          <Pressable onPress={() => setTerm('')} hitSlop={10}>
            <X size={16} color={T.muted} />
          </Pressable>
        ) : null}
        <Pressable onPress={() => setShowFilters(!showFilters)} hitSlop={10}>
          <SlidersHorizontal size={16} color={kind ? T.gold : T.muted} />
        </Pressable>
      </View>

      {showFilters ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 7, paddingBottom: 12 }}>
          {(opts.data?.kinds ?? []).map((k) => (
            <Pressable key={k.key} onPress={() => setKind(k.key)}
              style={[s.chip, kind === k.key && s.chipOn]}>
              <Text style={[s.chipText, kind === k.key && s.chipTextOn]}>{k.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      {results.error ? <ErrorNote message={results.error} onRetry={results.reload} /> : null}

      {debounced.length < 2 ? (
        <Muted>Type at least two letters. You can search a party name, an invoice
          number, a GSTIN or a phone number.</Muted>
      ) : results.loading && !results.data ? (
        <Muted>Looking…</Muted>
      ) : results.data?.total === 0 ? (
        <EmptyState title="Nothing found" icon={Search} hint={results.data.hint} />
      ) : (
        (results.data?.groups ?? []).map((g) => (
          <View key={g.kind}>
            <Text style={s.group}>{g.label}</Text>
            <Card style={{ marginBottom: 10 }}>
              {g.results.map((r, i) => {
                const I = ICON[g.kind] ?? Receipt;
                return (
                  <Pressable key={`${r.title}-${i}`} onPress={() => go(r)} style={s.row}>
                    <I size={15} color={T.muted} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1 }}>
                      <Text style={s.title} numberOfLines={1}>{r.title}</Text>
                      {r.subtitle ? (
                        <Text style={s.sub} numberOfLines={1}>{r.subtitle}</Text>
                      ) : null}
                    </View>
                    <Text style={s.amount}>
                      {money(Math.abs(r.amountPaise), { compact: true })}
                    </Text>
                  </Pressable>
                );
              })}
            </Card>
          </View>
        ))
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  box: {
    flexDirection: 'row', alignItems: 'center', gap: 9,
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm,
    paddingHorizontal: 13, marginTop: 14, marginBottom: 12,
  },
  input: {
    flex: 1, paddingVertical: 12, fontFamily: T.font.regular,
    fontSize: 15, color: T.ink,
  },
  chip: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999, backgroundColor: T.lineSoft },
  chipOn: { backgroundColor: T.green },
  chipText: { fontFamily: T.font.semibold, fontSize: 12, color: T.inkSoft },
  chipTextOn: { color: T.card },
  group: {
    fontFamily: T.font.bold, fontSize: 11, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 12, marginBottom: 7,
  },
  row: {
    flexDirection: 'row', gap: 10, alignItems: 'center',
    paddingVertical: 10, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  title: { fontFamily: T.font.semibold, fontSize: 14, color: T.ink },
  sub: { fontFamily: T.font.regular, fontSize: 11, color: T.muted, marginTop: 2 },
  amount: { fontFamily: T.font.bold, fontSize: 13, color: T.ink },
});
