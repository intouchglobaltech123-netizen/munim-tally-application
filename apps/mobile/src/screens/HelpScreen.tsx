import React, { useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApi } from '../lib/store';
import { post, type HelpPayload, type TicketRow } from '../lib/api';
import { ago } from '../lib/format';
import {
  Badge, Button, Card, ErrorNote, Label, Loading, Muted, OfflineBar, Screen,
} from '../components/ui';
import { T } from '../theme';
import {
  AlertTriangle, ChevronDown, ChevronRight, LifeBuoy, Mail, Stethoscope,
} from 'lucide-react-native';

/**
 * Help, from the shop floor.
 *
 * This is the screen that matters most on a phone: the person standing in front
 * of the Tally computer at 8pm is exactly the person who needs help, and they
 * are not going back to a desk to ask for it.
 *
 * Diagnosis first, then the form. Most problems here have one of about six
 * causes, and telling somebody "that computer has not reported for two hours"
 * often means no ticket at all.
 */
export default function HelpScreen({ navigation }: any) {
  const h = useApi<HelpPayload>('/v1/help');
  const t = useApi<{ tickets: TicketRow[]; open: number }>('/v1/tickets');

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState('other');
  const [priority, setPriority] = useState('normal');
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  if (h.error) return <View style={s.wrap}><ErrorNote message={h.error} onRetry={h.reload} /></View>;
  if (!h.data) return <Loading label="Checking how things look…" />;
  const d = h.data;

  async function raise() {
    setBusy(true);
    try {
      const r = await post<{ message: string }>('/v1/tickets',
        { subject, body, category, priority });
      Alert.alert('Sent', r.message);
      setSubject(''); setBody('');
      await t.reload();
    } catch (e) {
      Alert.alert('Could not send', (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Screen
      onRefresh={h.reload}
      refreshing={h.loading}
      header={
        <View>
          <OfflineBar offline={h.offline} ageMs={h.stale} />
          <Text style={s.headName}>Help</Text>
          <Text style={s.headSub}>
            We reply within {d.responseHours[priority]} working hours on {d.planLabel}
          </Text>
        </View>
      }
    >
      {/* What we can already see is wrong, before anybody types. */}
      {d.suggestions.map((sg) => (
        <Card key={sg.title} style={{ ...s.warn, marginTop: 14 }}>
          <View style={s.warnHead}>
            <AlertTriangle size={16} strokeWidth={2.2} color="#b45309" />
            <Text style={s.warnTitle}>{sg.title}</Text>
          </View>
          <Text style={s.warnBody}>{sg.detail}</Text>
        </Card>
      ))}

      {(t.data?.tickets.length ?? 0) > 0 ? (
        <>
          <View style={{ marginTop: 20 }}><Label>Your tickets</Label></View>
          {t.data!.tickets.slice(0, 10).map((x) => (
            <Pressable key={x.id} onPress={() => navigation.navigate('Ticket', { id: x.id })}>
              <Card style={{ marginTop: 8 }}>
                <View style={s.ticketRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.ticketSubject} numberOfLines={1}>
                      #{x.number} {x.subject}
                    </Text>
                    <Text style={s.ticketMeta}>
                      {x.messages} message{x.messages === 1 ? '' : 's'}
                      {x.lastAt ? ` · ${ago(x.lastAt)}` : ''}
                    </Text>
                  </View>
                  <Badge tone={
                    x.status === 'waiting_on_you' ? 'bad'
                      : ['resolved', 'closed'].includes(x.status) ? 'muted' : 'ok'}>
                    {x.statusLabel}
                  </Badge>
                  <ChevronRight size={15} strokeWidth={2.2} color={T.faint} />
                </View>
              </Card>
            </Pressable>
          ))}
        </>
      ) : null}

      <View style={{ marginTop: 20 }}><Label>Ask us</Label></View>
      <Card style={{ marginTop: 10 }}>
        <Text style={s.fieldLabel}>What is it about</Text>
        <View style={s.chips}>
          {d.categories.map((c) => (
            <Pressable key={c.key} onPress={() => setCategory(c.key)}
              style={[s.chip, category === c.key && s.chipOn]}>
              <Text style={[s.chipText, category === c.key && s.chipTextOn]}>
                {c.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={[s.fieldLabel, { marginTop: 14 }]}>How urgent</Text>
        <View style={s.chips}>
          {d.priorities.map((pr) => (
            <Pressable key={pr.key} onPress={() => setPriority(pr.key)}
              style={[s.chip, priority === pr.key && s.chipOn]}>
              <Text style={[s.chipText, priority === pr.key && s.chipTextOn]}>
                {pr.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <TextInput value={subject} onChangeText={setSubject}
          placeholder="One line: what is wrong?" placeholderTextColor={T.faint}
          style={s.input} />
        <TextInput value={body} onChangeText={setBody} multiline numberOfLines={4}
          placeholder="What you did, and what happened instead."
          placeholderTextColor={T.faint}
          style={[s.input, { height: 96, textAlignVertical: 'top' }]} />

        <View style={s.attachNote}>
          <Stethoscope size={12} strokeWidth={2.2} color={T.faint} />
          <Text style={s.attachText}>
            Your connector, Tally version and last sync go with it automatically.
          </Text>
        </View>

        <View style={{ marginTop: 12 }}>
          <Button title={busy ? 'Sending…' : 'Send'} onPress={raise}
            disabled={busy || !subject || !body} />
        </View>
      </Card>

      <View style={{ marginTop: 20 }}><Label>Common questions</Label></View>
      {d.faq.map((f, i) => (
        <Card key={f.q} style={{ marginTop: 8 }}>
          <Pressable onPress={() => setOpenFaq(openFaq === i ? null : i)} style={s.faqHead}>
            {openFaq === i
              ? <ChevronDown size={15} strokeWidth={2.2} color={T.faint} />
              : <ChevronRight size={15} strokeWidth={2.2} color={T.faint} />}
            <Text style={s.faqQ}>{f.q}</Text>
          </Pressable>
          {openFaq === i ? <Text style={s.faqA}>{f.a}</Text> : null}
        </Card>
      ))}

      <Card style={{ marginTop: 20, marginBottom: 12 }}>
        <Pressable onPress={() => Linking.openURL(`mailto:${d.contact.email}`)}
          style={s.contactRow}>
          <Mail size={15} strokeWidth={2.2} color={T.muted} />
          <Text style={s.contactText}>{d.contact.email}</Text>
        </Pressable>
        <Text style={s.contactHours}>{d.contact.hours}</Text>
        <Text style={s.contactHours}>{d.contact.phoneNote}</Text>
      </Card>
    </Screen>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 16, backgroundColor: T.bg },
  headName: { fontSize: 24, fontWeight: '800', color: T.ink },
  headSub: { fontSize: 13, color: T.muted, marginTop: 2 },
  warn: { backgroundColor: '#fffbeb', borderColor: '#fde68a', borderWidth: 1 },
  warnHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  warnTitle: { flex: 1, fontSize: 14, fontWeight: '700', color: '#78350f' },
  warnBody: { fontSize: 12, color: '#92400e', marginTop: 6, lineHeight: 18 },
  ticketRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ticketSubject: { fontSize: 14, fontWeight: '600', color: T.ink },
  ticketMeta: { fontSize: 11, color: T.faint, marginTop: 2 },
  fieldLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.6,
                textTransform: 'uppercase', color: T.muted, marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
          borderWidth: 1, borderColor: T.line },
  chipOn: { backgroundColor: T.ink, borderColor: T.ink },
  chipText: { fontSize: 11, fontWeight: '600', color: T.muted },
  chipTextOn: { color: '#fff' },
  input: { marginTop: 12, borderWidth: 1, borderColor: T.line, borderRadius: 10,
           paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: T.ink },
  attachNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 10 },
  attachText: { flex: 1, fontSize: 11, color: T.faint, lineHeight: 16 },
  faqHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  faqQ: { flex: 1, fontSize: 13, fontWeight: '600', color: T.ink },
  faqA: { fontSize: 12, color: T.muted, marginTop: 8, marginLeft: 23, lineHeight: 18 },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  contactText: { fontSize: 14, color: T.ink },
  contactHours: { fontSize: 12, color: T.muted, marginTop: 6 },
});
