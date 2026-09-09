import React, { useState } from 'react';
import {
  Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Filter, X, Check, Search } from 'lucide-react-native';
import { T } from '../theme';
import { matches, activeCount, isSet, type FilterSpec, type FilterValues } from '../lib/filters';

export { matches, activeCount } from '../lib/filters';
export type { FilterSpec, FilterValues } from '../lib/filters';

/**
 * The same filter strip as the web, folded into a phone.
 *
 * The matching rules are shared - `lib/filters` is a copy of the web module,
 * character for character - so a filter that hides a bill on the phone hides
 * the same bill on the desktop. What differs is only the presentation: there
 * is no room for a row of dropdowns, so everything except the search box goes
 * behind a sheet, and a select becomes a list of rows with a tick rather than
 * a native picker nobody can style.
 *
 * Ranges are two text inputs rather than a slider. A slider looks better in a
 * screenshot and is useless for "bills over fifty thousand", which is the
 * question people actually have.
 */

export default function Filters<T>({ specs, values, onChange }: {
  specs: FilterSpec<T>[];
  values: FilterValues;
  onChange: (v: FilterValues) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = (k: string, v: string) => onChange({ ...values, [k]: v });
  const n = activeCount(values);

  const search = specs.find((sp) => sp.kind === 'search');
  const rest = specs.filter((sp) => sp !== search);

  return (
    <>
      <View style={s.strip}>
        {search ? (
          <View style={s.searchWrap}>
            <Search size={15} color={T.muted} />
            <TextInput
              value={values[search.key] ?? ''}
              onChangeText={(v) => set(search.key, v)}
              placeholder={search.placeholder ?? `${search.label}…`}
              placeholderTextColor={T.muted}
              style={s.searchInput}
            />
            {isSet(values[search.key]) ? (
              <Pressable onPress={() => set(search.key, '')} hitSlop={8}>
                <X size={15} color={T.muted} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {rest.length > 0 ? (
          <Pressable onPress={() => setOpen(true)}
            style={[s.filterBtn, n > 0 && s.filterBtnOn]}>
            <Filter size={15} color={n > 0 ? T.card : T.inkSoft} />
            {n > 0 ? <Text style={s.filterCount}>{n}</Text> : null}
          </Pressable>
        ) : null}
      </View>

      {n > 0 ? (
        <Pressable onPress={() => onChange({})} style={s.clearRow}>
          <Text style={s.clearText}>
            {n === 1 ? '1 filter applied' : `${n} filters applied`} · Clear
          </Text>
        </Pressable>
      ) : null}

      <Modal visible={open} animationType="slide" transparent
        onRequestClose={() => setOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setOpen(false)} />
        <View style={s.sheet}>
          <View style={s.sheetHead}>
            <Text style={s.sheetTitle}>Filters</Text>
            <Pressable onPress={() => setOpen(false)} hitSlop={10}>
              <X size={20} color={T.ink} />
            </Pressable>
          </View>

          <ScrollView style={s.sheetBody}>
            {rest.map((sp) => (
              <View key={sp.key} style={s.group}>
                <Text style={s.groupLabel}>{sp.label.toUpperCase()}</Text>

                {sp.kind === 'select' ? (
                  <>
                    <Row label="Any" on={!isSet(values[sp.key])}
                      onPress={() => set(sp.key, '')} />
                    {sp.options.map((o) => (
                      <Row key={o.value} label={o.label}
                        on={values[sp.key] === o.value}
                        onPress={() => set(sp.key, values[sp.key] === o.value ? '' : o.value)} />
                    ))}
                  </>
                ) : sp.kind === 'toggle' ? (
                  <Row label={sp.label} on={values[sp.key] === 'on'}
                    onPress={() => set(sp.key, values[sp.key] === 'on' ? '' : 'on')} />
                ) : sp.kind === 'dateRange' ? (
                  <View style={s.pair}>
                    <TextInput value={values[`${sp.key}From`] ?? ''}
                      onChangeText={(v) => set(`${sp.key}From`, v)}
                      placeholder="From (YYYY-MM-DD)" placeholderTextColor={T.muted}
                      style={s.input} />
                    <TextInput value={values[`${sp.key}To`] ?? ''}
                      onChangeText={(v) => set(`${sp.key}To`, v)}
                      placeholder="To (YYYY-MM-DD)" placeholderTextColor={T.muted}
                      style={s.input} />
                  </View>
                ) : (
                  <View style={s.pair}>
                    <TextInput value={values[`${sp.key}Min`] ?? ''}
                      onChangeText={(v) => set(`${sp.key}Min`, v)}
                      keyboardType="numeric" placeholder="Min ₹"
                      placeholderTextColor={T.muted} style={s.input} />
                    <TextInput value={values[`${sp.key}Max`] ?? ''}
                      onChangeText={(v) => set(`${sp.key}Max`, v)}
                      keyboardType="numeric" placeholder="Max ₹"
                      placeholderTextColor={T.muted} style={s.input} />
                  </View>
                )}
              </View>
            ))}
          </ScrollView>

          <View style={s.sheetFoot}>
            <Pressable onPress={() => onChange({})} style={s.ghostBtn}>
              <Text style={s.ghostBtnText}>Clear all</Text>
            </Pressable>
            <Pressable onPress={() => setOpen(false)} style={s.primaryBtn}>
              <Text style={s.primaryBtnText}>Show results</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

function Row({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={s.row}>
      <Text style={[s.rowText, on && s.rowTextOn]}>{label}</Text>
      {on ? <Check size={17} color={T.green} /> : null}
    </Pressable>
  );
}

const s = StyleSheet.create({
  strip: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  searchWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: T.line, borderRadius: 10,
    paddingHorizontal: 12, backgroundColor: T.card,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 14, color: T.ink },
  filterBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: 1, borderColor: T.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, backgroundColor: T.card,
  },
  filterBtnOn: { backgroundColor: T.green, borderColor: T.green },
  filterCount: { color: T.card, fontSize: 12, fontWeight: '700' },

  clearRow: { marginBottom: 10 },
  clearText: { fontSize: 12, color: T.green, fontWeight: '600' },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: T.card, borderTopLeftRadius: 18, borderTopRightRadius: 18,
    maxHeight: '80%',
  },
  sheetHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 16,
    borderBottomWidth: 1, borderBottomColor: T.lineSoft,
  },
  sheetTitle: { fontSize: 17, fontWeight: '700', color: T.ink },
  sheetBody: { paddingHorizontal: 18 },

  group: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: T.lineSoft },
  groupLabel: {
    fontSize: 11, fontWeight: '700', color: T.muted,
    letterSpacing: 0.6, marginBottom: 8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10,
  },
  rowText: { fontSize: 14, color: T.inkSoft },
  rowTextOn: { color: T.ink, fontWeight: '600' },

  pair: { flexDirection: 'row', gap: 10 },
  input: {
    flex: 1, borderWidth: 1, borderColor: T.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: T.ink,
  },

  sheetFoot: {
    flexDirection: 'row', gap: 10, padding: 18,
    borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  ghostBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 13,
    borderRadius: 12, borderWidth: 1, borderColor: T.line,
  },
  ghostBtnText: { fontSize: 14, fontWeight: '600', color: T.inkSoft },
  primaryBtn: {
    flex: 2, alignItems: 'center', paddingVertical: 13,
    borderRadius: 12, backgroundColor: T.green,
  },
  primaryBtnText: { fontSize: 14, fontWeight: '700', color: T.card },
});
