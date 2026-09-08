import React, { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import { Animated } from 'react-native';
import type { NativeSyntheticEvent, NativeScrollEvent } from 'react-native';

/**
 * The tab bar gets out of the way while you read, and comes back when you look
 * for it.
 *
 * A phone screen is mostly a list, and a fixed bar takes a permanent 64 points
 * off the bottom of every one of them. Hiding it on the way down and bringing
 * it back on the way up is the behaviour people already know from every reading
 * app, so nobody has to be told.
 *
 * Two details that decide whether this feels right or irritating:
 *
 *  - a threshold, so a shaky thumb does not flap the bar on and off
 *  - always visible near the top, because that is where somebody who has just
 *    landed is looking for navigation
 */

const HIDE_AFTER = 12;   // points of travel before reacting
const NEAR_TOP = 24;     // above this, always show

type Ctx = {
  translateY: Animated.Value;
  onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  show: () => void;
};

const TabBarContext = createContext<Ctx | null>(null);

export function TabBarProvider({ children }: { children: React.ReactNode }) {
  const translateY = useRef(new Animated.Value(0)).current;
  const lastY = useRef(0);
  const hidden = useRef(false);

  const animate = useCallback((toHidden: boolean) => {
    if (hidden.current === toHidden) return;
    hidden.current = toHidden;
    Animated.timing(translateY, {
      toValue: toHidden ? 120 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [translateY]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    const delta = y - lastY.current;

    if (y < NEAR_TOP) { animate(false); lastY.current = y; return; }
    if (Math.abs(delta) < HIDE_AFTER) return;

    animate(delta > 0);          // scrolling down hides, up shows
    lastY.current = y;
  }, [animate]);

  const show = useCallback(() => animate(false), [animate]);

  const value = useMemo(() => ({ translateY, onScroll, show }), [translateY, onScroll, show]);
  return <TabBarContext.Provider value={value}>{children}</TabBarContext.Provider>;
}

/** Null outside the tabs - Login and Onboarding have no tab bar to move. */
export const useTabBar = () => useContext(TabBarContext);
