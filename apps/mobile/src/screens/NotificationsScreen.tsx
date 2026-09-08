import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import {
  Bell, BellOff, Check, Info, AlertTriangle, CircleAlert, Moon,
} from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { get, post, patch } from '../lib/api';
import { ago } from '../lib/format';
import {
  Badge, Card, EmptyState, ErrorNote, Loading, Muted, Screen, Title,
} from '../components/ui';
import { T } from '../theme';

/**
 * What has happened since you last looked.
 *
 * The phone is where this matters: an owner who is not at the shop finds out
 * a bill went overdue without opening a report and going looking for it.
 */

type Feed = {
  notifications: { id: string; event: string; label: string;
                   level: 'info' | 'warn' | 'bad'; title: string; body: string;
                   link: { screen?: string; id?: string; name?: string; section?: string };
                   at: string; read: boolean }[];
  unread: number;
};
type Settings = {
  rules: { event: string; label: string; hint: string; level: string;
           enabled: boolean; visibleToMe: boolean }[];
  mine: { quietFrom: number; quietTo: number; muted: boolean; inQuietHoursNow: boolean };
  note: string;
};

const ICON = { info: Info, warn: AlertTriangle, bad: CircleAlert };
const COLOUR = { info: T.muted, warn: T.warn, bad: T.negative };
const hourLabel = (h: number) =>
  h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`;

export default function NotificationsScreen({ navigation }: any) {
  const { company } = useApp();
  const feed = useApi<Feed>('/v1/notifications?limit=50', []);
  const cfg = useApi<Settings>('/v1/notifications/settings', []);

  /*
   * Check for the things nothing else reports.
   *
   * A voucher announces itself when it syncs; a bill falling overdue does not,
   * because nothing happens at the moment it becomes true.
   */
  useEffect(() => {
    if (!company) return;
    get(`/v1/companies/${encodeURIComponent(company.tallyGuid)}/notify-sweep`)
      .then(() => feed.reload())
      .catch(() => { /* a missed sweep is not worth surfacing */ });
  }, [company?.tallyGuid]);

  function open(n: Feed['notifications'][number]) {
    void post('/v1/notifications/read', { ids: [Number(n.id)] }).then(() => feed.reload());
    const l = n.link ?? {};
    if (l.screen === 'party' && l.name) navigation.navigate('Party', { name: l.name });
    else if (l.screen === 'item' && l.name) navigation.navigate('Item', { name: l.name });
    else if (l.screen === 'voucher' && l.id) navigation.navigate('Invoice', { id: l.id });
    else if (l.screen === 'sync') navigation.navigate('Sync');
  }

  if (feed.error) return <Screen><ErrorNote message={feed.error} onRetry={feed.reload} /></Screen>;
  if (feed.loading && !feed.data) return <Loading label="Checking…" />;

  const mine = cfg.data?.mine;

  return (
    <Screen onRefresh={feed.reload} refreshing={feed.loading} tabBar={false}>
      <Title>Notifications</Title>
      <Muted>
        {feed.data?.unread
          ? `${feed.data.unread} new`
          : 'New sales, overdue bills and sync problems appear here.'}
      </Muted>

      {feed.data && feed.data.unread > 0 ? (
        <Pressable onPress={async () => { await post('/v1/notifications/read', {}); feed.reload(); }}
          style={s.markAll}>
          <Check size={14} color={T.green} />
          <Text style={s.markAllText}>Mark all read</Text>
        </Pressable>
      ) : null}

      {!feed.data?.notifications.length ? (
        <EmptyState title="Nothing yet" icon={Bell}
          hint="You will hear about new sales, bills falling overdue and sync problems." />
      ) : (
        <Card style={{ marginTop: 14 }}>
          {feed.data.notifications.map((n) => {
            const I = ICON[n.level] ?? Info;
            return (
              <Pressable key={n.id} onPress={() => open(n)}
                style={[s.row, n.read && { opacity: 0.55 }]}>
                <I size={16} color={COLOUR[n.level]} style={{ marginTop: 2 }} />
                <View style={{ flex: 1 }}>
                  <Text style={s.title}>{n.title}</Text>
                  {n.body ? <Text style={s.body}>{n.body}</Text> : null}
                  <Text style={s.meta}>{n.label} · {ago(n.at)}</Text>
                </View>
                {!n.read ? <View style={s.dot} /> : null}
              </Pressable>
            );
          })}
        </Card>
      )}

      {mine ? (
        <>
          <Text style={s.section}>Quiet hours</Text>
          <Card>
            <View style={s.settingRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                <Moon size={16} color={T.muted} />
                <Text style={s.settingLabel}>
                  Silent {hourLabel(mine.quietFrom)} to {hourLabel(mine.quietTo)}
                </Text>
              </View>
              {mine.inQuietHoursNow ? <Badge tone="warn">Quiet now</Badge> : null}
            </View>
            <View style={s.settingRow}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                {mine.muted ? <BellOff size={16} color={T.muted} /> : <Bell size={16} color={T.muted} />}
                <Text style={s.settingLabel}>Mute everything</Text>
              </View>
              <Switch value={mine.muted} trackColor={{ true: T.greenMid }}
                onValueChange={async (v) => {
                  await patch('/v1/notifications/mine', { muted: v });
                  cfg.reload();
                }} />
            </View>
            {/* The window itself is set on the web: two dropdowns of 24 hours
                each is a worse control on a phone than a sentence. */}
            <Muted>Change the hours in Munim on a computer.</Muted>
          </Card>

          <Text style={s.section}>What you hear about</Text>
          <Card>
            {(cfg.data?.rules ?? []).filter((r) => r.visibleToMe).map((r) => (
              <View key={r.event} style={s.settingRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.settingLabel}>{r.label}</Text>
                  <Text style={s.meta}>{r.hint}</Text>
                </View>
                <Switch value={r.enabled} trackColor={{ true: T.greenMid }}
                  onValueChange={async (v) => {
                    await post('/v1/notifications/rules', { event: r.event, enabled: v });
                    cfg.reload();
                  }} />
              </View>
            ))}
          </Card>
          <Muted>{cfg.data?.note}</Muted>
        </>
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  section: {
    fontFamily: T.font.bold, fontSize: 13, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 24, marginBottom: 10,
  },
  markAll: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start', marginTop: 12,
    backgroundColor: T.greenSoft, borderRadius: T.radiusSm,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  markAllText: { fontFamily: T.font.semibold, fontSize: 12, color: T.greenDark },
  row: {
    flexDirection: 'row', gap: 10, paddingVertical: 11,
    borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  title: { fontFamily: T.font.semibold, fontSize: 14, color: T.ink },
  body: { fontFamily: T.font.regular, fontSize: 12, color: T.inkSoft, marginTop: 2 },
  meta: { fontFamily: T.font.regular, fontSize: 11, color: T.muted, marginTop: 3 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: T.green, marginTop: 6 },
  settingRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  settingLabel: { fontFamily: T.font.semibold, fontSize: 13, color: T.ink },
});
