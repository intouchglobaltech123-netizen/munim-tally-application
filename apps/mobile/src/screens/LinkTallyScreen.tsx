import React, { useState } from 'react';
import {
  Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { post } from '../lib/api';
import { useApp } from '../lib/store';
import ScanSheet, { scanAvailable } from '../components/ScanSheet';
import { pairingCodeFrom } from '../lib/scanner';
import { Button, Card, Title, Muted } from '../components/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T } from '../theme';

/**
 * Linking a Tally computer by hand.
 *
 * The PC never handles the user's phone number or any credential. It shows a
 * short-lived pairing code; this app - already signed in - approves it, and the
 * device token travels back to the PC over its own polling channel.
 */
export default function LinkTallyScreen({ navigation }: any) {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [typed, setTyped] = useState('');
  const [scanning, setScanning] = useState(false);
  const insets = useSafeAreaInsets();

  async function approve(intentId: string) {
    setBusy(true);
    try {
      const r = await post<{ orgName: string }>('/v1/auth/intent/approve', {
        intentId,
        machineName: 'Tally PC',
        tallyVersion: 'prime',
        appVersion: '0.1.0',
      });
      setDone(true);
      await refresh();
      Alert.alert('Tally connected',
        `${r.orgName} is now linked. Your data will appear in about a minute.`,
        [{ text: 'Done', onPress: () => navigation.goBack() }]);
    } catch (e) {
      Alert.alert('Could not connect', (e as Error).message);
      setBusy(false);
    }
  }

  // Built as JSX, not a nested component: a component declared inside the
  // render function is a new type on every render, so React would remount the
  // TextInput on each keystroke and the keyboard would close.
  const manualId = extractIntentId(typed);
  const manualEntry = (
    <Card style={{ marginTop: 16 }}>
      <Text style={s.stepTitle}>Enter the code from your PC</Text>
      <Muted>Munim prints it on your Tally computer, like int_wbgwH5ak8mSX.</Muted>

      {/*
        * Offered only where the build can actually do it. A scan button that
        * explains it does not work is worse than no button: setup is exactly
        * the moment somebody decides whether this product is fiddly.
        */}
      {scanAvailable() ? (
        <View style={{ marginTop: 12 }}>
          <Button title="Scan the code instead" variant="ghost"
            onPress={() => setScanning(true)} disabled={busy || done} />
        </View>
      ) : null}
      <TextInput
        style={s.codeInput}
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        placeholder="int_..."
        placeholderTextColor="#9aa8a0"
        editable={!busy && !done}
        onSubmitEditing={() => manualId && approve(manualId)}
        returnKeyType="go"
      />
      {typed.trim() && !manualId ? (
        // A disabled button explains nothing. Say what is wrong with the text.
        <Text style={s.warn}>
          That does not look like a pairing code. It starts with “int_”, as
          printed by the connector.
        </Text>
      ) : null}
      <View style={{ marginTop: 12 }}>
        <Button
          title={busy ? 'Connecting…' : 'Link this computer'}
          onPress={() => manualId && approve(manualId)}
          disabled={!manualId || busy || done}
        />
      </View>
    </Card>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: T.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{
          padding: 20,
          paddingTop: insets.top + 14,
          paddingBottom: insets.bottom + 28,
        }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        <Title>Link your Tally computer</Title>
        <Muted>
          {busy
            ? 'Connecting…'
            : 'Almost always you do not need this screen — the setup file you '
              + 'download on the computer does everything. Use this only if '
              + 'support gave you a code.'}
        </Muted>
        {manualEntry}
        <Steps />
      </ScrollView>

      {/*
        * The scan fills the field rather than submitting straight away.
        *
        * A QR that pairs a computer the instant it is in frame is a QR somebody
        * can pair by accident while pointing the phone at their desk. Filling
        * the box leaves the deliberate step deliberate.
        */}
      <ScanSheet
        open={scanning}
        onClose={() => setScanning(false)}
        hint="Point at the code on your Tally computer"
        onScan={(value) => {
          setScanning(false);
          const code = pairingCodeFrom(value);
          if (code) setTyped(code);
          else Alert.alert('Not a Munim code',
            'That code is not one of ours. It should start with “int_”.');
        }}
      />
    </KeyboardAvoidingView>
  );
}

function Steps() {
  return (
    <Card style={{ marginTop: 16 }}>
      <Text style={s.stepTitle}>The easy way</Text>
      <Text style={s.step}>
        Open Munim on a computer, go to “Connect Tally” and download the setup
        file. Double-click it on the machine running Tally — nothing to type,
        and no code to enter here.
      </Text>
      <Text style={[s.stepTitle, { marginTop: 14 }]}>Or, by hand</Text>
      <Text style={s.step}>1. In Tally: F1 → Settings → Connectivity → Client/Server, set “Enable ODBC” to Yes, port 9000</Text>
      <Text style={s.step}>2. Keep Tally open, with your company loaded</Text>
      <Text style={s.step}>3. Run the Munim connector and choose “pair”</Text>
      <Text style={s.step}>4. Type the code it shows into the box above</Text>
    </Card>
  );
}

/**
 * Accepts a pairing link, and a bare code as typed by hand.
 *
 * The code is base64url, so it can contain "-" and "_". An earlier version of
 * this matched only [A-Za-z0-9] and silently rejected about two codes in five -
 * the button just stayed disabled, with nothing to explain why.
 */
export function extractIntentId(raw: string): string | null {
  const s = (raw ?? '').trim();
  const m = s.match(/\/p\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^int_[A-Za-z0-9_-]+$/.test(s)) return s;
  return null;
}

const s = StyleSheet.create({
  wrap: { padding: 20, backgroundColor: T.bg, flexGrow: 1 },
  body: { color: T.ink, lineHeight: 21 },
  stepTitle: { fontFamily: T.font.bold, color: T.ink, marginBottom: 8 },
  step: { color: T.muted, marginTop: 4, lineHeight: 20 },
  warn: { marginTop: 10, color: '#8c1d18', backgroundColor: T.redSoft,
          padding: 10, borderRadius: 10, fontSize: 13 },
  codeInput: { borderWidth: 1.5, borderColor: T.line, borderRadius: 12, marginTop: 12,
               paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, color: T.ink },
});
