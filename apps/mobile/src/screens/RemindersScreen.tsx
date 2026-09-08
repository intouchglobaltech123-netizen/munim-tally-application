import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  MessageCircle, Mail, Check, X, BellOff, Info, CheckCircle2, AlertTriangle,
  History, Clock3,
} from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { useMoney } from '../lib/money';
import { post, put } from '../lib/api';
import { ago } from '../lib/format';
import {
  Badge, Card, EmptyState, ErrorNote, Loading, Muted, Screen, Title,
} from '../components/ui';
import { shareOnWhatsApp, shareByEmail } from '../lib/share';
import { T } from '../theme';

/**
 * Chasing money from the phone, which is where it should happen.
 *
 * WhatsApp is on this device. Munim writes the message, opens WhatsApp with it
 * ready, and records that it handed it over. The owner presses send, so it
 * comes from their own number - which is what their customer recognises.
 */

type Job = {
  party: string; phone: string; email: string; amountPaise: number;
  bills: { ref: string; dueDate: string; amountPaise: number }[];
  daysOverdue: number;
  rule: { id: string; name: string; trigger: string; days: number };
  templateId: string | null; channel: string;
  message: string; reachable: boolean; remindedBefore: number;
};
type Worklist = {
  asOf: string; company: { name: string }; worklist: Job[];
  totals: { parties: number; amountPaise: number; unreachable: number };
  note: string;
};
type Hist = {
  reminders: { id: string; party: string; amountPaise: number; status: string;
               at: string; by: string }[];
  last90Days: { total: number; sent: number; skipped: number;
                settledAfterReminder: number; caveat: string };
};

export default function RemindersScreen() {
  const { company } = useApp();
  const money = useMoney();
  const [tab, setTab] = useState<'today' | 'history'>('today');
  const [done, setDone] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;
  const work = useApi<Worklist>(base && `${base}/reminders`, [company?.tallyGuid]);
  const hist = useApi<Hist>('/v1/reminders/history?limit=60', []);

  async function record(job: Job, status: string) {
    if (!base) return;
    setDone((d) => ({ ...d, [job.party]: status }));
    try {
      await post(`${base}/reminders/record`, {
        party: job.party, phone: job.phone, amountPaise: job.amountPaise,
        channel: job.channel, status, ruleId: job.rule.id, templateId: job.templateId,
        billRefs: job.bills.map((b) => b.ref),
        dueDate: job.bills[0]?.dueDate ?? '',
        daysOverdue: job.daysOverdue, message: job.message,
      });
      hist.reload();
    } catch { /* the reminder still went; the record can be retried */ }
  }

  async function optOut(party: string) {
    if (!base) return;
    await put(`${base}/reminders/party/${encodeURIComponent(party)}`, { noReminders: true });
    work.reload();
  }

  if (work.error) return <Screen><ErrorNote message={work.error} onRetry={work.reload} /></Screen>;
  if (work.loading && !work.data) return <Loading label="Working out who to chase…" />;

  return (
    <Screen onRefresh={work.reload} refreshing={work.loading} tabBar={false}>
      <Title>Reminders</Title>
      <Muted>
        {work.data
          ? `${work.data.totals.parties} to chase · ${money(work.data.totals.amountPaise)}`
          : ''}
      </Muted>

      <View style={{ flexDirection: 'row', gap: 7, marginTop: 14, marginBottom: 14 }}>
        {(['today', 'history'] as const).map((k) => (
          <Pressable key={k} onPress={() => setTab(k)} style={[s.chip, tab === k && s.chipOn]}>
            <Text style={[s.chipText, tab === k && s.chipTextOn]}>
              {k === 'today' ? 'To chase' : 'History'}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === 'today' ? (
        !work.data?.worklist.length ? (
          <EmptyState title="Nobody to chase today" icon={CheckCircle2}
            hint="Either everything is current, or everyone due a reminder has had one recently." />
        ) : (
          <>
            <View style={s.info}>
              <Info size={13} color={T.greenDark} style={{ marginTop: 1 }} />
              <Text style={s.infoText}>{work.data.note}</Text>
            </View>

            {work.data.totals.unreachable > 0 ? (
              <View style={[s.info, { backgroundColor: T.warnSoft }]}>
                <AlertTriangle size={13} color={T.warn} style={{ marginTop: 1 }} />
                <Text style={[s.infoText, { color: T.warn }]}>
                  {work.data.totals.unreachable} of these have no phone number in Tally.
                </Text>
              </View>
            ) : null}

            {work.data.worklist.map((job) => (
              <Card key={job.party} style={{ marginBottom: 10, opacity: done[job.party] ? 0.6 : 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.party}>{job.party}</Text>
                    <Text style={s.meta}>
                      {job.bills.length} bill{job.bills.length === 1 ? '' : 's'} ·{' '}
                      {job.phone || 'no phone on file'}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
                      <Badge tone={job.daysOverdue > 30 ? 'bad' : job.daysOverdue > 0 ? 'warn' : 'ok'}>
                        {job.daysOverdue > 0 ? `${job.daysOverdue}d overdue` : 'due soon'}
                      </Badge>
                      {job.remindedBefore > 0 ? (
                        <Badge tone="warn">chased {job.remindedBefore}×</Badge>
                      ) : null}
                      {done[job.party] ? <Badge tone="ok">{done[job.party]}</Badge> : null}
                    </View>
                  </View>
                  <Text style={s.amount}>{money(job.amountPaise, { compact: true })}</Text>
                </View>

                <Pressable onPress={() => setExpanded(expanded === job.party ? null : job.party)}
                  style={s.preview}>
                  <Text style={s.previewText}
                    numberOfLines={expanded === job.party ? undefined : 2}>
                    {job.message}
                  </Text>
                </Pressable>

                <View style={s.actions}>
                  <Action Icon={MessageCircle} label="WhatsApp" primary
                    disabled={!job.reachable}
                    onPress={() => {
                      shareOnWhatsApp(job.message, job.phone);
                      record(job, 'handed-off');
                    }} />
                  {job.email ? (
                    <Action Icon={Mail} label="Email"
                      onPress={() => {
                        shareByEmail(`Payment reminder from ${work.data!.company.name}`,
                          job.message, job.email);
                        record(job, 'handed-off');
                      }} />
                  ) : null}
                  <Action Icon={Check} label="Sent" onPress={() => record(job, 'sent')} />
                  <Action Icon={X} label="Skip" onPress={() => record(job, 'skipped')} />
                  <Action Icon={BellOff} label="Never" onPress={() => optOut(job.party)} />
                </View>
              </Card>
            ))}
          </>
        )
      ) : (
        <>
          {hist.data ? (
            <>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginBottom: 12 }}>
                <Stat label="Chased" value={String(hist.data.last90Days.total)} />
                <Stat label="Sent" value={String(hist.data.last90Days.sent)} />
                <Stat label="Skipped" value={String(hist.data.last90Days.skipped)} />
                <Stat label="Settled after"
                  value={String(hist.data.last90Days.settledAfterReminder)} />
              </View>
              <View style={s.info}>
                <Info size={13} color={T.muted} style={{ marginTop: 1 }} />
                <Text style={[s.infoText, { color: T.muted }]}>
                  {hist.data.last90Days.caveat}
                </Text>
              </View>
            </>
          ) : null}

          {!hist.data?.reminders.length ? (
            <EmptyState title="Nothing chased yet" icon={History}
              hint="Reminders you send appear here." />
          ) : (
            <Card>
              {hist.data.reminders.map((r) => (
                <View key={r.id} style={s.histRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.party}>{r.party}</Text>
                    <Text style={s.meta}>{ago(r.at)}{r.by ? ` · ${r.by}` : ''}</Text>
                  </View>
                  <Badge tone={r.status === 'skipped' ? 'warn' : 'ok'}>{r.status}</Badge>
                  <Text style={s.histAmount}>{money(r.amountPaise, { compact: true })}</Text>
                </View>
              ))}
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}

function Action({ Icon, label, onPress, primary, disabled }: {
  Icon: typeof Check; label: string; onPress: () => void;
  primary?: boolean; disabled?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled}
      style={[s.action, primary && s.actionPrimary, disabled && { opacity: 0.4 }]}>
      <Icon size={14} color={primary ? T.card : T.inkSoft} />
      <Text style={[s.actionText, primary && { color: T.card }]}>{label}</Text>
    </Pressable>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={s.statValue}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  chip: { paddingHorizontal: 16, paddingVertical: 9, borderRadius: 999, backgroundColor: T.lineSoft },
  chipOn: { backgroundColor: T.green },
  chipText: { fontFamily: T.font.semibold, fontSize: 13, color: T.inkSoft },
  chipTextOn: { color: T.card },
  info: {
    flexDirection: 'row', gap: 8, backgroundColor: T.greenSoft,
    borderRadius: T.radiusSm, padding: 11, marginBottom: 12,
  },
  infoText: { flex: 1, fontFamily: T.font.regular, fontSize: 11, color: T.greenDark, lineHeight: 16 },
  party: { fontFamily: T.font.bold, fontSize: 15, color: T.ink },
  meta: { fontFamily: T.font.regular, fontSize: 11, color: T.muted, marginTop: 2 },
  amount: { fontFamily: T.font.bold, fontSize: 16, color: T.ink },
  preview: {
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm, padding: 11, marginTop: 12,
  },
  previewText: { fontFamily: T.font.regular, fontSize: 12, color: T.inkSoft, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 7, marginTop: 12, flexWrap: 'wrap' },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm,
    paddingHorizontal: 11, paddingVertical: 9,
  },
  actionPrimary: { backgroundColor: T.green },
  actionText: { fontFamily: T.font.semibold, fontSize: 12, color: T.inkSoft },
  stat: {
    flexGrow: 1, flexBasis: '22%', backgroundColor: T.card,
    borderRadius: T.radiusSm, padding: 10, ...T.shadow,
  },
  statLabel: { fontFamily: T.font.medium, fontSize: 10, color: T.muted },
  statValue: { fontFamily: T.font.bold, fontSize: 16, color: T.ink, marginTop: 2 },
  histRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  histAmount: { fontFamily: T.font.semibold, fontSize: 13, color: T.ink },
});
