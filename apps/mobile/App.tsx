import React, { useCallback } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import {
  useFonts,
  Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
} from '@expo-google-fonts/inter';
import { AppProvider } from './src/lib/store';
import AppNavigator from './src/navigation/AppNavigator';

/*
 * Hold the splash screen until the fonts are ready.
 *
 * Without this the app draws once in the system font and again in Inter, and
 * every figure jumps as it re-lays out. That flicker is most of what makes an
 * app feel unfinished, and it costs one await to avoid.
 */
SplashScreen.preventAutoHideAsync().catch(() => {});

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
  });

  const onReady = useCallback(() => {
    // Show the app even if a font failed: the system font is a fine fallback,
    // and a blank screen is not.
    if (fontsLoaded || fontError) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="dark" />
        <View style={{ flex: 1 }} onLayout={onReady}>
          <AppNavigator />
        </View>
      </AppProvider>
    </SafeAreaProvider>
  );
}
