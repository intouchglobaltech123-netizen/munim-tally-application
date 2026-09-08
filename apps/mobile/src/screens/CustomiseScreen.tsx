import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp, useApi } from '../lib/store';
import { put, post, type Preferences } from '../lib/api';
import {
  Button, Card, Empty, ErrorNote, Label, Loading, Muted, OfflineBar, Screen,
} from '../components/ui';
import { T } from '../theme';
import { ArrowUp, ArrowDown, Eye, EyeOff, Info } from 'lucide-react-native';

/**
 * The same layout the web edits, edited from the phone.
 *
 * Deliberately the same preference rather than a phone-only one: somebody who
 * puts receivables on top at the shop computer means it, and having to say so
 * twice is the kind of thing that makes a product feel like two products.
 */
export default function CustomiseScreen() {
  const { company } = useApp();
  const guid = company?.tallyGuid;
  const { data, error, loading, reload, stale, offline } = useApi<Preferences>(
    guid ? `/v1/preferences?company=${encodeURIComponent(guid)}` : null);

  const [order, setOrder] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  /*
   * Seeded from the RESOLVED layout, not the stored order.
   *
   * The stored order only names what somebody moved, so editing it directly
   * would silently drop every section they never touched.
   */
  useEffect(() => {
    if (!data) return;
    setOrder([...data.dashboard.widgets.map((w) => w.key),
              ...data.dashboard.hidden.map((w) => w.key)]);
    setHidden(data.dashboard.hidden.map((w) => w.key));
  }, [data]);

  if (!guid) {
    return (
      <View style={s.wrap}>
        <Empty title="No company yet"
          hint="Connect Tally first — there is nothing to lay out until then." />
      </View>
    );
  }
  if (error) return <View style={s.wrap}><ErrorNote message={error} onRetry={reload} /></View>;
  if (!data) return <Loading />;

  const labelFor = (k: string) => data.dashboard.catalogue.find((c) => c.key === k)?.label ?? k;
  const hintFor = (k: string) => data.dashboard.catalogue.find((c) => c.key === k)?.hint ?? '';

  function move(key: string, by: number) {
    const i = order.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  }

  const toggle = (key: string) =>
    setHidden(hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]);

  async function save() {
    setBusy(true);
    try {
      await put('/v1/preferences', {
        key: 'dashboard.layout',
        company: guid,
        value: { order, hidden, period: data!.dashboard.period },
      });
      Alert.alert('Saved', 'Your dashboard looks like this everywhere you sign in.');
      await reload();
    } catch (e) {
      Alert.alert('Could not save', (e as Error).message);
    } finally { setBusy(false); }
  }

  async function reset() {
    setBusy(true);
    try {
      await post('/v1/preferences/reset', { key: 'dashboard.layout' });
      await reload();
    } catch (e) {
      Alert.alert('Could not reset', (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <View>
          <OfflineBar offline={offline} ageMs={stale} />
          <Text style={s.headName}>Customise</Text>
          <Text style={s.headSub}>Your dashboard, your order</Text>
        </View>
      }
    >
      <View style={{ marginTop: 18 }}><Label>Dashboard sections</Label></View>

      {order.map((key, i) => {
        const off = hidden.includes(key);
        return (
          <Card key={key} style={{ marginTop: 8, opacity: off ? 0.5 : 1 }}>
            <View style={s.row}>
              <Text style={s.num}>{i + 1}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{labelFor(key)}</Text>
                <Text style={s.hint}>{hintFor(key)}</Text>
              </View>
              <Pressable onPress={() => toggle(key)} style={s.iconBtn} hitSlop={6}>
                {off ? <EyeOff size={16} strokeWidth={2.2} color={T.muted} />
                     : <Eye size={16} strokeWidth={2.2} color={T.muted} />}
              </Pressable>
              <Pressable onPress={() => move(key, -1)} disabled={i === 0}
                style={[s.iconBtn, i === 0 && { opacity: 0.25 }]} hitSlop={6}>
                <ArrowUp size={16} strokeWidth={2.2} color={T.muted} />
              </Pressable>
              <Pressable onPress={() => move(key, 1)} disabled={i === order.length - 1}
                style={[s.iconBtn, i === order.length - 1 && { opacity: 0.25 }]} hitSlop={6}>
                <ArrowDown size={16} strokeWidth={2.2} color={T.muted} />
              </Pressable>
            </View>
          </Card>
        );
      })}

      <View style={{ marginTop: 16, flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button title={busy ? 'Saving…' : 'Save'} onPress={save} disabled={busy} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title="Reset" variant="ghost" onPress={reset} disabled={busy} />
        </View>
      </View>

      <View style={s.note}>
        <Info size={12} strokeWidth={2.2} color={T.faint} />
        <Text style={s.noteText}>
          {data.note} A section you have no permission for is never sent to this
          phone at all, whatever you set here.
        </Text>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 16, backgroundColor: T.bg },
  headName: { fontSize: 24, fontWeight: '800', color: T.ink },
  headSub: { fontSize: 13, color: T.muted, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  num: { width: 20, fontSize: 12, fontWeight: '700', color: T.faint },
  name: { fontSize: 14, fontWeight: '600', color: T.ink },
  hint: { fontSize: 11, color: T.faint, marginTop: 2 },
  iconBtn: { padding: 6 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 18,
          marginBottom: 10, backgroundColor: T.bg, borderRadius: 8, padding: 8 },
  noteText: { flex: 1, fontSize: 11, color: T.faint, lineHeight: 16 },
});
