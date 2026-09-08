import React, { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApp, useApi } from '../lib/store';
import { post, patch, type EntryOptions, type Draft, type DraftList } from '../lib/api';
import { inr, shortDate } from '../lib/format';
import {
  Badge, Button, Card, Empty, ErrorNote, Label, Loading, Muted, OfflineBar, Screen,
} from '../components/ui';
import { T } from '../theme';
import { AlertTriangle, Info, Lock, Plus, Send, X } from 'lucide-react-native';

/**
 * Creating a voucher from the counter.
 *
 * This is the reason to have it on a phone at all: the person who knows what
 * just sold is standing at the till, not at the computer running Tally. The
 * screen is deliberately the same shape as the web one - kind, date, party,
 * ledger lines, balance - because somebody who learns it on one should not have
 * to learn it again on the other.
 *
 * Saving and sending stay separate here too. A phone in a pocket is exactly
 * where an accidental tap happens, and a draft is harmless where a posted
 * voucher is not.
 */
type Line = { ledger: string; amountPaise: number };
const emptyLine = (): Line => ({ ledger: '', amountPaise: 0 });

export default function EntryScreen() {
  const { company } = useApp();
  const guid = company?.tallyGuid;
  const base = guid ? `/v1/companies/${encodeURIComponent(guid)}` : null;

  const opts = useApi<EntryOptions>(base ? `${base}/entry-options` : null);
  const list = useApi<DraftList>(base ? `${base}/entries` : null);

  const [kind, setKind] = useState('sales');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [party, setParty] = useState('');
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [editing, setEditing] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const { debit, difference } = useMemo(() => {
    let d = 0; let c = 0;
    for (const l of lines) {
      const p = Math.round(Number(l.amountPaise) || 0);
      if (p > 0) d += p; else c += -p;
    }
    return { debit: d, difference: d - c };
  }, [lines]);

  if (!guid) {
    return (
      <View style={s.wrap}>
        <Empty title="No company yet"
          hint="Connect the computer running Tally before creating entries." />
      </View>
    );
  }
  if (opts.error) {
    return <View style={s.wrap}><ErrorNote message={opts.error} onRetry={opts.reload} /></View>;
  }
  if (!opts.data) return <Loading label="Loading your ledgers…" />;
  const o = opts.data;

  function reset() {
    setLines([emptyLine(), emptyLine()]);
    setParty(''); setNarration(''); setEditing(null); setProblems([]);
  }

  function loadDraft(d: Draft) {
    setEditing(d.id);
    setKind(d.kind);
    setDate(d.date.slice(0, 10));
    setParty(d.party);
    setNarration(d.narration);
    setLines(d.entries.length ? d.entries : [emptyLine(), emptyLine()]);
    setProblems([]);
  }

  async function save() {
    setBusy('save');
    try {
      const payload = {
        kind, date, party, narration,
        entries: lines.filter((l) => l.ledger && l.amountPaise),
      };
      const r = editing
        ? await patch<{ draft: Draft; problems: string[] }>(`/v1/entries/${editing}`, payload)
        : await post<{ draft: Draft; problems: string[] }>(`${base}/entries`, payload);
      setProblems(r.problems);
      setEditing(r.draft.id);
      if (!r.problems.length) {
        Alert.alert('Saved',
          'Nothing has gone to Tally yet. Press Send when you are ready.');
      }
      await list.reload();
    } catch (e) {
      Alert.alert('Could not save', (e as Error).message);
    } finally { setBusy(null); }
  }

  async function sendIt(id: string) {
    setBusy('send');
    try {
      const r = await post<{ message: string }>(`/v1/entries/${id}/send`, {});
      Alert.alert('Sent', r.message);
      reset();
      await list.reload();
    } catch (e) {
      Alert.alert('Could not send', (e as Error).message);
    } finally { setBusy(null); }
  }

  return (
    <Screen
      onRefresh={list.reload}
      refreshing={list.loading}
      header={
        <View>
          <OfflineBar offline={opts.offline} ageMs={opts.stale} />
          <Text style={s.headName}>New entry</Text>
          <Text style={s.headSub}>{company?.name}</Text>
        </View>
      }
    >
      {!o.writesEnabled ? (
        <Card style={{ ...s.warn, marginTop: 14 }}>
          <View style={s.warnRow}>
            <Lock size={15} strokeWidth={2.2} color="#b45309" />
            <Text style={s.warnText}>
              Writing to Tally is switched off for this business. You can draft
              entries but not send them — an owner can turn it on from the web.
            </Text>
          </View>
        </Card>
      ) : null}

      <View style={{ marginTop: 16 }}><Label>What kind</Label></View>
      <View style={s.chips}>
        {o.kinds.map((k) => (
          <Pressable key={k.key} onPress={() => { setKind(k.key); setProblems([]); }}
            style={[s.chip, kind === k.key && s.chipOn]}>
            <Text style={[s.chipText, kind === k.key && s.chipTextOn]}>{k.label}</Text>
          </Pressable>
        ))}
      </View>

      <Card style={{ marginTop: 14 }}>
        <Label>Date</Label>
        <TextInput value={date} onChangeText={setDate} placeholder="YYYY-MM-DD"
          placeholderTextColor={T.faint} style={s.input} autoCapitalize="none" />

        <View style={{ marginTop: 12 }}><Label>Party</Label></View>
        <TextInput value={party} onChangeText={setParty}
          placeholder="Name exactly as it is in Tally"
          placeholderTextColor={T.faint} style={s.input} />

        <View style={{ marginTop: 12 }}><Label>Narration</Label></View>
        <TextInput value={narration} onChangeText={setNarration}
          placeholder="What this is for" placeholderTextColor={T.faint} style={s.input} />
      </Card>

      <View style={{ marginTop: 18 }}><Label>Ledger lines</Label></View>
      {lines.map((l, i) => (
        <Card key={i} style={{ marginTop: 8 }}>
          <View style={s.lineTop}>
            <TextInput value={l.ledger}
              onChangeText={(v) => {
                const next = [...lines];
                next[i] = { ...next[i], ledger: v };
                setLines(next);
              }}
              placeholder="Ledger name" placeholderTextColor={T.faint}
              style={[s.input, { flex: 1, marginTop: 0 }]} />
            <Pressable onPress={() => setLines(lines.filter((_, j) => j !== i))}
              disabled={lines.length <= 2} hitSlop={8}
              style={{ padding: 6, opacity: lines.length <= 2 ? 0.25 : 1 }}>
              <X size={16} strokeWidth={2.2} color={T.muted} />
            </Pressable>
          </View>

          <View style={s.lineBottom}>
            <Pressable
              onPress={() => {
                const next = [...lines];
                next[i] = { ...next[i], amountPaise: -next[i].amountPaise };
                setLines(next);
              }}
              style={[s.side, l.amountPaise < 0 && s.sideCredit]}>
              <Text style={[s.sideText, l.amountPaise < 0 && s.sideTextCredit]}>
                {l.amountPaise < 0 ? 'Credit' : 'Debit'}
              </Text>
            </Pressable>

            <TextInput
              value={l.amountPaise ? String(Math.abs(l.amountPaise) / 100) : ''}
              onChangeText={(v) => {
                const next = [...lines];
                const mag = Math.round(Number(v || 0) * 100);
                next[i] = { ...next[i],
                  amountPaise: next[i].amountPaise < 0 ? -mag : mag };
                setLines(next);
              }}
              keyboardType="decimal-pad" placeholder="0.00"
              placeholderTextColor={T.faint}
              style={[s.input, { flex: 1, marginTop: 0, textAlign: 'right' }]} />
          </View>
        </Card>
      ))}

      <View style={{ marginTop: 10 }}>
        <Button title="Add a line" variant="ghost"
          onPress={() => setLines([...lines, emptyLine()])} />
      </View>

      {/*
        * The balance, live. Debits are positive throughout, so a balanced
        * voucher sums to zero — and finding out otherwise after pressing Send
        * means finding out from a machine in another room.
        */}
      <Card style={{ ...(difference === 0 && debit > 0 ? s.balanced : s.unbalanced),
                     marginTop: 12 }}>
        <Text style={[s.balanceText,
          { color: difference === 0 && debit > 0 ? '#065f46' : '#78350f' }]}>
          {debit === 0 && difference === 0 ? 'Nothing entered yet'
            : difference === 0 ? `Balanced — ${inr(debit)}`
            : `Out by ${inr(Math.abs(difference))}`}
        </Text>
      </Card>

      {problems.length > 0 ? (
        <Card style={{ ...s.warn, marginTop: 12 }}>
          <View style={s.warnRow}>
            <AlertTriangle size={15} strokeWidth={2.2} color="#b45309" />
            <View style={{ flex: 1 }}>
              {problems.map((p) => <Text key={p} style={s.warnText}>• {p}</Text>)}
            </View>
          </View>
        </Card>
      ) : null}

      <View style={{ marginTop: 14, flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button title={busy === 'save' ? 'Saving…' : editing ? 'Save changes' : 'Save draft'}
            variant="ghost" onPress={save} disabled={busy === 'save'} />
        </View>
        <View style={{ flex: 1 }}>
          <Button title={busy === 'send' ? 'Sending…' : 'Send to Tally'}
            onPress={() => editing && sendIt(editing)}
            disabled={busy === 'send' || !editing || problems.length > 0
                      || !o.writesEnabled} />
        </View>
      </View>
      {!editing ? (
        <View style={{ marginTop: 8 }}>
          <Muted>Save it first — sending is a separate step on purpose.</Muted>
        </View>
      ) : null}

      <View style={{ marginTop: 22 }}><Label>Entries</Label></View>
      {!list.data?.drafts.length ? (
        <Card style={{ marginTop: 8 }}><Muted>Nothing yet.</Muted></Card>
      ) : list.data.drafts.slice(0, 20).map((d) => (
        <Pressable key={d.id} onPress={() => d.editable && loadDraft(d)}>
          <Card style={{ marginTop: 8 }}>
            <View style={s.draftRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.draftTitle} numberOfLines={1}>
                  {d.kindLabel}{d.party ? ` — ${d.party}` : ''}
                </Text>
                <Text style={s.draftSub}>
                  {shortDate(d.date)} · {inr(d.amountPaise)}
                  {d.tallyNumber ? ` · Tally #${d.tallyNumber}` : ''}
                </Text>
                {d.error ? <Text style={s.draftErr}>{d.error}</Text> : null}
              </View>
              <Badge tone={d.status === 'posted' ? 'ok'
                : d.status === 'rejected' ? 'bad'
                : d.status === 'cancelled' ? 'muted' : 'warn'}>
                {d.statusLabel}
              </Badge>
            </View>
          </Card>
        </Pressable>
      ))}

      <View style={s.note}>
        <Info size={12} strokeWidth={2.2} color={T.faint} />
        <Text style={s.noteText}>{o.note}</Text>
      </View>
    </Screen>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 16, backgroundColor: T.bg },
  headName: { fontSize: 24, fontWeight: '800', color: T.ink },
  headSub: { fontSize: 13, color: T.muted, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  chip: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999,
          borderWidth: 1, borderColor: T.line },
  chipOn: { backgroundColor: T.green, borderColor: T.green },
  chipText: { fontSize: 12, fontWeight: '600', color: T.muted },
  chipTextOn: { color: '#fff' },
  input: { marginTop: 6, borderWidth: 1, borderColor: T.line, borderRadius: 10,
           paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: T.ink },
  lineTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lineBottom: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  side: { paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10,
          borderWidth: 1, borderColor: T.line, minWidth: 78, alignItems: 'center' },
  sideCredit: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  sideText: { fontSize: 12, fontWeight: '700', color: T.ink },
  sideTextCredit: { color: '#b91c1c' },
  balanced: { backgroundColor: '#ecfdf5', borderColor: '#a7f3d0', borderWidth: 1 },
  unbalanced: { backgroundColor: '#fffbeb', borderColor: '#fde68a', borderWidth: 1 },
  balanceText: { fontSize: 14, fontWeight: '700', textAlign: 'center' },
  warn: { backgroundColor: '#fffbeb', borderColor: '#fde68a', borderWidth: 1 },
  warnRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  warnText: { flex: 1, fontSize: 12, color: '#78350f', lineHeight: 18 },
  draftRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  draftTitle: { fontSize: 14, fontWeight: '600', color: T.ink },
  draftSub: { fontSize: 11, color: T.faint, marginTop: 2 },
  draftErr: { fontSize: 11, color: '#b91c1c', marginTop: 3 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 18,
          marginBottom: 12, backgroundColor: T.bg, borderRadius: 8, padding: 8 },
  noteText: { flex: 1, fontSize: 11, color: T.faint, lineHeight: 16 },
});
