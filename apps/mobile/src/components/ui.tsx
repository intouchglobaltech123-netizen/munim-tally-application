import React from 'react';
import {
  Animated,
  ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text,
  View, ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WifiOff } from 'lucide-react-native';
import { useTabBar } from '../lib/tabbar';
import { ageLabel } from '../lib/cache';
import { offlineBar } from '../lib/offlineBar';
import type { LucideIcon } from 'lucide-react-native';
import { initialsOf, toneIndex } from '../lib/initials';
import { T } from '../theme';

/*
 * Weights are font FILES, not a fontWeight number.
 *
 * React Native does not synthesise weights from one face: with Inter loaded,
 * fontFamily: T.font.bold silently rendered regular. Every style below names the
 * family it wants.
 */
const font = T.font;

/**
 * Every scrolling screen sits inside this.
 *
 * Phones put a clock, a notch and a gesture bar over the edges of the display,
 * and none of that is negotiable - content drawn there is simply not readable.
 * Screens were laying out from pixel zero, so the title sat under the status
 * bar and the last row under the home indicator.
 *
 * The insets are read at runtime rather than hardcoded: they differ between a
 * notch, a punch-hole and a phone with neither, and guessing a number is how
 * you end up right on one handset and wrong on every other.
 *
 * `bottom` also clears the tab bar, so the final card is never half-hidden
 * behind it - the commonest reason a list looks like it has been cut off.
 */
export function Screen({
  children, onRefresh, refreshing, padded = true, tabBar = true, header,
}: {
  children: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  padded?: boolean;
  tabBar?: boolean;
  /**
   * Stays put while the rest scrolls.
   *
   * Which company you are looking at, whether it is syncing, and the button
   * that hides every figure are all things you need at any point in a long
   * report - not only at the top of it. Scrolling them away means scrolling
   * back up to answer "is this still live?" or to blank the screen when
   * somebody walks over.
   */
  header?: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  // Null outside the tabs - Login and Onboarding have no bar to move.
  const tabBarCtl = useTabBar();

  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      {header ? (
        <View style={[st.header, { paddingTop: insets.top + 12 }]}>{header}</View>
      ) : null}

      <ScrollView
        style={{ backgroundColor: T.bg }}
        contentContainerStyle={{
          paddingTop: header ? 14 : insets.top + (padded ? 14 : 0),
          // Still clears the bar when it is showing; a final card touching it
          // looks cut off even when it is not.
          paddingBottom: insets.bottom + (tabBar ? 56 : 32),
          paddingHorizontal: padded ? 16 : 0,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
        onScroll={tabBar ? tabBarCtl?.onScroll : undefined}
        scrollEventThrottle={16}
        refreshControl={onRefresh
          ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh}
              tintColor={T.green} colors={[T.green]} />
          : undefined}
      >
        {children}
      </ScrollView>
    </View>
  );
}

const st = StyleSheet.create({
  header: {
    paddingHorizontal: 16, paddingBottom: 12,
    /*
     * The same ground as the page.
     *
     * A white bar over an off-white page draws a line across the top of every
     * screen and makes the header look bolted on. Matching the background lets
     * the cards below be the only thing that reads as raised - which is what
     * makes a screen feel like one surface rather than two.
     */
    backgroundColor: T.bg,
  },
});

/** The same insets for a screen that manages its own scrolling. */
export function useScreenInsets() {
  const insets = useSafeAreaInsets();
  return {
    top: insets.top + 14,
    bottom: insets.bottom + 28,
  };
}

/**
 * Says the figures on screen are not current.
 *
 * The rule this enforces: never show stale numbers as if they were live. A
 * shop owner deciding whether to chase a payment needs to know they are looking
 * at last night's position, and a small grey line does not carry that - hence
 * a coloured bar with the age spelled out.
 *
 * Nothing to dismiss. It disappears the moment real data arrives, which is the
 * only thing that should make it go away.
 */
/**
 * Shown only when the server genuinely cannot be reached.
 *
 * It used to appear whenever `ageMs` was set - and that is set on EVERY screen
 * open, because the hook paints cached figures for the moment before the fresh
 * ones land. So every tap flashed "No connection" and then withdrew it, which
 * is worse than useless: a warning that cries wolf on every tap is one nobody
 * believes when it is real. On a phone, where cached-first is the normal path,
 * it fired constantly.
 *
 * Being briefly on cached data is the cache working, not an outage. The age
 * still matters once we really are offline, because a stale figure presented as
 * current is how somebody chases the wrong customer.
 */
export function OfflineBar({ offline, ageMs }: { offline: boolean; ageMs: number | null }) {
  // Same predicate as the web, so the two apps cannot drift on when they warn.
  const bar = offlineBar(offline, ageMs, ageLabel);
  if (!bar.show) return null;

  return (
    <View style={[s.offline, s.offlineHard]}>
      <WifiOff size={14} strokeWidth={2.2} color={T.negative} />
      <Text style={[s.offlineText, { color: T.negative }]}>{bar.text}</Text>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Title({ children }: { children: React.ReactNode }) {
  return <Text style={s.title}>{children}</Text>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={s.label}>{children}</Text>;
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <Text style={s.muted}>{children}</Text>;
}

export function StatTile({ label, value, exact, tone = 'ink', sub, icon: Icon }: {
  label: string; value: string; exact?: string;
  tone?: 'ink' | 'good' | 'bad'; sub?: React.ReactNode; icon?: LucideIcon;
}) {
  const color = tone === 'good' ? T.positive : tone === 'bad' ? T.negative : T.ink;
  return (
    <Card style={s.tile}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
        <View style={{ flex: 1 }}><Label>{label}</Label></View>
        {Icon ? (
          <View style={s.tileIcon}>
            <Icon size={14} strokeWidth={2.25} color={T.green} />
          </View>
        ) : null}
      </View>
      <Text style={[s.tileValue, { color }]}>{value}</Text>
      {exact ? <Text style={s.tileExact}>{exact}</Text> : null}
      {sub ? <View style={{ marginTop: 8 }}>{sub}</View> : null}
    </Card>
  );
}

/**
 * An empty state that says why it is empty.
 *
 * "No data" tells somebody nothing. Each of these names the reason, and where
 * there is one, the next step.
 */
export function EmptyState({ title, hint, icon: Icon, action }: {
  title: string; hint?: string; icon?: LucideIcon; action?: React.ReactNode;
}) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24 }}>
      {Icon ? (
        <View style={s.emptyIcon}>
          <Icon size={20} strokeWidth={2} color={T.faint} />
        </View>
      ) : null}
      <Text style={s.emptyTitle}>{title}</Text>
      {hint ? <Text style={s.emptyHint}>{hint}</Text> : null}
      {action ? <View style={{ marginTop: 16 }}>{action}</View> : null}
    </View>
  );
}

export function Badge({ tone = 'ok', children }: {
  tone?: 'ok' | 'warn' | 'bad' | 'muted'; children: React.ReactNode;
}) {
  const bg = { ok: T.greenSoft, warn: T.amberSoft, bad: T.redSoft, muted: '#eef2f0' }[tone];
  const fg = { ok: T.greenDark, warn: T.amber, bad: T.red, muted: T.muted }[tone];
  return (
    <View style={[s.badge, { backgroundColor: bg }]}>
      <Text style={[s.badgeText, { color: fg }]}>{children}</Text>
    </View>
  );
}

export function Button({ title, onPress, variant = 'primary', disabled, icon: Icon }: {
  title: string; onPress: () => void; variant?: 'primary' | 'ghost';
  disabled?: boolean; icon?: LucideIcon;
}) {
  const primary = variant === 'primary';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.btn,
        primary ? s.btnPrimary : s.btnGhost,
        (disabled || pressed) && { opacity: disabled ? 0.5 : 0.85 },
      ]}
    >
      {Icon ? <Icon size={16} strokeWidth={2.25} color={primary ? '#fff' : T.ink} /> : null}
      <Text style={[s.btnText, { color: primary ? '#fff' : T.ink }]}>{title}</Text>
    </Pressable>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={s.center}>
      <ActivityIndicator color={T.green} />
      <Text style={s.muted}>{label ?? 'Loading…'}</Text>
    </View>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card style={{ backgroundColor: T.redSoft, borderColor: '#f3c9c5' }}>
      <Text style={{ fontFamily: T.font.bold, color: '#8c1d18' }}>Could not load this</Text>
      <Text style={{ marginTop: 4, color: '#8c1d18' }}>{message}</Text>
      {onRetry ? <View style={{ marginTop: 12 }}>
        <Button title="Try again" variant="ghost" onPress={onRetry} />
      </View> : null}
    </Card>
  );
}

export function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <Card>
      <Text style={{ fontFamily: T.font.bold, color: T.ink, textAlign: 'center' }}>{title}</Text>
      <Text style={{ marginTop: 6, color: T.muted, textAlign: 'center' }}>{hint}</Text>
    </Card>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: T.card, borderRadius: T.radius, borderWidth: 1,
    borderColor: T.line, padding: 16,
    // One shadow, one depth. Several on a screen reads as indecision.
    ...T.shadow,
  },
  offline: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 9, borderRadius: 12,
    marginBottom: 12, borderWidth: 1,
  },
  offlineHard: { backgroundColor: T.negativeSoft, borderColor: T.negativeSoft },
  offlineText: { fontSize: 12.5, fontFamily: T.font.medium, flex: 1 },
  tile: { flex: 1, minWidth: 150 },
  tileIcon: { width: 26, height: 26, borderRadius: 8, backgroundColor: T.greenSoft,
              alignItems: 'center', justifyContent: 'center' },
  emptyIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: T.lineSoft,
               alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  emptyTitle: { fontSize: 14, fontFamily: font.semibold, color: T.ink, textAlign: 'center' },
  emptyHint: { fontSize: 13, color: T.muted, textAlign: 'center', marginTop: 4,
               lineHeight: 19, fontFamily: font.regular, maxWidth: 280 },
  tileValue: { fontSize: 24, fontFamily: font.bold, marginTop: 6,
               letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  tileExact: { fontSize: 11, color: T.faint, marginTop: 3,
               fontFamily: font.regular, fontVariant: ['tabular-nums'] },
  title: { fontSize: 24, fontFamily: font.bold, color: T.ink, letterSpacing: -0.4 },
  label: { fontSize: 10.5, fontFamily: font.semibold, color: T.muted,
           textTransform: 'uppercase', letterSpacing: 0.8 },
  muted: { color: T.muted, fontSize: 13.5, fontFamily: font.regular, lineHeight: 19 },
  badge: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' },
  badgeText: { fontSize: 11, fontFamily: font.semibold },
  btn: { minHeight: T.tap, borderRadius: 14, paddingHorizontal: 18,
         flexDirection: 'row', gap: 8,
         alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: T.green },
  btnGhost: { backgroundColor: '#fff', borderWidth: 1, borderColor: T.line },
  btnText: { fontSize: 15, fontFamily: font.semibold, letterSpacing: 0.1 },
  center: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 8 },
});

// --- report primitives -------------------------------------------------------

/** A two-column row: label left, figure right. The shape most reports need. */
export function LineRow({ left, sub, right, subRight, strong, danger }: {
  left: string; sub?: string; right: string; subRight?: string;
  strong?: boolean; danger?: boolean;
}) {
  return (
    <View style={r.row}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={[r.left, strong && r.strong]} numberOfLines={1}>{left}</Text>
        {sub ? <Text style={r.sub}>{sub}</Text> : null}
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[r.right, strong && r.strong, danger && { color: T.red }]}>{right}</Text>
        {subRight ? <Text style={r.sub}>{subRight}</Text> : null}
      </View>
    </View>
  );
}

/**
 * A bar beats a chart on a phone: the label matters as much as the value, and
 * a bar keeps both readable at 360px wide.
 */
export function BarRow({ label, value, fraction, note }: {
  label: string; value: string; fraction: number; note?: string;
}) {
  return (
    <View style={{ paddingVertical: 7 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
        <Text style={r.left} numberOfLines={1}>{label}</Text>
        <Text style={r.right}>
          {value}
          {note ? <Text style={r.sub}>  {note}</Text> : null}
        </Text>
      </View>
      <View style={r.track}>
        <View style={[r.fill, { width: `${Math.max(2, Math.min(100, fraction * 100))}%` }]} />
      </View>
    </View>
  );
}

const r = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 9, borderTopWidth: 1, borderTopColor: T.line,
  },
  left: { flex: 1, color: T.ink, fontSize: 14, fontFamily: font.regular },
  right: { color: T.ink, fontSize: 14, fontFamily: font.semibold,
           letterSpacing: -0.2, fontVariant: ['tabular-nums'] },
  sub: { color: T.faint, fontSize: 11, marginTop: 2, fontFamily: font.regular },
  strong: { fontFamily: font.bold },
  track: { height: 6, borderRadius: 3, backgroundColor: T.lineSoft, marginTop: 7, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3, backgroundColor: T.green },
});

/**
 * A grey block the shape of what is coming.
 *
 * Only where there is genuinely nothing to show yet. Once there IS something, a
 * refresh uses `Settling` — replacing figures somebody is reading with grey
 * blocks is a page load, and that is the thing being avoided.
 *
 * The pulse is done with opacity rather than a moving gradient: a sweeping
 * highlight needs a native driver and a layer per block, and on a three-year-old
 * Android phone that is a visible cost for decoration.
 */
export function Skeleton({ w = '100%', h = 14, style }: {
  w?: number | string; h?: number; style?: ViewStyle;
}) {
  const pulse = React.useRef(new Animated.Value(0.4)).current;

  React.useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        { width: w as never, height: h, borderRadius: 6, backgroundColor: T.line },
        { opacity: pulse },
        style,
      ]}
    />
  );
}

/** Card-shaped skeletons, so the list does not jump when figures land. */
export function CardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} style={{ marginTop: 10 }}>
          <Skeleton w="45%" h={10} />
          <Skeleton w="70%" h={22} style={{ marginTop: 10 }} />
          <Skeleton w="35%" h={10} style={{ marginTop: 10 }} />
        </Card>
      ))}
    </>
  );
}

/**
 * Wraps content that is about to be replaced.
 *
 * Same element, same size, same position — so changing a filter reads as the
 * numbers being rechecked rather than the screen being rebuilt.
 */
export function Settling({ when, children }: {
  when: boolean; children: React.ReactNode;
}) {
  return <View style={{ opacity: when ? 0.45 : 1 }}>{children}</View>;
}

/* -------------------------------------------------------------- detailing --
 *
 * The same three pieces as the web: a position, something that says what kind
 * of thing a row is, and a party you can pick out of forty by its initials.
 * Kept identical in behaviour so a shopkeeper who learns the list on one does
 * not have to learn it again on the other.
 */

export { initialsOf };

const AVATAR_TONES: { bg: string; fg: string }[] = [
  { bg: '#d1fae5', fg: '#065f46' },
  { bg: '#e0f2fe', fg: '#075985' },
  { bg: '#fef3c7', fg: '#92400e' },
  { bg: '#ede9fe', fg: '#5b21b6' },
  { bg: '#ffe4e6', fg: '#9f1239' },
  { bg: '#ccfbf1', fg: '#115e59' },
  { bg: '#e0e7ff', fg: '#3730a3' },
  { bg: '#ffedd5', fg: '#9a3412' },
];

export function Avatar({ name, size = 'md' }: {
  name: string; size?: 'sm' | 'md' | 'lg';
}) {
  const px = size === 'sm' ? 28 : size === 'lg' ? 48 : 36;
  const font = size === 'sm' ? 10 : size === 'lg' ? 17 : 13;
  // Shared with the web, so a customer looks the same on both.
  const tone = AVATAR_TONES[toneIndex(name, AVATAR_TONES.length)];
  return (
    <View style={{
      width: px, height: px, borderRadius: px / 2, backgroundColor: tone.bg,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Text style={{ fontSize: font, fontWeight: '800', color: tone.fg }}>
        {initialsOf(name)}
      </Text>
    </View>
  );
}

/**
 * The serial number every Indian ledger has down its left edge.
 *
 * Fixed width and tabular figures, so the column stays straight at 9 → 10 -
 * exactly where a proportional font starts to wobble.
 */
export function Sno({ n }: { n: number }) {
  return (
    <Text style={{
      width: 22, textAlign: 'right', fontSize: 11, color: T.faint,
      fontVariant: ['tabular-nums'],
    }}>
      {n}
    </Text>
  );
}

/**
 * A list row carrying the same three things a table row does.
 *
 * One component rather than each screen assembling its own, because a list that
 * is laid out slightly differently on every screen is what makes an app feel
 * assembled rather than designed.
 */
export function ListRow({ n, avatar, icon: Icon, title, sub, right, rightSub, tone, onPress }: {
  n?: number;
  /** A name to draw initials from. Use for parties and people. */
  avatar?: string;
  /** An icon instead, for things that are not people. */
  icon?: LucideIcon;
  title: string;
  sub?: string;
  right?: string;
  rightSub?: string;
  tone?: 'good' | 'bad';
  onPress?: () => void;
}) {
  const body = (
    <View style={listRowStyles.row}>
      {n !== undefined ? <Sno n={n} /> : null}
      {avatar !== undefined ? <Avatar name={avatar} size="sm" /> : null}
      {Icon ? (
        <View style={listRowStyles.icon}>
          <Icon size={14} strokeWidth={2.2} color={T.muted} />
        </View>
      ) : null}

      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={listRowStyles.title} numberOfLines={1}>{title}</Text>
        {sub ? (
          <Text style={listRowStyles.sub} numberOfLines={1}>{sub}</Text>
        ) : null}
      </View>

      {right !== undefined || rightSub !== undefined ? (
        <View style={{ alignItems: 'flex-end' }}>
          {right !== undefined ? (
            <Text style={[listRowStyles.right, {
              color: tone === 'good' ? T.green : tone === 'bad' ? T.red : T.ink,
            }]}>
              {right}
            </Text>
          ) : null}
          {rightSub !== undefined ? (
            <Text style={listRowStyles.rightSub}>{rightSub}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  return onPress ? <Pressable onPress={onPress}>{body}</Pressable> : body;
}

const listRowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9,
    borderBottomWidth: 1, borderBottomColor: T.line,
  },
  icon: {
    width: 28, height: 28, borderRadius: 8, backgroundColor: T.bg,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 14, fontWeight: '600', color: T.ink },
  sub: { fontSize: 11, color: T.muted, marginTop: 2 },
  right: { fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  rightSub: { fontSize: 11, color: T.faint, marginTop: 2 },
});
