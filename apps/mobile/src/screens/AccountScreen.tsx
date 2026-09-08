import React, { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApi } from '../lib/store';
import { post, put, type AccountStatus } from '../lib/api';
import { shortDate } from '../lib/format';
import {
  Badge, Button, Card, ErrorNote, Label, Loading, Muted, OfflineBar, Screen,
} from '../components/ui';
import { T } from '../theme';
import { AlertTriangle, ShieldCheck, LifeBuoy } from 'lucide-react-native';

/**
 * The end of the relationship, and the way back into it.
 *
 * On the phone this is mostly a place to SEE the state and stop something bad:
 * a pending deletion, a handover waiting to be accepted, a missing recovery
 * contact. Accepting a handover belongs here because the person being handed a
 * business is often not the person at the shop computer.
 */
export default function AccountScreen() {
  const { data, error, loading, reload, stale, offline } = useApi<AccountStatus>('/v1/account');
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<{ message?: string }>) {
    setBusy(key);
    try {
      const r = await fn();
      Alert.alert('Done', r?.message ?? 'Saved.');
      await reload();
    } catch (e) {
      Alert.alert('Could not do that', (e as Error).message);
    } finally { setBusy(null); }
  }

  if (error) return <View style={s.wrap}><ErrorNote message={error} onRetry={reload} /></View>;
  if (loading && !data) return <Loading />;
  if (!data) return <Loading />;

  const recoveryEmail = email ?? data.recovery.email;

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <View>
          <OfflineBar offline={offline} ageMs={stale} />
          <Text style={s.headName}>Account</Text>
          <Text style={s.headSub}>Who owns this business, and how to get back in</Text>
        </View>
      }
    >
      {/* A pending deletion outranks everything else on the screen. */}
      {data.deletion ? (
        <Card style={{ ...s.alarm, marginTop: 16 }}>
          <View style={s.alarmHead}>
            <AlertTriangle size={18} strokeWidth={2.2} color="#b91c1c" />
            <Text style={s.alarmTitle}>
              Scheduled for deletion in {data.deletion.daysLeft} day
              {data.deletion.daysLeft === 1 ? '' : 's'}
            </Text>
          </View>
          <Text style={s.alarmBody}>{data.deletion.note}</Text>
          <Text style={s.alarmWho}>
            Asked for by {data.deletion.requestedBy} on {shortDate(data.deletion.requestedAt)}
          </Text>
          <View style={{ marginTop: 12 }}>
            <Button title={busy === 'cancel' ? 'Stopping…' : 'Keep this account'}
              disabled={busy === 'cancel'}
              onPress={() => run('cancel', () => post('/v1/account/delete/cancel', {}))} />
          </View>
        </Card>
      ) : null}

      {/* Somebody has been offered this business and it is this phone's owner. */}
      {data.transfer ? (
        <Card style={{ marginTop: 14 }}>
          <Label>Handover waiting</Label>
          <Text style={s.body}>
            {data.transfer.to} has been offered this business. Nothing changes until
            they accept. The offer lapses {shortDate(data.transfer.expiresAt)}.
          </Text>
          <View style={{ marginTop: 12, flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button title="Accept"
                disabled={busy === 'accept'}
                onPress={() => run('accept', () =>
                  post(`/v1/account/transfer/${data.transfer!.id}/accept`, {}))} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Decline" variant="ghost"
                disabled={busy === 'decline'}
                onPress={() => run('decline', () =>
                  post(`/v1/account/transfer/${data.transfer!.id}/decline`, {}))} />
            </View>
          </View>
        </Card>
      ) : null}

      <View style={{ marginTop: 20 }}><Label>Safety</Label></View>
      <Card style={{ marginTop: 10 }}>
        <Row k="Sign-in" v="Google only" ok />
        <Row k="Backups"
          v={data.encryptionAtRest ? 'Encrypted at rest' : 'Not encrypted'}
          ok={data.encryptionAtRest} />
        <Row k="Owners" v={`${data.owners.length}`} ok={!data.soleOwner} />
      </Card>

      {data.soleOwner ? (
        <Card style={{ ...s.warn, marginTop: 12 }}>
          <Text style={s.warnText}>{data.soleOwnerWarning}</Text>
        </Card>
      ) : null}

      <View style={{ marginTop: 20 }}><Label>Recovery contact</Label></View>
      <Card style={{ marginTop: 10 }}>
        <Text style={s.body}>{data.recovery.note}</Text>
        <TextInput
          value={recoveryEmail}
          onChangeText={setEmail}
          placeholder="Another email address"
          placeholderTextColor={T.faint}
          autoCapitalize="none"
          keyboardType="email-address"
          style={s.input}
        />
        <View style={{ marginTop: 10 }}>
          <Button title={busy === 'recovery' ? 'Saving…' : 'Save'}
            disabled={busy === 'recovery'}
            onPress={() => run('recovery', () =>
              put('/v1/account/recovery',
                { email: recoveryEmail, phone: data.recovery.phone }))} />
        </View>
        <Text style={s.hint}>
          Use an address on a different Google account to the one you sign in with.
          If that account is the one you lose, a recovery address inside it cannot help.
        </Text>
      </Card>

      <View style={{ marginTop: 20 }}><Label>Owners</Label></View>
      {data.owners.map((o) => (
        <Card key={o.id} style={{ marginTop: 10 }}>
          <View style={s.owner}>
            <View style={{ flex: 1 }}>
              <Text style={s.ownerName}>{o.name || o.email}</Text>
              <Text style={s.ownerMail}>{o.email}</Text>
            </View>
            <Badge tone="ok">Owner</Badge>
          </View>
        </Card>
      ))}

      <View style={{ marginTop: 20, marginBottom: 10 }}>
        <Muted>
          Closing the account, handing it over and exporting everything are on the
          web, where there is room to read what each one does before doing it.
        </Muted>
      </View>
    </Screen>
  );
}

function Row({ k, v, ok }: { k: string; v: string; ok: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.rowK}>{k}</Text>
      <Text style={[s.rowV, !ok && { color: '#b45309', fontWeight: '600' }]}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 16, backgroundColor: T.bg },
  headName: { fontSize: 24, fontWeight: '800', color: T.ink },
  headSub: { fontSize: 13, color: T.muted, marginTop: 2 },
  alarm: { backgroundColor: '#fef2f2', borderColor: '#fecaca', borderWidth: 1 },
  alarmHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  alarmTitle: { flex: 1, fontSize: 15, fontWeight: '700', color: '#7f1d1d' },
  alarmBody: { fontSize: 13, color: '#991b1b', marginTop: 8, lineHeight: 19 },
  alarmWho: { fontSize: 11, color: '#b91c1c', marginTop: 6 },
  warn: { backgroundColor: '#fffbeb', borderColor: '#fde68a', borderWidth: 1 },
  warnText: { fontSize: 13, color: '#78350f', lineHeight: 19 },
  body: { fontSize: 13, color: T.muted, lineHeight: 19 },
  hint: { fontSize: 11, color: T.faint, marginTop: 8, lineHeight: 16 },
  input: {
    marginTop: 12, borderWidth: 1, borderColor: T.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: T.ink,
  },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.line,
  },
  rowK: { fontSize: 13, color: T.muted },
  rowV: { fontSize: 13, color: T.ink },
  owner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ownerName: { fontSize: 14, fontWeight: '600', color: T.ink },
  ownerMail: { fontSize: 12, color: T.muted },
});
