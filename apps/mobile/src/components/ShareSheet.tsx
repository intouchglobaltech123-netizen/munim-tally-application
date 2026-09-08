import React, { useState } from 'react';
import {
  Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  Share2, MessageCircle, Mail, Copy, X, Check, AlertTriangle,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../lib/store';
import { get, post } from '../lib/api';
import { shareOnWhatsApp, shareByEmail, shareText } from '../lib/share';
import { T } from '../theme';

/**
 * One share control, used everywhere on the phone.
 *
 * The message comes from the server so a statement reads identically wherever
 * it was sent from — and identically to the web. Composing it per screen is
 * how three slightly different statements reach the same customer.
 */

type Preview = {
  kind: string; subject: string; recipient: string; email: string;
  message: string; variables: Record<string, string>;
};

export default function ShareSheet({ kind, subject, label = 'Share', extra }: {
  kind: 'statement' | 'outstanding' | 'invoice' | 'voucher' | 'item' | 'report';
  subject: string;
  label?: string;
  extra?: { period?: string; lines?: string[] };
}) {
  const { company } = useApp();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Preview | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function load() {
    if (!company) return;
    setOpen(true); setBusy(true); setErr(null); setDone(false);
    try {
      const qs = new URLSearchParams({ kind, subject });
      if (extra?.period) qs.set('period', extra.period);
      for (const l of extra?.lines ?? []) qs.append('line', l);
      const d = await get<Preview>(
        `/v1/companies/${encodeURIComponent(company.tallyGuid)}/share?${qs}`);
      setData(d);
      setText(d.message);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not build that message.');
    } finally {
      setBusy(false);
    }
  }

  async function record(status: string, channel: string) {
    if (!company || !data) return;
    setDone(true);
    try {
      await post(`/v1/companies/${encodeURIComponent(company.tallyGuid)}/share/record`, {
        kind, subject: data.subject, channel, recipient: data.recipient,
        status, message: text,
      });
    } catch { /* the message still went; the log entry can wait */ }
  }

  return (
    <>
      <Pressable onPress={load} style={s.trigger}>
        <Share2 size={15} color={T.card} />
        <Text style={s.triggerText}>{label}</Text>
      </Pressable>

      <Modal visible={open} animationType="slide" transparent
        onRequestClose={() => setOpen(false)}>
        <View style={s.backdrop}>
          <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={s.head}>
              <View style={{ flex: 1 }}>
                <Text style={s.title}>Share {kind}</Text>
                {data ? <Text style={s.sub}>{data.subject}</Text> : null}
              </View>
              <Pressable onPress={() => setOpen(false)} hitSlop={12}>
                <X size={20} color={T.muted} />
              </Pressable>
            </View>

            {busy ? <Text style={s.sub}>Building the message…</Text> : null}
            {err ? <Text style={[s.sub, { color: T.negative }]}>{err}</Text> : null}

            {data && !busy ? (
              <>
                {/* Editable: the owner knows their customer, and a message they
                    cannot adjust is one they retype in WhatsApp anyway. */}
                <ScrollView style={{ maxHeight: 260 }}>
                  <TextInput value={text} onChangeText={setText} multiline
                    style={s.input} textAlignVertical="top" />
                </ScrollView>

                {!data.recipient && kind !== 'report' && kind !== 'item' ? (
                  <View style={s.warn}>
                    <AlertTriangle size={13} color={T.warn} style={{ marginTop: 1 }} />
                    <Text style={s.warnText}>
                      No phone number for this party in Tally. WhatsApp will ask who to send to.
                    </Text>
                  </View>
                ) : null}

                <View style={s.actions}>
                  <Action Icon={MessageCircle} label="WhatsApp" primary
                    onPress={() => {
                      shareOnWhatsApp(text, data.recipient);
                      record('handed-off', 'whatsapp');
                    }} />
                  <Action Icon={Mail} label="Email"
                    onPress={() => {
                      shareByEmail(`${data.subject} — from Munim`, text, data.email);
                      record('handed-off', 'email');
                    }} />
                  <Action Icon={Copy} label="More"
                    onPress={() => {
                      shareText(data.subject, text);
                      record('handed-off', 'share');
                    }} />
                </View>

                {done ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 10 }}>
                    <Check size={13} color={T.positive} />
                    <Text style={[s.foot, { color: T.positive }]}>Recorded</Text>
                  </View>
                ) : null}

                <Text style={s.foot}>
                  Munim does not send this. Your own WhatsApp does, so it comes
                  from your number.
                </Text>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

function Action({ Icon, label, onPress, primary }: {
  Icon: typeof Copy; label: string; onPress: () => void; primary?: boolean;
}) {
  return (
    <Pressable onPress={onPress} style={[s.action, primary && s.actionPrimary]}>
      <Icon size={15} color={primary ? T.card : T.inkSoft} />
      <Text style={[s.actionText, primary && { color: T.card }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  trigger: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: T.green, borderRadius: T.radiusSm,
    paddingHorizontal: 13, paddingVertical: 10,
  },
  triggerText: { fontFamily: T.font.semibold, fontSize: 13, color: T.card },
  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: T.card, borderTopLeftRadius: T.radiusLg,
    borderTopRightRadius: T.radiusLg, padding: 18,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12 },
  title: { fontFamily: T.font.bold, fontSize: 17, color: T.ink, textTransform: 'capitalize' },
  sub: { fontFamily: T.font.regular, fontSize: 12, color: T.muted, marginTop: 2 },
  input: {
    borderWidth: 1, borderColor: T.line, borderRadius: T.radiusSm,
    padding: 12, fontFamily: T.font.regular, fontSize: 13,
    color: T.ink, lineHeight: 19, minHeight: 160,
  },
  warn: {
    flexDirection: 'row', gap: 8, backgroundColor: T.warnSoft,
    borderRadius: T.radiusSm, padding: 10, marginTop: 10,
  },
  warnText: { flex: 1, fontFamily: T.font.regular, fontSize: 11, color: T.warn, lineHeight: 16 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14 },
  action: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm, paddingVertical: 12,
  },
  actionPrimary: { backgroundColor: T.green },
  actionText: { fontFamily: T.font.semibold, fontSize: 13, color: T.inkSoft },
  foot: {
    fontFamily: T.font.regular, fontSize: 11, color: T.muted,
    marginTop: 12, lineHeight: 16,
  },
});
