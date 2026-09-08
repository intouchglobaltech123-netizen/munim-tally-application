import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  ChevronDown, ChevronRight, X, Check, Search, FileText,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp, useApi } from '../lib/store';
import { inr, shortDate, mask } from '../lib/format';
import {
  Card, EmptyState, ErrorNote, Label, Loading, Muted, OfflineBar, Screen, Title,
} from '../components/ui';
import { T } from '../theme';

/**
 * Browsing the books on a phone.
 *
 * Sales, Purchases, Receipts and the rest are one screen with a different
 * filter - the same decision as on the web, for the same reason. Writing them
 * separately guarantees they drift.
 *
 * A phone changes two things. There is no room for a sidebar, so the section is
 * chosen from a sheet; and there is no room for a table, so a voucher is a card
 * rather than a row of columns.
 */

const SECTIONS = [
  { key: 'sales', label: 'Sales', group: 'Money coming in' },
  { key: 'receipt', label: 'Receipts', group: 'Money coming in' },
  { key: 'credit-note', label: 'Credit Notes', group: 'Money coming in' },
  { key: 'purchase', label: 'Purchases', group: 'Money going out' },
  { key: 'payment', label: 'Payments', group: 'Money going out' },
  { key: 'debit-note', label: 'Debit Notes', group: 'Money going out' },
  { key: 'contra', label: 'Contra', group: 'Everything else' },
  { key: 'journal', label: 'Journal', group: 'Everything else' },
  { key: 'all', label: 'All vouchers', group: 'Everything else' },
] as const;

const GROUPS = ['Money coming in', 'Money going out', 'Everything else'] as const;
const VIEWS = [
  { id: 'month', label: 'Month' },
  { id: 'party', label: 'Party' },
  { id: 'none', label: 'All' },
] as const;

/** India's financial year, which every Indian report is cut to. */
function financialYear(offset = 0) {
  const now = new Date();
  const y = (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1) + offset;
  return { from: `${y}-04-01`, to: `${y + 1}-03-31`, label: `FY ${y}-${String(y + 1).slice(2)}` };
}

export default function TransactionsScreen({ navigation, route }: any) {
  const { company, privacy } = useApp();
  const [section, setSection] = useState<string>(route?.params?.section ?? 'sales');
  const [view, setView] = useState<string>('month');
  const [fyOffset, setFyOffset] = useState(0);
  const [picking, setPicking] = useState(false);
  const [drill, setDrill] = useState<{ label: string; from: string; to: string } | null>(null);

  const fy = financialYear(fyOffset);
  // Drilling narrows the date range rather than adding a filter, so the header
  // total and the list below can never disagree.
  const from = drill?.from ?? fy.from;
  const to = drill?.to ?? fy.to;
  const groupBy = drill ? 'none' : view;

  const path = company
    ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/txn/${section}`
      + `?groupBy=${groupBy}&from=${from}&to=${to}`
    : null;

  const { data, error, loading, reload, stale, offline } =
    useApi<any>(path, [section, groupBy, from, to]);

  const money = (p: number, compact = false) =>
    privacy ? mask(inr(p, { compact })) : inr(p, { compact });

  const current = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0];

  if (!company) {
    return (
      <Screen>
        <EmptyState icon={FileText} title="No company yet"
          hint="Connect the computer that runs Tally first." />
      </Screen>
    );
  }

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={s.headName} numberOfLines={1}>{current.label}</Text>
            <Text style={s.headSub}>
              {drill ? monthLabel(drill.label) : fy.label}
              {data ? ` · ${data.count} entries` : ''}
            </Text>
          </View>
          {data ? (
            <Text style={s.headTotal}>{money(data.totalPaise, true)}</Text>
          ) : null}
        </View>
      }
    >
      <OfflineBar offline={offline} ageMs={stale} />

      {/* Which section, chosen from a sheet - nine of these will not fit in a row. */}
      <Pressable onPress={() => setPicking(true)} style={s.picker}>
        <View style={{ flex: 1 }}>
          <Label>Showing</Label>
          <Text style={s.pickerValue}>{current.label}</Text>
        </View>
        <ChevronDown size={19} strokeWidth={2.2} color={T.muted} />
      </Pressable>

      {drill ? (
        <Pressable onPress={() => setDrill(null)} style={s.back}>
          <Text style={s.backText}>← Back to {view === 'month' ? 'months' : view}</Text>
        </Pressable>
      ) : (
        <View style={s.controls}>
          <View style={s.seg}>
            {VIEWS.map((v) => (
              <Pressable key={v.id} onPress={() => setView(v.id)}
                style={[s.segItem, view === v.id && s.segOn]}>
                <Text style={[s.segText, view === v.id && { color: '#fff' }]}>{v.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={s.year}>
            <Pressable onPress={() => setFyOffset((n) => n - 1)} hitSlop={10}>
              <Text style={s.yearArrow}>‹</Text>
            </Pressable>
            <Text style={s.yearText}>{fy.label}</Text>
            <Pressable onPress={() => setFyOffset((n) => Math.min(0, n + 1))} hitSlop={10}>
              <Text style={[s.yearArrow, fyOffset >= 0 && { opacity: 0.3 }]}>›</Text>
            </Pressable>
          </View>
        </View>
      )}

      {error ? <ErrorNote message={error} onRetry={reload} />
        : loading && !data ? <Loading label="Reading your books…" />
        : !data || data.rows.length === 0 ? (
          <Card style={{ marginTop: 14 }}>
            <EmptyState icon={FileText}
              title={`No ${current.label.toLowerCase()} in this period`}
              hint="Change the year above, or check the entries exist in Tally." />
          </Card>
        ) : groupBy === 'none' ? (
          <View style={{ marginTop: 14, gap: 10 }}>
            {data.rows.map((r: any) => (
              <Pressable key={r.id}
                onPress={() => navigation.navigate('Voucher', { section, id: r.id })}>
                <Card>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.vParty} numberOfLines={1}>{r.party || r.vchType}</Text>
                      <Text style={s.vMeta}>
                        {shortDate(r.date)} · {r.vchType} · #{r.vchNo}
                      </Text>
                    </View>
                    <Text style={s.vAmount}>{money(r.amountPaise)}</Text>
                    <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        ) : (
          <Card style={{ marginTop: 14 }}>
            {data.rows.map((r: any, i: number) => {
              const max = Math.max(...data.rows.map((x: any) => x.amountPaise), 1);
              return (
                <Pressable key={r.label}
                  onPress={() => {
                    if (view !== 'month') { setView('none'); return; }
                    setDrill({ label: r.label, ...monthRange(r.label) });
                  }}
                  style={[s.gRow, i === 0 && { borderTopWidth: 0 }]}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={s.gLabel} numberOfLines={1}>
                      {view === 'month' ? monthLabel(r.label) : r.label}
                    </Text>
                    {/* A share bar turns a column of numbers into a shape. */}
                    <View style={s.track}>
                      <View style={[s.fill, { width: `${(r.amountPaise / max) * 100}%` }]} />
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={s.gAmount}>{money(r.amountPaise, true)}</Text>
                    <Text style={s.gCount}>{r.count} {r.count === 1 ? 'entry' : 'entries'}</Text>
                  </View>
                  <ChevronRight size={15} strokeWidth={2.2} color={T.faint} />
                </Pressable>
              );
            })}
          </Card>
        )}

      {picking ? (
        <SectionPicker
          value={section}
          onPick={(next) => { setSection(next); setDrill(null); setPicking(false); }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </Screen>
  );
}

/** The section list, grouped by which way the money moves. */
function SectionPicker({ value, onPick, onClose }: {
  value: string; onPick: (s: string) => void; onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} transparent>
      <Pressable style={s.backdrop} onPress={onClose} />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={s.grabber} />
        <View style={s.sheetHead}>
          <Text style={s.sheetTitle}>Show</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <X size={20} strokeWidth={2.2} color={T.muted} />
          </Pressable>
        </View>
        {GROUPS.map((g) => (
          <View key={g} style={{ marginBottom: 4 }}>
            <Text style={s.sheetGroup}>{g}</Text>
            {SECTIONS.filter((x) => x.group === g).map((x) => {
              const on = x.key === value;
              return (
                <Pressable key={x.key} onPress={() => onPick(x.key)}
                  style={[s.sheetRow, on && s.sheetRowOn]}>
                  <Text style={[s.sheetLabel, on && { color: T.green }]}>{x.label}</Text>
                  {on ? <Check size={18} strokeWidth={2.5} color={T.green} /> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </Modal>
  );
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

function monthRange(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

const s = StyleSheet.create({
  headName: { fontSize: 19, fontFamily: T.font.bold, color: T.ink, letterSpacing: -0.3 },
  headSub: { fontSize: 12.5, color: T.muted, marginTop: 2, fontFamily: T.font.regular },
  headTotal: { fontSize: 17, fontFamily: T.font.bold, color: T.ink,
               letterSpacing: -0.3, fontVariant: ['tabular-nums'] },

  picker: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: T.card, borderRadius: T.radius, borderWidth: 1,
    borderColor: T.line, paddingHorizontal: 16, paddingVertical: 12,
    marginTop: 14, ...T.shadow,
  },
  pickerValue: { fontSize: 16, fontFamily: T.font.bold, color: T.ink, marginTop: 3 },

  controls: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  seg: { flexDirection: 'row', borderRadius: 10, overflow: 'hidden',
         borderWidth: 1, borderColor: T.line, backgroundColor: T.card, flex: 1 },
  segItem: { flex: 1, paddingVertical: 8, alignItems: 'center' },
  segOn: { backgroundColor: T.green },
  segText: { fontSize: 13, fontFamily: T.font.semibold, color: T.muted },
  year: { flexDirection: 'row', alignItems: 'center', gap: 8,
          borderWidth: 1, borderColor: T.line, borderRadius: 10,
          backgroundColor: T.card, paddingHorizontal: 10, paddingVertical: 7 },
  yearArrow: { fontSize: 18, color: T.muted, fontFamily: T.font.semibold },
  yearText: { fontSize: 12.5, fontFamily: T.font.semibold, color: T.ink,
              fontVariant: ['tabular-nums'] },

  back: { marginTop: 12, alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 12,
          borderRadius: 10, borderWidth: 1, borderColor: T.line, backgroundColor: T.card },
  backText: { fontSize: 13, fontFamily: T.font.semibold, color: T.ink },

  gRow: { flexDirection: 'row', alignItems: 'center', gap: 8,
          paddingVertical: 11, borderTopWidth: 1, borderTopColor: T.lineSoft },
  gLabel: { fontSize: 14.5, fontFamily: T.font.semibold, color: T.ink },
  gAmount: { fontSize: 14.5, fontFamily: T.font.bold, color: T.ink,
             letterSpacing: -0.2, fontVariant: ['tabular-nums'] },
  gCount: { fontSize: 11, color: T.faint, marginTop: 2, fontFamily: T.font.regular },
  track: { height: 5, borderRadius: 3, backgroundColor: T.lineSoft,
           marginTop: 7, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3, backgroundColor: T.greenMid },

  vParty: { fontSize: 15, fontFamily: T.font.semibold, color: T.ink },
  vMeta: { fontSize: 11.5, color: T.faint, marginTop: 3, fontFamily: T.font.regular },
  vAmount: { fontSize: 15, fontFamily: T.font.bold, color: T.ink,
             letterSpacing: -0.2, fontVariant: ['tabular-nums'] },

  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(6,53,31,0.35)' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '85%',
           backgroundColor: T.card, borderTopLeftRadius: 24, borderTopRightRadius: 24,
           paddingHorizontal: 16, paddingTop: 10 },
  grabber: { width: 38, height: 4, borderRadius: 2, backgroundColor: T.line,
             alignSelf: 'center', marginBottom: 12 },
  sheetHead: { flexDirection: 'row', alignItems: 'center',
               justifyContent: 'space-between', marginBottom: 6 },
  sheetTitle: { fontSize: 19, fontFamily: T.font.bold, color: T.ink, letterSpacing: -0.3 },
  sheetGroup: { fontSize: 10.5, fontFamily: T.font.semibold, color: T.muted,
                textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 12, marginBottom: 4 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 10,
              paddingVertical: 12, paddingHorizontal: 12, borderRadius: 12 },
  sheetRowOn: { backgroundColor: T.greenSoft },
  sheetLabel: { fontSize: 15, fontFamily: T.font.semibold, color: T.ink, flex: 1 },
});
