import React, { useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useApp, useApi } from '../lib/store';
import { del, post, type Devices } from '../lib/api';
import { ago, shortDate } from '../lib/format';
import {
  Badge, Button, Card, Empty, ErrorNote, Label, Loading, Muted, OfflineBar, Screen, Title,
} from '../components/ui';
import { T } from '../theme';

/**
 * Linked devices.
 *
 * Revoking from the phone is the point: a shop computer that was sold, stolen
 * or replaced has to stop syncing without anyone travelling to it. Revoking
 * breaks the stored token server-side, so the connector must be paired again.
 */
export default function DevicesScreen({ navigation }: any) {
  const { refresh } = useApp();
  const { data, error, loading, reload, stale, offline } = useApi<Devices>('/v1/devices');
  const [busy, setBusy] = useState<string | null>(null);

  function confirmRevoke(kind: 'connectors' | 'signins', id: string, label: string) {
    const isPc = kind === 'connectors';
    Alert.alert(
      isPc ? 'Unlink this computer?' : 'Sign out this device?',
      isPc
        ? `${label} will stop syncing until it is linked again.`
        : `${label} will need to sign in with Google again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: isPc ? 'Unlink' : 'Sign out',
          style: 'destructive',
          onPress: async () => {
            setBusy(id);
            try {
              await del(`/v1/devices/${kind}/${id}`);
              await reload();
              await refresh();
            } catch (e) {
              Alert.alert('Could not do that', (e as Error).message);
            } finally { setBusy(null); }
          },
        },
      ],
    );
  }

  /**
   * The recovery action for a lost or stolen phone. Deliberately does not ask
   * which session to cut: the owner usually cannot tell them apart, and a wrong
   * guess leaves the thief signed in.
   */
  function signOutOthers() {
    Alert.alert(
      'Sign out all other devices?',
      'Every phone and computer signed in to this account, except this one, '
      + 'will be signed out straight away. Your data is not touched.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out all',
          style: 'destructive',
          onPress: async () => {
            setBusy('all');
            try {
              const r = await post<{ revoked: number; message: string }>(
                '/v1/devices/signins/revoke-others', {});
              await reload();
              Alert.alert('Done', r.message);
            } catch (e) {
              Alert.alert('Could not do that', (e as Error).message);
            } finally { setBusy(null); }
          },
        },
      ],
    );
  }

  if (error) return <View style={s.wrap}><ErrorNote message={error} onRetry={reload} /></View>;
  if (loading || !data) return <Loading />;

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <View>
      <OfflineBar offline={offline} ageMs={stale} />
          <Text style={s.headName}>Linked devices</Text>
          <Text style={s.headSub}>Computers syncing, and phones signed in</Text>
        </View>
      }
    >

      <View style={{ marginTop: 18 }}>
        <Label>Tally computers</Label>
      </View>

      {data.connectors.length === 0 ? (
        <Card style={{ marginTop: 10 }}>
          <Empty title="No computer linked"
            hint="Run Munim on the PC where Tally is installed, then scan the code it shows." />
          <View style={{ marginTop: 14 }}>
            <Button title="Scan a code now" onPress={() => navigation.navigate('LinkTally')} />
          </View>
        </Card>
      ) : data.connectors.map((c) => (
        <Card key={c.id} style={{ marginTop: 10, opacity: c.revoked ? 0.6 : 1 }}>
          <View style={s.head}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{c.machine}</Text>
              <Text style={s.sub}>
                {c.tallyVersion === 'erp9' ? 'Tally ERP 9' : 'Tally Prime'}
                {c.appVersion ? ` · v${c.appVersion}` : ''}
              </Text>
              <Text style={s.sub}>
                linked {shortDate(c.pairedAt)} · seen {ago(c.lastSeenAt)}
              </Text>
            </View>
            <Badge tone={c.revoked ? 'muted' : c.status === 'ok' ? 'ok' : 'warn'}>
              {c.revoked ? 'Unlinked' : c.status === 'ok' ? 'Syncing' : c.status}
            </Badge>
          </View>
          {!c.revoked ? (
            <View style={{ marginTop: 12 }}>
              <Button title={busy === c.id ? 'Unlinking…' : 'Unlink this computer'}
                variant="ghost" disabled={busy === c.id}
                onPress={() => confirmRevoke('connectors', c.id, c.machine)} />
            </View>
          ) : null}
        </Card>
      ))}

      <View style={{ marginTop: 22 }}>
        <Label>Signed in</Label>
      </View>

      {data.signIns.map((si) => (
        <Card key={si.id} style={{ marginTop: 10 }}>
          <View style={s.head}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{si.device || si.name || si.phone}</Text>
              <Text style={s.sub}>
                {si.phone} · signed in {ago(si.signedInAt)}
                {si.lastSeenAt ? ` · last used ${ago(si.lastSeenAt)}` : ''}
              </Text>
            </View>
            {si.current ? <Badge tone="ok">This phone</Badge> : null}
          </View>
          {!si.current ? (
            <View style={{ marginTop: 12 }}>
              <Button title={busy === si.id ? 'Signing out…' : 'Sign out'}
                variant="ghost" disabled={busy === si.id}
                onPress={() => confirmRevoke('signins', si.id, si.phone)} />
            </View>
          ) : null}
        </Card>
      ))}

      {data.signIns.some((si) => !si.current) ? (
        <Card style={{ marginTop: 14 }}>
          <Text style={s.name}>Lost your phone?</Text>
          <Text style={s.sub}>
            Sign out every other device at once. You do not have to work out
            which one it was — and if you guess wrong, the wrong phone stays
            signed in. Nothing here is deleted; you just sign in again.
          </Text>
          <View style={{ marginTop: 12 }}>
            <Button
              title={busy === 'all' ? 'Signing out…' : 'Sign out all other devices'}
              variant="ghost"
              disabled={busy === 'all'}
              onPress={signOutOthers}
            />
          </View>
        </Card>
      ) : null}

      <Text style={s.note}>
        Unlinking stops that computer syncing immediately. Its access is revoked
        on the server, not just hidden here.
      </Text>
      <View style={{ height: 28 }} />
    </Screen>
  );
}

const s = StyleSheet.create({
  headName: { fontSize: 19, fontFamily: T.font.bold, color: T.ink, letterSpacing: -0.3 },
  headSub: { fontSize: 12.5, color: T.muted, marginTop: 2, fontFamily: T.font.regular },
  wrap: { padding: 16, backgroundColor: T.bg, flexGrow: 1 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  name: { fontFamily: T.font.bold, color: T.ink, fontSize: 15 },
  sub: { color: T.muted, fontSize: 12, marginTop: 2 },
  note: { color: T.muted, fontSize: 12, marginTop: 18, lineHeight: 18 },
});
