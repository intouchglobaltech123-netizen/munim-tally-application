import React, { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { Lock, Delete } from 'lucide-react-native';
import { post } from '../lib/api';
import { T } from '../theme';

/**
 * The PIN in front of the figures.
 *
 * Exists for one situation, which is the common one: a phone already signed in
 * and left on the shop counter. It is not protecting the account - Google does
 * that - it is protecting the screen, which is why failing it never signs
 * anybody out.
 */

// Ten tries, then a forced wait. Enough that a shop owner with cold hands
// never hits it, few enough that a four-digit PIN cannot be walked through by
// somebody holding the phone.
const MAX_TRIES = 10;
const COOLDOWN_SECONDS = 60;

export default function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState('');
  const [tries, setTries] = useState(0);
  const [wait, setWait] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function submit(candidate: string) {
    if (wait > 0) return;
    setBusy(true); setErr(null);
    try {
      const r = await post<{ ok: boolean }>('/v1/security/app-lock/check', { pin: candidate });
      if (r.ok) {
        onUnlocked();
        return;
      }
      const n = tries + 1;
      setTries(n);
      setPin('');
      if (n >= MAX_TRIES) {
        setWait(COOLDOWN_SECONDS);
        setTries(0);
        setErr('Too many tries. Wait a minute.');
      } else {
        setErr(`Wrong PIN. ${MAX_TRIES - n} tries left.`);
      }
    } catch {
      // Offline is not a reason to lock somebody out of their own phone
      // permanently, but it is a reason not to let a guess through.
      setErr('Could not check that. Are you online?');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  function press(d: string) {
    if (busy || wait > 0) return;
    const next = pin + d;
    setPin(next);
    // Submitted at four, then on each further digit, so a longer PIN still
    // works without a separate confirm button.
    if (next.length >= 4) submit(next);
  }

  return (
    <View style={s.wrap}>
      <View style={s.badge}><Lock size={26} color={T.green} /></View>
      <Text style={s.title}>Munim is locked</Text>
      <Text style={s.sub}>
        {wait > 0 ? `Try again in ${wait}s` : 'Enter your PIN to see your books'}
      </Text>

      <View style={s.dots}>
        {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
          <View key={i} style={[s.dot, i < pin.length && s.dotOn]} />
        ))}
      </View>

      {err ? <Text style={s.err}>{err}</Text> : <View style={{ height: 18 }} />}

      <View style={s.pad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k, i) => (
          k === '' ? <View key={i} style={s.key} /> : (
            <Pressable key={i} style={s.key}
              onPress={() => (k === 'del' ? setPin((p) => p.slice(0, -1)) : press(k))}
              disabled={wait > 0}>
              {k === 'del'
                ? <Delete size={20} color={T.inkSoft} />
                : <Text style={s.keyText}>{k}</Text>}
            </Pressable>
          )
        ))}
      </View>

      <Text style={s.foot}>
        This only hides the screen. You stay signed in.
      </Text>
    </View>
  );
}

/**
 * Decides when the lock should reappear.
 *
 * Time away, not time since unlock: a shop owner switching to WhatsApp and
 * back should not be challenged, and a phone left face-up for an hour should.
 */
export function useAppLockGate(enabled: boolean, minutes: number) {
  const [locked, setLocked] = useState(enabled);
  const [leftAt, setLeftAt] = useState<number | null>(null);

  useEffect(() => { if (!enabled) setLocked(false); }, [enabled]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (!enabled) return;
      if (state === 'background' || state === 'inactive') {
        setLeftAt(Date.now());
        // Zero means lock the moment it leaves the screen, so nothing is
        // readable from the app switcher either.
        if (minutes === 0) setLocked(true);
      } else if (state === 'active' && leftAt != null) {
        if (Date.now() - leftAt >= minutes * 60_000) setLocked(true);
        setLeftAt(null);
      }
    });
    return () => sub.remove();
  }, [enabled, minutes, leftAt]);

  return { locked, unlock: () => setLocked(false), lock: () => setLocked(true) };
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: T.bg, alignItems: 'center', justifyContent: 'center', padding: 28 },
  badge: {
    width: 60, height: 60, borderRadius: 30, backgroundColor: T.greenSoft,
    alignItems: 'center', justifyContent: 'center', marginBottom: 18,
  },
  title: { fontFamily: T.font.bold, fontSize: 20, color: T.ink },
  sub: { fontFamily: T.font.regular, fontSize: 13, color: T.muted, marginTop: 6 },
  dots: { flexDirection: 'row', gap: 12, marginTop: 26 },
  dot: { width: 13, height: 13, borderRadius: 7, backgroundColor: T.line },
  dotOn: { backgroundColor: T.green },
  err: { fontFamily: T.font.medium, fontSize: 12, color: T.negative, marginTop: 14, height: 18 },
  pad: { flexDirection: 'row', flexWrap: 'wrap', width: 260, marginTop: 24, justifyContent: 'center' },
  key: {
    width: 80, height: 66, alignItems: 'center', justifyContent: 'center',
  },
  keyText: { fontFamily: T.font.semibold, fontSize: 24, color: T.ink },
  foot: { fontFamily: T.font.regular, fontSize: 11, color: T.muted, marginTop: 22 },
});
