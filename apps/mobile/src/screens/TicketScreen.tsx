import React, { useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApi } from '../lib/store';
import { post, type TicketDetail } from '../lib/api';
import { ago } from '../lib/format';
import { Badge, Button, Card, ErrorNote, Loading, OfflineBar, Screen } from '../components/ui';
import { T } from '../theme';

/** One ticket, as a conversation. */
export default function TicketScreen({ route }: any) {
  const id = route?.params?.id;
  const { data, error, loading, reload, stale, offline } =
    useApi<TicketDetail>(id ? `/v1/tickets/${id}` : null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  if (error) return <View style={s.wrap}><ErrorNote message={error} onRetry={reload} /></View>;
  if (!data) return <Loading />;

  const closed = ['resolved', 'closed'].includes(data.ticket.status);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try { await fn(); await reload(); }
    catch (e) { Alert.alert('Could not do that', (e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Screen
      onRefresh={reload}
      refreshing={loading}
      header={
        <View>
          <OfflineBar offline={offline} ageMs={stale} />
          <Text style={s.subject}>{data.ticket.subject}</Text>
          <View style={s.metaRow}>
            <Text style={s.meta}>#{data.ticket.number} · {data.ticket.category}</Text>
            <Badge tone={closed ? 'muted' : 'ok'}>{data.ticket.statusLabel}</Badge>
          </View>
        </View>
      }
    >
      {data.messages.map((m) => (
        <Card key={m.id}
          style={{ marginTop: 10, ...(m.from_staff ? s.fromUs : {}) }}>
          <View style={s.msgHead}>
            <Text style={s.author}>{m.from_staff ? 'Munim' : m.author || 'You'}</Text>
            <Text style={s.when}>{ago(m.at)}</Text>
          </View>
          <Text style={s.body}>{m.body}</Text>
        </Card>
      ))}

      {!closed ? (
        <Card style={{ marginTop: 16, marginBottom: 12 }}>
          <TextInput value={body} onChangeText={setBody} multiline
            placeholder="Add to this ticket…" placeholderTextColor={T.faint}
            style={s.input} />
          <View style={{ marginTop: 10, flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button title="Reply" disabled={busy || !body}
                onPress={() => act(async () => {
                  await post(`/v1/tickets/${id}/reply`, { body });
                  setBody('');
                })} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Close" variant="ghost" disabled={busy}
                onPress={() => act(() =>
                  post(`/v1/tickets/${id}/status`, { status: 'closed' }))} />
            </View>
          </View>
        </Card>
      ) : (
        <Card style={{ marginTop: 16, marginBottom: 12 }}>
          <Text style={s.body}>
            {data.ticket.rating
              ? `You rated this ${data.ticket.rating} out of 5. Thank you.`
              : 'This ticket is closed.'}
          </Text>
          <View style={{ marginTop: 10 }}>
            <Button title="Reopen" variant="ghost" disabled={busy}
              onPress={() => act(() =>
                post(`/v1/tickets/${id}/status`, { status: 'open' }))} />
          </View>
        </Card>
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, padding: 16, backgroundColor: T.bg },
  subject: { fontSize: 20, fontWeight: '800', color: T.ink },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  meta: { flex: 1, fontSize: 12, color: T.muted },
  fromUs: { borderColor: T.green, borderWidth: 1 },
  msgHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  author: { flex: 1, fontSize: 13, fontWeight: '700', color: T.ink },
  when: { fontSize: 11, color: T.faint },
  body: { fontSize: 13, color: T.muted, marginTop: 6, lineHeight: 19 },
  input: { borderWidth: 1, borderColor: T.line, borderRadius: 10, paddingHorizontal: 12,
           paddingVertical: 10, fontSize: 14, color: T.ink, height: 90,
           textAlignVertical: 'top' },
});
