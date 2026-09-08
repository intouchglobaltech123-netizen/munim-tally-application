import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApi } from '../lib/store';
import { type AuditLog, type AuditEntry } from '../lib/api';
import { ago } from '../lib/format';
import {
  Card, Empty, ErrorNote, Label, Loading, Muted, OfflineBar, Screen,
} from '../components/ui';
import { T } from '../theme';
import { Globe, Smartphone, ChevronDown, ChevronRight, Search } from 'lucide-react-native';

/**
 * Who changed what.
 *
 * Read-only on purpose — there is no way to delete an entry from anywhere,
 * because the person most likely to want one gone is the person it records.
 * Kept on the phone as well as the web so an owner away from the shop can
 * still see that somebody changed a role at 11pm.
 */
export default function AuditScreen() {
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const path = useMemo(() => {
    const p = new URLSearchParams({ limit: '150' });
    if (q.trim()) p.set('q', q.trim());
    if (action) p.set('action', action);
    return `/v1/audit?${p}`;
  }, [q, action]);

  const { data, error, loading, reload, stale, offline } = useApi<AuditLog>(path);

  if (error) return <View style={s.wrap}><ErrorNote message={error} onRetry={reload} /></View>;
  if (loading && !data) return <Loading label="Reading the log…" />;

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <View>
          <OfflineBar offline={offline} ageMs={stale} />
          <Text style={s.headName}>Audit log</Text>
          <Text style={s.headSub}>Every change, and where it was made from</Text>
        </View>
      }
    >
      <View style={s.searchRow}>
        <Search size={15} strokeWidth={2.2} color={T.faint} />
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="A person, or what they changed"
          placeholderTextColor={T.faint}
          autoCorrect={false}
          autoCapitalize="none"
          style={s.searchInput}
        />
      </View>

      {(data?.actions.length ?? 0) > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          style={{ marginTop: 12 }} contentContainerStyle={{ gap: 8, paddingRight: 16 }}>
          <Chip label="Everything" on={action === ''} onPress={() => setAction('')} />
          {data!.actions.map((a) => (
            <Chip key={a.key} label={`${a.label} · ${a.count}`}
              on={action === a.key} onPress={() => setAction(a.key)} />
          ))}
        </ScrollView>
      ) : null}

      {!data?.entries.length ? (
        <Card style={{ marginTop: 14 }}>
          <Empty title="Nothing recorded yet"
            hint="Changes to people, roles, settings and backups will appear here." />
        </Card>
      ) : data.entries.map((e) => (
        <Row key={e.id} e={e} open={open === e.id}
          onPress={() => setOpen(open === e.id ? null : e.id)} />
      ))}

      {data?.note ? (
        <View style={{ marginTop: 18, marginBottom: 8 }}>
          <Muted>
            {data.note} Network addresses are kept only to the nearest /24 — enough
            to tell your usual connection from an unfamiliar one, and no more.
          </Muted>
        </View>
      ) : null}
    </Screen>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[s.chip, on && s.chipOn]}>
      <Text style={[s.chipText, on && s.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

function Row({ e, open, onPress }: { e: AuditEntry; open: boolean; onPress: () => void }) {
  const expandable = Boolean(e.before || e.after);
  return (
    <Card style={{ marginTop: 10 }}>
      <Pressable onPress={expandable ? onPress : undefined} style={s.head}>
        <View style={{ flex: 1 }}>
          <Text style={s.action}>{e.label}</Text>
          {e.entityName ? <Text style={s.on}>{e.entityName}</Text> : null}
          {e.changes ? <Text style={s.changes}>{e.changes}</Text> : null}
          <Text style={s.sub}>
            {e.by}
            {e.byEmail ? ` · ${e.byEmail}` : ''}
          </Text>
          <View style={s.meta}>
            <Text style={s.when}>{ago(e.at)}</Text>
            {e.ipPrefix ? (
              <View style={s.metaBit}>
                <Globe size={10} strokeWidth={2.2} color={T.faint} />
                <Text style={s.when}>{e.ipPrefix}</Text>
              </View>
            ) : null}
            {e.device ? (
              <View style={s.metaBit}>
                <Smartphone size={10} strokeWidth={2.2} color={T.faint} />
                <Text style={s.when}>{e.device}</Text>
              </View>
            ) : null}
          </View>
        </View>
        {expandable ? (
          open
            ? <ChevronDown size={16} strokeWidth={2.2} color={T.faint} />
            : <ChevronRight size={16} strokeWidth={2.2} color={T.faint} />
        ) : null}
      </Pressable>

      {open && expandable ? (
        <View style={s.detail}>
          <Label>Was</Label>
          <Text style={s.json}>{JSON.stringify(e.before ?? {}, null, 2)}</Text>
          <View style={{ height: 10 }} />
          <Label>Became</Label>
          <Text style={s.json}>{JSON.stringify(e.after ?? {}, null, 2)}</Text>
        </View>
      ) : null}
    </Card>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 16, backgroundColor: T.bg },
  headName: { fontSize: 24, fontWeight: '800', color: T.ink },
  headSub: { fontSize: 13, color: T.muted, marginTop: 2 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16,
    backgroundColor: T.card, borderWidth: 1, borderColor: T.line,
    borderRadius: 10, paddingHorizontal: 12,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 14, color: T.ink },
  chip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    backgroundColor: T.card, borderWidth: 1, borderColor: T.line,
  },
  chipOn: { backgroundColor: T.ink, borderColor: T.ink },
  chipText: { fontSize: 12, fontWeight: '600', color: T.muted },
  chipTextOn: { color: '#fff' },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  action: { fontSize: 15, fontWeight: '700', color: T.ink },
  on: { fontSize: 13, color: T.muted, marginTop: 1 },
  changes: { fontSize: 12, color: T.faint, marginTop: 3 },
  sub: { fontSize: 12, color: T.muted, marginTop: 6 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  metaBit: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  when: { fontSize: 11, color: T.faint },
  detail: { marginTop: 12, borderTopWidth: 1, borderTopColor: T.line, paddingTop: 12 },
  json: {
    fontFamily: 'monospace', fontSize: 11, color: T.muted,
    backgroundColor: T.bg, padding: 8, borderRadius: 8, marginTop: 4,
  },
});
