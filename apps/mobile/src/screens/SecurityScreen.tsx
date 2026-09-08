import React, { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import {
  ShieldCheck, Lock, LogIn, XCircle, CheckCircle2, Smartphone, Monitor,
  AlertTriangle, Fingerprint,
} from 'lucide-react-native';
import { useApi } from '../lib/store';
import { post } from '../lib/api';
import { ago } from '../lib/format';
import {
  Card, EmptyState, ErrorNote, Loading, Muted, Screen, Title,
} from '../components/ui';
import { T } from '../theme';

/**
 * Account safety on the phone.
 *
 * The phone is the device this actually matters for: Google protects the
 * account, but nothing protects a handset already signed in and left on the
 * shop counter. That is what the app lock is for.
 */

type SecurityStatus = {
  appLock: { enabled: boolean; minutes: number; biometric: boolean };
  devices: { active: number; trusted: number };
  sessionPolicy: { expires: boolean; note: string };
};
type LoginHistory = {
  events: { at: string; ok: boolean; via: string; reason: string;
            deviceKind: string; deviceLabel: string; ipPrefix: string }[];
  failedLast30Days: number;
};

const DELAYS = [
  { m: 0, label: 'Every time' },
  { m: 5, label: '5 min' },
  { m: 30, label: '30 min' },
  { m: 120, label: '2 hr' },
];

export default function SecurityScreen() {
  const st = useApi<SecurityStatus>('/v1/security', []);
  const hist = useApi<LoginHistory>('/v1/security/logins?limit=40', []);
  const [pin, setPin] = useState('');
  const [minutes, setMinutes] = useState(0);
  const [biometric, setBiometric] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);

  async function save(enable: boolean) {
    setBusy(true); setMsg(null);
    try {
      await post('/v1/security/app-lock',
        enable ? { pin, minutes, biometric } : { enabled: false });
      setPin('');
      setMsg({ text: enable ? 'App lock is on.' : 'App lock is off.', bad: false });
      st.reload();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'Could not save that.', bad: true });
    } finally {
      setBusy(false);
    }
  }

  if (st.error) return <Screen><ErrorNote message={st.error} onRetry={st.reload} /></Screen>;
  if (st.loading && !st.data) return <Loading label="Checking your account…" />;
  const s = st.data;

  return (
    <Screen onRefresh={st.reload} refreshing={st.loading} tabBar={false}>
      <Title>Security</Title>
      <Muted>Who can get at your books, and who has tried.</Muted>

      {hist.data && hist.data.failedLast30Days > 0 ? (
        <View style={s2.alert}>
          <AlertTriangle size={17} color={T.warn} style={{ marginTop: 1 }} />
          <View style={{ flex: 1 }}>
            <Text style={s2.alertTitle}>
              {hist.data.failedLast30Days} failed sign-in
              {hist.data.failedLast30Days === 1 ? '' : 's'} in 30 days
            </Text>
            <Text style={s2.alertBody}>
              If none of these were you, sign out every device and change your
              Google password.
            </Text>
          </View>
        </View>
      ) : null}

      <Text style={s2.section}>How you sign in</Text>
      <Card>
        <Fact k="Method" v="Sign in with Google" />
        <Fact k="Password" v="None — Google holds it" />
        <Fact k="Two-factor" v="Set on your Google account" />
        <Fact k="Stay signed in" v={s?.sessionPolicy.expires ? 'Expires' : 'Until you sign out'} />
        <Text style={s2.note}>{s?.sessionPolicy.note}</Text>
      </Card>

      <Text style={s2.section}>App lock</Text>
      <Card>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Lock size={18} color={T.green} style={{ marginTop: 2 }} />
          <Text style={s2.body}>
            Google protects your account. It cannot protect a phone already
            signed in and lying on the counter.
          </Text>
        </View>

        {s?.appLock.enabled ? (
          <>
            <Text style={s2.on}>
              On · {s.appLock.minutes === 0
                ? 'asks every time the app opens'
                : `asks after ${s.appLock.minutes} minutes idle`}
              {s.appLock.biometric ? ' · fingerprint allowed' : ''}
            </Text>
            <Pressable onPress={() => save(false)} disabled={busy} style={s2.ghostBtn}>
              <Text style={s2.ghostText}>{busy ? '…' : 'Turn off'}</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={s2.label}>PIN (4–8 digits)</Text>
            <TextInput
              value={pin}
              onChangeText={(t) => setPin(t.replace(/\D/g, ''))}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={8}
              style={s2.pin}
              placeholder="••••"
              placeholderTextColor={T.faint} />

            <Text style={s2.label}>Ask again after</Text>
            <View style={{ flexDirection: 'row', gap: 7, flexWrap: 'wrap' }}>
              {DELAYS.map((d) => (
                <Pressable key={d.m} onPress={() => setMinutes(d.m)}
                  style={[s2.chip, minutes === d.m && s2.chipOn]}>
                  <Text style={[s2.chipText, minutes === d.m && s2.chipTextOn]}>{d.label}</Text>
                </Pressable>
              ))}
            </View>

            <View style={s2.row}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Fingerprint size={16} color={T.muted} />
                <Text style={s2.k}>Allow fingerprint</Text>
              </View>
              <Switch value={biometric} onValueChange={setBiometric}
                trackColor={{ true: T.greenMid }} />
            </View>

            <Pressable onPress={() => save(true)} disabled={busy || pin.length < 4}
              style={[s2.btn, (busy || pin.length < 4) && { opacity: 0.5 }]}>
              <Text style={s2.btnText}>{busy ? 'Saving…' : 'Turn on app lock'}</Text>
            </Pressable>
          </>
        )}

        {msg ? (
          <Text style={[s2.msg, { color: msg.bad ? T.negative : T.positive }]}>{msg.text}</Text>
        ) : null}
      </Card>

      <Text style={s2.section}>Sign-in history</Text>
      {!hist.data?.events.length ? (
        <EmptyState title="Nothing recorded yet" icon={LogIn}
          hint="Sign-ins from now on appear here." />
      ) : (
        <Card>
          {hist.data.events.slice(0, 25).map((e, i) => (
            <View key={i} style={s2.event}>
              {e.ok
                ? <CheckCircle2 size={15} color={T.positive} style={{ marginTop: 2 }} />
                : <XCircle size={15} color={T.negative} style={{ marginTop: 2 }} />}
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {e.deviceKind === 'mobile'
                    ? <Smartphone size={12} color={T.muted} />
                    : <Monitor size={12} color={T.muted} />}
                  <Text style={s2.eventTop}>{e.deviceLabel || e.deviceKind || 'Unknown device'}</Text>
                </View>
                <Text style={s2.small}>
                  {ago(e.at)}{e.ipPrefix ? ` · ${e.ipPrefix}` : ''}
                </Text>
                {!e.ok && e.reason ? <Text style={s2.reason}>{e.reason}</Text> : null}
              </View>
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <View style={s2.row}>
      <Text style={s2.k}>{k}</Text>
      <Text style={s2.v}>{v}</Text>
    </View>
  );
}

const s2 = StyleSheet.create({
  section: {
    fontFamily: T.font.bold, fontSize: 13, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 24, marginBottom: 10,
  },
  alert: {
    flexDirection: 'row', gap: 10, backgroundColor: T.warnSoft,
    borderRadius: T.radiusSm, padding: 14, marginTop: 14,
  },
  alertTitle: { fontFamily: T.font.semibold, fontSize: 14, color: T.warn },
  alertBody: { fontFamily: T.font.regular, fontSize: 12, color: T.inkSoft, marginTop: 3, lineHeight: 17 },
  body: { flex: 1, fontFamily: T.font.regular, fontSize: 13, color: T.inkSoft, lineHeight: 19 },
  note: {
    fontFamily: T.font.regular, fontSize: 12, color: T.greenDark,
    backgroundColor: T.greenSoft, borderRadius: T.radiusSm,
    padding: 10, marginTop: 12, lineHeight: 17,
  },
  on: { fontFamily: T.font.semibold, fontSize: 13, color: T.positive, marginTop: 12 },
  label: { fontFamily: T.font.semibold, fontSize: 12, color: T.muted, marginTop: 16, marginBottom: 7 },
  pin: {
    borderWidth: 1, borderColor: T.line, borderRadius: T.radiusSm,
    paddingHorizontal: 14, paddingVertical: 11, width: 130,
    fontSize: 18, letterSpacing: 6, color: T.ink, fontFamily: T.font.semibold,
  },
  chip: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999, backgroundColor: T.lineSoft },
  chipOn: { backgroundColor: T.green },
  chipText: { fontFamily: T.font.semibold, fontSize: 12, color: T.inkSoft },
  chipTextOn: { color: T.card },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  k: { color: T.muted, fontSize: 13, fontFamily: T.font.regular },
  v: { color: T.ink, fontFamily: T.font.semibold, fontSize: 13 },
  btn: {
    backgroundColor: T.green, borderRadius: T.radiusSm,
    paddingVertical: 13, alignItems: 'center', marginTop: 16,
  },
  btnText: { color: T.card, fontFamily: T.font.bold, fontSize: 14 },
  ghostBtn: {
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm,
    paddingVertical: 11, alignItems: 'center', marginTop: 14,
  },
  ghostText: { color: T.inkSoft, fontFamily: T.font.semibold, fontSize: 13 },
  msg: { fontFamily: T.font.medium, fontSize: 12, marginTop: 12, lineHeight: 17 },
  event: {
    flexDirection: 'row', gap: 10, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  eventTop: { fontFamily: T.font.semibold, fontSize: 13, color: T.ink },
  small: { fontFamily: T.font.regular, fontSize: 11, color: T.muted, marginTop: 2 },
  reason: { fontFamily: T.font.regular, fontSize: 11, color: T.negative, marginTop: 2 },
});
