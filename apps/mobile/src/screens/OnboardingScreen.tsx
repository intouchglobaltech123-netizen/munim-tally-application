import React, { useState } from 'react';
import {
  KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { post } from '../lib/api';
import { useApp } from '../lib/store';
import { Button } from '../components/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T } from '../theme';

/**
 * Naming the business IS creating the company. Everything else - the Tally
 * link, the books, the reminders - hangs off this record, which is why it is
 * asked first and why nothing else is reachable until it is answered.
 */
export default function OnboardingScreen() {
  const insets = useSafeAreaInsets();
  const { me, refresh } = useApp();
  const [businessName, setBusinessName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setErr(null); setBusy(true);
    try {
      await post('/v1/onboarding', { businessName, ownerName });
      await refresh();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: T.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[s.wrap, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <Text style={s.h1}>What is your business called?</Text>
        <Text style={s.lede}>
          This is the name on your dashboard, and the name your customers see on
          payment reminders.
        </Text>

        <Text style={s.label}>Business name</Text>
        <TextInput
          style={s.input} autoFocus maxLength={80} value={businessName}
          placeholder="Your shop or company name" placeholderTextColor="#9aa8a0"
          onChangeText={setBusinessName}
        />

        <Text style={[s.label, { marginTop: 18 }]}>
          Your name <Text style={{ color: T.muted, fontFamily: T.font.regular }}>(optional)</Text>
        </Text>
        <TextInput
          style={s.input} maxLength={60} value={ownerName}
          placeholder="Ramesh" placeholderTextColor="#9aa8a0"
          onChangeText={setOwnerName}
        />

        {err ? <Text style={s.err}>{err}</Text> : null}

        <View style={{ marginTop: 24 }}>
          <Button title={busy ? 'Creating…' : 'Create my business'}
            onPress={create} disabled={busy || businessName.trim().length < 2} />
        </View>

        <Text style={s.foot}>
          Signed in as {me?.user.phone}. Next you will link the computer that runs Tally.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  h1: { fontSize: 24, fontFamily: T.font.bold, color: T.ink, letterSpacing: -0.3 },
  lede: { color: T.muted, marginTop: 8, marginBottom: 26, lineHeight: 20 },
  label: { fontSize: 13, fontFamily: T.font.bold, color: T.ink, marginBottom: 8 },
  input: {
    backgroundColor: '#fff', borderWidth: 1.5, borderColor: T.line,
    borderRadius: 12, paddingHorizontal: 14, minHeight: T.tap,
    fontSize: 16, color: T.ink,
  },
  err: { marginTop: 16, backgroundColor: T.redSoft, color: '#8c1d18',
         padding: 10, borderRadius: 10, fontSize: 13 },
  foot: { color: T.muted, fontSize: 12, marginTop: 20, lineHeight: 18 },
});
