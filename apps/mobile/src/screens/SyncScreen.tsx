import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  RefreshCw, Wifi, WifiOff, CheckCircle2, XCircle, Terminal, Timer,
  ShieldAlert, ScrollText,
} from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { post, patch } from '../lib/api';
import { ago } from '../lib/format';
import {
  Card, EmptyState, ErrorNote, Loading, Muted, Screen, Title,
} from '../components/ui';
import { T } from '../theme';

/**
 * The connector, made visible on the phone.
 *
 * A shop owner is rarely at the PC running Tally. When the figures look wrong,
 * this is the screen that says whether the computer is even switched on - and
 * lets them ask it to sync without walking to it.
 */

type SyncRun = {
  id: string; companyName: string | null; startedAt: string; durationMs: number;
  trigger: string; ok: boolean; records: number; error: string; errorKind: string;
};
type SyncHistory = {
  runs: SyncRun[];
  week: {
    runs: number; failures: number; records: number; avgMs: number;
    lastOkAt: string | null; lastFailAt: string | null; successPct: number | null;
  };
};
type SyncLogs = { lines: { at: string; level: string; line: string }[]; fetchPending: boolean };
type Summary = {
  connection: {
    online: boolean; machineName: string; tallyUp: boolean;
    lastSeenAt: string | null; queuedBatches: number; label: string; hint: string;
  };
};

const FIXES: Record<string, string> = {
  network: 'The shop’s internet dropped. Nothing is lost.',
  auth: 'This computer is no longer linked. Re-pair it.',
  tally: 'Tally was closed. Open Tally and your company.',
};

const INTERVALS = [
  { sec: 3, label: '3s' },
  { sec: 30, label: '30s' },
  { sec: 300, label: '5m' },
  { sec: 1800, label: '30m' },
];

export default function SyncScreen() {
  const { company } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  const hist = useApi<SyncHistory>('/v1/sync/history?limit=40', []);
  const logs = useApi<SyncLogs>('/v1/sync/logs?limit=120', []);
  const summary = useApi<Summary>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/summary` : null,
    [company?.tallyGuid]);

  async function ask(kind: 'sync' | 'reconcile' | 'logs') {
    setBusy(kind); setSaid(null);
    try {
      const r = await post<{ message: string }>('/v1/sync/request', { kind });
      setSaid(r.message);
      if (kind === 'logs') setShowLogs(true);
      // The connector answers on its own beat, so this refreshes once rather
      // than spinning against something it cannot observe.
      setTimeout(() => { hist.reload(); logs.reload(); }, 6000);
    } catch (e) {
      setSaid(e instanceof Error ? e.message : 'Could not ask the connector.');
    } finally {
      setBusy(null);
    }
  }

  async function setEvery(sec: number) {
    setBusy('interval');
    try {
      await patch('/v1/sync/settings', { intervalSeconds: sec });
      setSaid(`Now syncing every ${sec < 60 ? `${sec} seconds` : `${sec / 60} minutes`}.`);
    } catch (e) {
      setSaid(e instanceof Error ? e.message : 'Could not save that.');
    } finally {
      setBusy(null);
    }
  }

  if (hist.error) return <Screen><ErrorNote message={hist.error} onRetry={hist.reload} /></Screen>;
  if (hist.loading && !hist.data) return <Loading label="Checking the connector…" />;

  const conn = summary.data?.connection;
  const w = hist.data?.week;

  return (
    <Screen onRefresh={hist.reload} refreshing={hist.loading} tabBar={false}>
      <Title>Sync</Title>
      <Muted>What the computer running Tally has been doing.</Muted>

      {conn && (
        <Card style={{ marginTop: 14 }}>
          <View style={{ flexDirection: 'row', gap: 11, alignItems: 'flex-start' }}>
            {conn.online
              ? <Wifi size={20} color={T.positive} />
              : <WifiOff size={20} color={T.negative} />}
            <View style={{ flex: 1 }}>
              <Text style={s.connLabel}>{conn.label}</Text>
              <Text style={s.hint}>{conn.hint}</Text>
              {conn.machineName ? (
                <Text style={s.small}>
                  {conn.machineName}
                  {conn.lastSeenAt ? ` · seen ${ago(conn.lastSeenAt)}` : ''}
                </Text>
              ) : null}
            </View>
          </View>

          <View style={s.actions}>
            <Action icon={RefreshCw} label="Sync now" busy={busy === 'sync'}
              onPress={() => ask('sync')} primary />
            <Action icon={ShieldAlert} label="Check deleted" busy={busy === 'reconcile'}
              onPress={() => ask('reconcile')} />
            <Action icon={ScrollText} label="Get logs" busy={busy === 'logs'}
              onPress={() => ask('logs')} />
          </View>

          {said ? <Text style={s.said}>{said}</Text> : null}

          <Text style={s.note}>
            These are requests, not commands. The shop’s computer has no address
            anyone can dial, so it picks them up on its next check-in.
          </Text>
        </Card>
      )}

      {w && (
        <>
          <Text style={s.section}>Last 7 days</Text>
          <Card>
            <Row k="Syncs" v={w.runs.toLocaleString('en-IN')}
              note={w.successPct != null ? `${w.successPct}% succeeded` : undefined} />
            <Row k="Failures" v={String(w.failures)} bad={w.failures > 0}
              note={w.lastFailAt ? `last ${ago(w.lastFailAt)}` : 'none'} />
            <Row k="Records synced" v={w.records.toLocaleString('en-IN')} />
            <Row k="Last success" v={w.lastOkAt ? ago(w.lastOkAt) : '—'}
              note={`typically ${Math.round(w.avgMs)} ms`} />
          </Card>
        </>
      )}

      <Text style={s.section}>Sync every</Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {INTERVALS.map((i) => (
          <Pressable key={i.sec} onPress={() => setEvery(i.sec)} style={s.chip}
            disabled={busy === 'interval'}>
            <Text style={s.chipText}>{i.label}</Text>
          </Pressable>
        ))}
      </View>
      <Muted>Slower saves the shop’s data; faster shows new bills sooner.</Muted>

      <Text style={s.section}>Recent syncs</Text>
      {!hist.data?.runs.length ? (
        <EmptyState title="Nothing recorded yet" icon={CheckCircle2}
          hint="Restart the connector on the shop’s PC — older versions did not report their runs." />
      ) : (
        <Card>
          {hist.data.runs.slice(0, 25).map((r) => (
            <View key={r.id} style={s.run}>
              {r.ok
                ? <CheckCircle2 size={15} color={T.positive} style={{ marginTop: 2 }} />
                : <XCircle size={15} color={T.negative} style={{ marginTop: 2 }} />}
              <View style={{ flex: 1 }}>
                <Text style={s.runTop}>
                  {r.companyName ?? 'All books'} · {ago(r.startedAt)}
                </Text>
                <Text style={s.small}>
                  {r.records.toLocaleString('en-IN')} records · {r.trigger} ·{' '}
                  {r.durationMs < 1000 ? `${r.durationMs} ms` : `${(r.durationMs / 1000).toFixed(1)} s`}
                </Text>
                {!r.ok && (
                  <>
                    {/* Verbatim: rewording it destroys the one string that
                        identifies the fault. */}
                    <Text style={s.err}>{r.error}</Text>
                    {FIXES[r.errorKind] ? <Text style={s.hint}>{FIXES[r.errorKind]}</Text> : null}
                  </>
                )}
              </View>
            </View>
          ))}
        </Card>
      )}

      {logs.data?.fetchPending ? (
        <Text style={[s.hint, { marginTop: 14, color: T.warn }]}>
          Logs asked for. They arrive on the connector’s next check-in.
        </Text>
      ) : null}

      {showLogs && logs.data?.lines.length ? (
        <>
          <Text style={s.section}>Connector log</Text>
          <Card style={{ backgroundColor: '#0F172A' }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View>
                {logs.data.lines.slice(0, 80).map((l, i) => (
                  <Text key={i} style={[
                    s.logLine,
                    l.level === 'error' && { color: '#FB7185' },
                    l.level === 'warn' && { color: '#FBBF24' },
                  ]}>{l.line}</Text>
                ))}
              </View>
            </ScrollView>
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function Action({ icon: Icon, label, onPress, busy, primary }: {
  icon: typeof RefreshCw; label: string; onPress: () => void;
  busy: boolean; primary?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={busy}
      style={[s.action, primary && s.actionPrimary, busy && { opacity: 0.5 }]}>
      <Icon size={15} color={primary ? T.card : T.inkSoft} />
      <Text style={[s.actionText, primary && { color: T.card }]}>
        {busy ? '…' : label}
      </Text>
    </Pressable>
  );
}

function Row({ k, v, note, bad }: { k: string; v: string; note?: string; bad?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.k}>{k}</Text>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[s.v, bad && { color: T.negative }]}>{v}</Text>
        {note ? <Text style={s.small}>{note}</Text> : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  section: {
    fontFamily: T.font.bold, fontSize: 13, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 24, marginBottom: 10,
  },
  connLabel: { fontFamily: T.font.bold, fontSize: 16, color: T.ink },
  hint: { fontFamily: T.font.regular, fontSize: 12, color: T.muted, marginTop: 3, lineHeight: 17 },
  small: { fontFamily: T.font.regular, fontSize: 11, color: T.muted, marginTop: 2 },
  said: {
    fontFamily: T.font.medium, fontSize: 12, color: T.greenDark,
    backgroundColor: T.greenSoft, borderRadius: T.radiusSm,
    padding: 10, marginTop: 12, lineHeight: 17,
  },
  note: {
    fontFamily: T.font.regular, fontSize: 11, color: T.muted,
    marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: T.lineSoft,
    lineHeight: 16,
  },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  actionPrimary: { backgroundColor: T.green },
  actionText: { fontFamily: T.font.semibold, fontSize: 13, color: T.inkSoft },
  chip: {
    paddingHorizontal: 16, paddingVertical: 9,
    borderRadius: 999, backgroundColor: T.lineSoft,
  },
  chipText: { fontFamily: T.font.semibold, fontSize: 13, color: T.inkSoft },
  run: {
    flexDirection: 'row', gap: 10, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  runTop: { fontFamily: T.font.semibold, fontSize: 13, color: T.ink },
  err: { fontFamily: T.font.regular, fontSize: 11, color: T.negative, marginTop: 3 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 9, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  k: { color: T.muted, fontSize: 13, fontFamily: T.font.regular },
  v: { color: T.ink, fontFamily: T.font.bold, fontSize: 14 },
  logLine: { fontFamily: 'monospace', fontSize: 10, color: '#CBD5E1', lineHeight: 15 },
});
