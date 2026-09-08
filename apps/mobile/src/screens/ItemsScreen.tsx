import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import {
  Package, Search, Boxes, PackageX, PackageMinus, TrendingDown, ChevronRight, Info, ScanLine,
} from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { useMoney } from '../lib/money';
import {
  Badge, Card, EmptyState, ErrorNote, Loading, Muted, OfflineBar, Screen,
  Settling, Title,
} from '../components/ui';
import ScanSheet, { scanAvailable } from '../components/ScanSheet';
import { barcodeForms } from '../lib/scanner';
import { T } from '../theme';

/**
 * What you hold, and what needs doing about it.
 *
 * The four counts lead, because negative stock is a bookkeeping fault and
 * below-reorder is a purchasing decision - and neither should need scrolling
 * a list of three hundred items to discover.
 */

type Item = {
  name: string; group: string; category: string; unit: string;
  hsn: string; gstRatePct: number;
  closingQty: number; closingValuePaise: number; ratePaise: number;
  reorderLevel: number; status: 'ok' | 'out' | 'negative' | 'reorder';
};
type Payload = {
  items: Item[];
  totals: { count: number; valuePaise: number; negative: number;
            outOfStock: number; belowReorder: number };
  groups: { name: string; count: number }[];
  readOnly: string;
};

const STATUSES = [
  { key: '', label: 'All', icon: Boxes },
  { key: 'ok', label: 'In stock', icon: Package },
  { key: 'reorder', label: 'Reorder', icon: TrendingDown },
  { key: 'out', label: 'Out', icon: PackageX },
  { key: 'negative', label: 'Negative', icon: PackageMinus },
];

const TONE: Record<string, { badge: 'ok' | 'warn' | 'bad'; label: string }> = {
  ok: { badge: 'ok', label: 'In stock' },
  out: { badge: 'warn', label: 'Out' },
  reorder: { badge: 'warn', label: 'Reorder' },
  negative: { badge: 'bad', label: 'Negative' },
};

export default function ItemsScreen({ navigation }: any) {
  const { company } = useApp();
  const money = useMoney();
  const [q, setQ] = useState('');
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState('');

  const qs = new URLSearchParams({ sort: 'value' });
  if (q.trim()) qs.set('q', q.trim());
  if (status) qs.set('status', status);

  const { data, error, loading, refreshing, reload, stale, offline } = useApi<Payload>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/items?${qs}` : null,
    [company?.tallyGuid, q, status]);

  if (error) return <Screen><ErrorNote message={error} onRetry={reload} /></Screen>;
  if (loading && !data) return <Loading label="Counting your stock…" />;

  return (
    <Screen onRefresh={reload} refreshing={loading} tabBar={false}>
      <OfflineBar offline={offline} ageMs={stale} />
      <Title>Items & stock</Title>
      <Muted>What you hold, and what needs reordering.</Muted>

      {data ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 14 }}>
          <Stat label="Stock value" value={money(data.totals.valuePaise, { compact: true })}
            sub={`${data.totals.count} items`} />
          <Stat label="Below reorder" value={String(data.totals.belowReorder)}
            sub="need buying" tone={data.totals.belowReorder ? T.warn : undefined} />
          <Stat label="Out of stock" value={String(data.totals.outOfStock)}
            sub="nothing on hand" tone={data.totals.outOfStock ? T.warn : undefined} />
          <Stat label="Negative" value={String(data.totals.negative)}
            sub="sold > bought" tone={data.totals.negative ? T.negative : undefined} />
        </View>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 7, paddingVertical: 14 }}>
        {STATUSES.map((st) => (
          <Pressable key={st.key} onPress={() => setStatus(st.key)}
            style={[s.chip, status === st.key && s.chipOn]}>
            <st.icon size={13} color={status === st.key ? T.card : T.inkSoft} />
            <Text style={[s.chipText, status === st.key && s.chipTextOn]}>{st.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={s.searchRow}>
        <Search size={15} color={T.muted} />
        <TextInput value={q} onChangeText={setQ}
          placeholder="Name, HSN or barcode" placeholderTextColor={T.faint}
          style={s.searchInput} autoCorrect={false} autoCapitalize="none" />
        {/*
          * A shopkeeper with the box in their hand knows the barcode and not the
          * spelling somebody typed into Tally three years ago.
          */}
        {scanAvailable() ? (
          <Pressable onPress={() => setScanning(true)} hitSlop={8} style={{ padding: 4 }}>
            <ScanLine size={17} strokeWidth={2.2} color={T.muted} />
          </Pressable>
        ) : null}
      </View>

      <ScanSheet
        open={scanning}
        onClose={() => setScanning(false)}
        hint="Point at the barcode on the box"
        onScan={(value) => {
          setScanning(false);
          /*
           * The plain digits are searched, not the raw scan.
           *
           * Labels and scanners disagree about leading zeros and about whether a
           * UPC-A is written as 12 or 13 digits, so the longest form is used for
           * the box and the search matches on it as text - which finds the item
           * whichever way it was entered into Tally.
           */
          const forms = barcodeForms(value);
          setQ(forms.sort((a, b) => b.length - a.length)[0] ?? value);
        }}
      />

      {/*
        * The list greys while a new search runs rather than emptying.
        *
        * Typing in the box changes the path on every keystroke, and clearing
        * the list each time made the screen flash between results and "nothing
        * here" - which reads as the item not existing.
        */}
      <Settling when={refreshing}>
      {!data?.items.length ? (
        <EmptyState title="Nothing here" icon={Package}
          hint={q ? `No item matches “${q}”.` : 'Items appear as Tally syncs them.'} />
      ) : data.items.map((i) => (
        <Pressable key={i.name} onPress={() => navigation.navigate('Item', { name: i.name })}>
          <Card style={{ marginBottom: 9 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={s.name} numberOfLines={1}>{i.name}</Text>
                <Text style={s.sub} numberOfLines={1}>
                  {[i.group, i.category].filter(Boolean).join(' · ') || 'Ungrouped'}
                  {i.hsn ? ` · HSN ${i.hsn}` : ''}
                  {i.gstRatePct > 0 ? ` · ${i.gstRatePct}%` : ''}
                </Text>
                <View style={{ flexDirection: 'row', marginTop: 5 }}>
                  <Badge tone={TONE[i.status].badge}>{TONE[i.status].label}</Badge>
                </View>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[s.qty, i.closingQty < 0 && { color: T.negative }]}>
                  {i.closingQty.toLocaleString('en-IN')}
                  <Text style={s.unit}> {i.unit}</Text>
                </Text>
                <Text style={s.tiny}>{money(i.closingValuePaise, { compact: true })}</Text>
              </View>
              <ChevronRight size={16} color={T.faint} />
            </View>
          </Card>
        </Pressable>
      ))}
      </Settling>

      {data ? (
        <View style={s.note}>
          <Info size={13} color={T.muted} style={{ marginTop: 1 }} />
          <Text style={s.noteText}>{data.readOnly} Munim never writes to your books.</Text>
        </View>
      ) : null}
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

const s = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999,
    backgroundColor: T.lineSoft,
  },
  chipOn: { backgroundColor: T.green },
  chipText: { fontFamily: T.font.semibold, fontSize: 12, color: T.inkSoft },
  chipTextOn: { color: T.card },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm,
    paddingHorizontal: 12, marginBottom: 14,
  },
  searchInput: {
    flex: 1, paddingVertical: 10, fontFamily: T.font.regular, fontSize: 14, color: T.ink,
  },
  stat: {
    flexGrow: 1, flexBasis: '46%', backgroundColor: T.card,
    borderRadius: T.radiusSm, padding: 11, ...T.shadow,
  },
  statLabel: { fontFamily: T.font.medium, fontSize: 10, color: T.muted },
  statValue: { fontFamily: T.font.bold, fontSize: 16, color: T.ink, marginTop: 3 },
  name: { fontFamily: T.font.bold, fontSize: 14, color: T.ink },
  sub: { fontFamily: T.font.regular, fontSize: 11, color: T.muted, marginTop: 2 },
  qty: { fontFamily: T.font.bold, fontSize: 14, color: T.ink },
  unit: { fontFamily: T.font.regular, fontSize: 10, color: T.muted },
  tiny: { fontFamily: T.font.regular, fontSize: 10, color: T.muted, marginTop: 2 },
  note: { flexDirection: 'row', gap: 8, marginTop: 16, paddingHorizontal: 2 },
  noteText: { flex: 1, fontFamily: T.font.regular, fontSize: 11, color: T.muted, lineHeight: 16 },
});
