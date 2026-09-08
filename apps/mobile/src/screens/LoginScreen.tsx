import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { get, post, type AuthConfig, type Session } from '../lib/api';
import { useApp } from '../lib/store';
import { Button } from '../components/ui';
import { signInWithGoogle, GoogleSignInError } from '../lib/google';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T } from '../theme';

/**
 * Sign in with Google. That is the whole screen.
 *
 * There is no OTP here on purpose. Every SMS is billed per message, with no
 * free allowance, and it buys nothing an email address does not already give
 * us: Google Sign-In is free to 50,000 monthly active users, and a Google
 * account outlives any SIM card - which is exactly the case that used to leave
 * someone locked out of their own books.
 *
 * Google only ever proves "this person controls this email address". Our API
 * verifies the token against Google's certificates and issues its own session,
 * so every route, role check and tenant guard is unchanged.
 */
export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { signIn } = useApp();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The server decides what sign-in is live, so the app never has to be
  // rebuilt to change it.
  useEffect(() => {
    get<AuthConfig>('/v1/auth/config')
      .then(setCfg)
      .catch((e) => setErr((e as Error).message));
  }, []);

  async function google() {
    if (!cfg?.google) return;
    setErr(null); setBusy(true);
    try {
      // The Android client, never the web one: Google refuses a Web client
      // from a handset outright, with a policy error that explains nothing.
      const idToken = await signInWithGoogle(cfg.google.android);
      const s = await post<Session>('/v1/auth/google', { idToken });
      await signIn(s.access);
    } catch (e) {
      // Backing out of the Google screen is not an error worth shouting about.
      if (e instanceof GoogleSignInError && /cancelled/i.test(e.message)) setErr(null);
      else setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <ScrollView style={{ backgroundColor: T.green }} contentContainerStyle={[s.wrap, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <View style={s.brand}>
        <View style={s.mark}><Text style={s.markText}>M</Text></View>
        <Text style={s.brandText}>Munim</Text>
      </View>
      <Text style={s.tagline}>Tally on your mobile</Text>

      <View style={s.card}>
        {!cfg ? (
          <Text style={s.muted}>Connecting…</Text>
        ) : cfg.google ? (
          <>
            <Text style={s.heading}>Sign in</Text>
            <Text style={s.muted}>
              Use the Google account you want your books under. New here? An
              account is created for you.
            </Text>
            <View style={{ marginTop: 20 }}>
              <Button
                title={busy ? 'Signing in…' : 'Continue with Google'}
                onPress={google}
                disabled={busy}
              />
            </View>
          </>
        ) : (
          /* Failing here, visibly, beats a button that always errors. */
          <>
            <Text style={s.heading}>Sign-in is not set up yet</Text>
            <Text style={s.muted}>
              This server has no Google client configured, so there is no way to
              sign in. Set GOOGLE_CLIENT_IDS in apps/api/.env and restart it.
            </Text>
          </>
        )}
        {err ? <Text style={s.err}>{err}</Text> : null}
      </View>

      <Text style={s.foot}>
        Munim reads your Tally data. The only thing it ever writes is a voucher
        you create here and send, and never without an owner switching that on.
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10, justifyContent: 'center' },
  mark: { width: 38, height: 38, borderRadius: 10, backgroundColor: '#fff',
          alignItems: 'center', justifyContent: 'center' },
  markText: { color: T.green, fontFamily: T.font.bold, fontSize: 20 },
  brandText: { color: '#fff', fontSize: 26, fontFamily: T.font.bold },
  tagline: { color: 'rgba(255,255,255,0.85)', textAlign: 'center',
             marginTop: 6, marginBottom: 28 },
  card: { backgroundColor: '#fff', borderRadius: 18, padding: 22 },
  heading: { fontSize: 18, fontFamily: T.font.bold, color: T.ink, marginBottom: 6 },
  muted: { fontSize: 13, color: T.muted, lineHeight: 19 },
  err: { marginTop: 14, backgroundColor: T.redSoft, color: '#8c1d18',
         padding: 10, borderRadius: 10, fontSize: 13 },
  foot: { color: 'rgba(255,255,255,0.75)', fontSize: 12, textAlign: 'center',
          marginTop: 24 },
});
