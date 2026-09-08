import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Users, UserPlus, Shield, Ban, Check, X, Info } from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { post, patch, del } from '../lib/api';
import { ago } from '../lib/format';
import {
  Card, EmptyState, ErrorNote, Loading, Muted, Screen, Title, Badge,
} from '../components/ui';
import { T } from '../theme';

/**
 * Who else may see the books.
 *
 * The phone gets the same controls as the web because the owner is usually not
 * at a desk: disabling a salesperson who has walked out with a signed-in
 * handset is exactly the thing you need to do from wherever you are.
 */

type Role = {
  id: string; key: string; name: string; description: string;
  builtIn: boolean; permissions: Record<string, string[]>; users: number;
};
type OrgUser = {
  id: string; name: string; email: string | null; status: 'active' | 'disabled';
  roleId: string | null; roleKey?: string; roleName: string; branch: string;
  isSalesperson: boolean; activeDevices: number; lastSeenAt: string | null;
  companies: string[];
};
type Invite = {
  id: string; email: string; name: string; roleName: string; invitedAt: string;
};

export default function UsersScreen() {
  const { me } = useApp();
  const list = useApi<{ users: OrgUser[]; invites: Invite[] }>('/v1/users', []);
  const roles = useApi<{ roles: Role[] }>('/v1/roles', []);

  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('employee');
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);

  const canManage = me?.permissions?.users?.create ?? false;

  async function run(fn: () => Promise<unknown>, key: string) {
    setBusy(key); setMsg(null);
    try {
      const r = await fn() as { note?: string };
      if (r?.note) setMsg({ text: r.note, bad: false });
      list.reload();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'That did not work.', bad: true });
    } finally { setBusy(null); }
  }

  function confirmDisable(u: OrgUser) {
    const off = u.status === 'active';
    Alert.alert(
      off ? `Disable ${u.name || u.email}?` : `Enable ${u.name || u.email}?`,
      off
        // The consequence stated plainly, because it is immediate and total.
        ? 'They are signed out of every device straight away and cannot sign back in.'
        : 'They will be able to sign in with Google again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: off ? 'Disable' : 'Enable',
          style: off ? 'destructive' : 'default',
          onPress: () => run(
            () => post(`/v1/users/${u.id}/status`, { status: off ? 'disabled' : 'active' }), u.id),
        },
      ]);
  }

  if (list.error) return <Screen><ErrorNote message={list.error} onRetry={list.reload} /></Screen>;
  if (list.loading && !list.data) return <Loading label="Loading your team…" />;

  if (!me?.permissions?.users?.read) {
    return (
      <Screen>
        <EmptyState title="Not your area" icon={Shield}
          hint="Only people with access to Users & roles can see this. Ask the account owner." />
      </Screen>
    );
  }

  return (
    <Screen onRefresh={list.reload} refreshing={list.loading} tabBar={false}>
      <Title>Users & roles</Title>
      <Muted>Who can see your books, and how much of them.</Muted>

      {msg ? (
        <Text style={[s.msg, { color: msg.bad ? T.negative : T.positive }]}>{msg.text}</Text>
      ) : null}

      {canManage ? (
        <Card style={{ marginTop: 14 }}>
          {!inviting ? (
            <Pressable onPress={() => setInviting(true)} style={s.primaryBtn}>
              <UserPlus size={16} color={T.card} />
              <Text style={s.primaryText}>Invite someone</Text>
            </Pressable>
          ) : (
            <>
              <Text style={s.label}>Their Google email</Text>
              <TextInput value={email} onChangeText={setEmail}
                autoCapitalize="none" keyboardType="email-address" autoCorrect={false}
                placeholder="accountant@gmail.com" placeholderTextColor={T.faint}
                style={s.input} />

              <Text style={s.label}>Role</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 7, paddingBottom: 4 }}>
                {(roles.data?.roles ?? []).filter((r) => r.key !== 'owner').map((r) => (
                  <Pressable key={r.key} onPress={() => setRoleKey(r.key)}
                    style={[s.chip, roleKey === r.key && s.chipOn]}>
                    <Text style={[s.chipText, roleKey === r.key && s.chipTextOn]}>{r.name}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              {roles.data?.roles.find((r) => r.key === roleKey) ? (
                <Text style={s.hint}>
                  {roles.data.roles.find((r) => r.key === roleKey)!.description}
                </Text>
              ) : null}

              <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
                <Pressable
                  onPress={() => run(async () => {
                    const r = await post<{ note: string }>('/v1/users/invite', { email, roleKey });
                    setEmail(''); setInviting(false);
                    return r;
                  }, 'invite')}
                  disabled={busy === 'invite' || !email}
                  style={[s.primaryBtn, { flex: 1 }, (!email || busy === 'invite') && { opacity: 0.5 }]}>
                  <Text style={s.primaryText}>{busy === 'invite' ? 'Inviting…' : 'Invite'}</Text>
                </Pressable>
                <Pressable onPress={() => setInviting(false)} style={s.ghostBtn}>
                  <Text style={s.ghostText}>Cancel</Text>
                </Pressable>
              </View>

              <View style={s.info}>
                <Info size={13} color={T.greenDark} style={{ marginTop: 1 }} />
                <Text style={s.infoText}>
                  Munim does not send an email. Tell them to sign in with that
                  Google account and they land straight in your books.
                </Text>
              </View>
            </>
          )}
        </Card>
      ) : null}

      <Text style={s.section}>People</Text>
      {list.data?.users.map((u) => {
        const isOwner = u.roleName === 'Owner';
        const isSelf = u.id === me?.user.id;
        const off = u.status === 'disabled';
        return (
          <Card key={u.id} style={{ marginBottom: 10, opacity: off ? 0.6 : 1 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Text style={s.name}>{u.name || u.email}</Text>
                  {isSelf ? <Badge tone="ok">You</Badge> : null}
                  {off ? <Badge tone="bad">Disabled</Badge> : null}
                </View>
                <Text style={s.small}>{u.email}</Text>
                <Text style={s.small}>
                  {u.roleName}
                  {u.branch ? ` · ${u.branch}` : ''}
                  {` · ${u.activeDevices} device${u.activeDevices === 1 ? '' : 's'}`}
                  {u.lastSeenAt ? ` · seen ${ago(u.lastSeenAt)}` : ' · never signed in'}
                </Text>
              </View>
              {canManage && !isOwner && !isSelf ? (
                <Pressable onPress={() => confirmDisable(u)} disabled={busy === u.id}
                  style={s.iconBtn}>
                  {off ? <Check size={16} color={T.positive} /> : <Ban size={16} color={T.negative} />}
                </Pressable>
              ) : null}
            </View>
          </Card>
        );
      })}

      {list.data?.invites.length ? (
        <>
          <Text style={s.section}>Invited, not yet arrived</Text>
          {list.data.invites.map((i) => (
            <Card key={i.id} style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{i.name || i.email}</Text>
                  <Text style={s.small}>{i.email} · {i.roleName}</Text>
                  <Text style={s.small}>Invited {ago(i.invitedAt)}. Waiting for them to sign in.</Text>
                </View>
                {canManage ? (
                  <Pressable onPress={() => run(() => del(`/v1/invites/${i.id}`), i.id)}
                    style={s.iconBtn}>
                    <X size={16} color={T.muted} />
                  </Pressable>
                ) : null}
              </View>
            </Card>
          ))}
        </>
      ) : null}

      <Text style={s.section}>Roles</Text>
      {(roles.data?.roles ?? []).map((r) => (
        <Card key={r.id} style={{ marginBottom: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <Text style={s.name}>{r.name}</Text>
            {r.builtIn ? <Badge tone="ok">Built in</Badge> : null}
          </View>
          <Text style={s.hint}>{r.description}</Text>
          <Text style={s.small}>
            {r.users} {r.users === 1 ? 'person' : 'people'} ·{' '}
            {Object.keys(r.permissions).length} section(s)
          </Text>
        </Card>
      ))}
      {/* Editing the grid is a desk job - it is a 12x8 matrix. */}
      <Muted>To change what a role can see, open Munim on a computer.</Muted>
    </Screen>
  );
}

const s = StyleSheet.create({
  section: {
    fontFamily: T.font.bold, fontSize: 13, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 24, marginBottom: 10,
  },
  name: { fontFamily: T.font.bold, fontSize: 15, color: T.ink },
  small: { fontFamily: T.font.regular, fontSize: 11, color: T.muted, marginTop: 2 },
  hint: { fontFamily: T.font.regular, fontSize: 12, color: T.muted, marginTop: 6, lineHeight: 17 },
  label: { fontFamily: T.font.semibold, fontSize: 12, color: T.muted, marginTop: 14, marginBottom: 7 },
  input: {
    borderWidth: 1, borderColor: T.line, borderRadius: T.radiusSm,
    paddingHorizontal: 12, paddingVertical: 11, fontSize: 14,
    color: T.ink, fontFamily: T.font.regular,
  },
  chip: { paddingHorizontal: 13, paddingVertical: 8, borderRadius: 999, backgroundColor: T.lineSoft },
  chipOn: { backgroundColor: T.green },
  chipText: { fontFamily: T.font.semibold, fontSize: 12, color: T.inkSoft },
  chipTextOn: { color: T.card },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: T.green, borderRadius: T.radiusSm, paddingVertical: 12,
  },
  primaryText: { color: T.card, fontFamily: T.font.bold, fontSize: 14 },
  ghostBtn: {
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm,
    paddingVertical: 12, paddingHorizontal: 18, justifyContent: 'center',
  },
  ghostText: { color: T.inkSoft, fontFamily: T.font.semibold, fontSize: 13 },
  iconBtn: {
    width: 38, height: 38, borderRadius: T.radiusSm, backgroundColor: T.lineSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  info: {
    flexDirection: 'row', gap: 8, backgroundColor: T.greenSoft,
    borderRadius: T.radiusSm, padding: 10, marginTop: 12,
  },
  infoText: { flex: 1, fontFamily: T.font.regular, fontSize: 11, color: T.greenDark, lineHeight: 16 },
  msg: { fontFamily: T.font.medium, fontSize: 12, marginTop: 12, lineHeight: 17 },
});
