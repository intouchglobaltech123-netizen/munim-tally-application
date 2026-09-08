import React from 'react';
import { Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { useApp } from '../lib/store';
import { Loading } from '../components/ui';
import type { LucideIcon } from 'lucide-react-native';
import {
  LayoutDashboard, HandCoins, FileBarChart, Menu, Layers,
} from 'lucide-react-native';
import { Animated, StyleSheet } from 'react-native';
import { BottomTabBar, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { TabBarProvider, useTabBar } from '../lib/tabbar';
import { T } from '../theme';

import LoginScreen from '../screens/LoginScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import DashboardScreen from '../screens/DashboardScreen';
import OutstandingScreen from '../screens/OutstandingScreen';
import PartyScreen from '../screens/PartyScreen';
import MoreScreen from '../screens/MoreScreen';
import ReportsScreen from '../screens/ReportsScreen';
import AccountScreen from '../screens/AccountScreen';
import BillingScreen from '../screens/BillingScreen';
import KpiScreen from '../screens/KpiScreen';
import PulseScreen from '../screens/PulseScreen';
import CustomiseScreen from '../screens/CustomiseScreen';
import EntryScreen from '../screens/EntryScreen';
import HelpScreen from '../screens/HelpScreen';
import TicketScreen from '../screens/TicketScreen';
import AuditScreen from '../screens/AuditScreen';
import DevicesScreen from '../screens/DevicesScreen';
import TransactionsScreen from '../screens/TransactionsScreen';
import VoucherScreen from '../screens/VoucherScreen';
import ItemsScreen from '../screens/ItemsScreen';
import CashBankScreen from '../screens/CashBankScreen';
import InsightsScreen from '../screens/InsightsScreen';
import SyncScreen from '../screens/SyncScreen';
import SecurityScreen from '../screens/SecurityScreen';
import UsersScreen from '../screens/UsersScreen';
import PartiesScreen from '../screens/PartiesScreen';
import ItemScreen from '../screens/ItemScreen';
import InvoiceScreen from '../screens/InvoiceScreen';
import GstScreen from '../screens/GstScreen';
import RemindersScreen from '../screens/RemindersScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import SearchScreen from '../screens/SearchScreen';
import LockScreen, { useAppLockGate } from '../screens/LockScreen';
import LinkTallyScreen from '../screens/LinkTallyScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

// Emoji instead of an icon font: one less dependency, and it renders on every
// Real icons, at one weight and one size. Emoji render differently on every
// Android skin, and at tab-bar size they read as decoration rather than
// navigation.
const ICON: Record<string, LucideIcon> = {
  Home: LayoutDashboard,
  Books: Layers,          // sales, purchases, receipts - the ledger itself
  Outstanding: HandCoins,
  Reports: FileBarChart,
  More: Menu,
};

/**
 * The tab bar, which slides away while you read.
 *
 * React Navigation cannot animate `tabBarStyle` on its own, so the bar is
 * rendered through `tabBar` and wrapped in an Animated.View that the scroll
 * position drives. `position: absolute` is what lets it move without the
 * screen re-laying out underneath it - otherwise every list would jump as the
 * bar came and went.
 */
function AnimatedTabBar(props: BottomTabBarProps) {
  const ctl = useTabBar();
  return (
    <Animated.View
      style={[
        st.tabBarWrap,
        ctl ? { transform: [{ translateY: ctl.translateY }] } : null,
      ]}
    >
      <BottomTabBar {...props} />
    </Animated.View>
  );
}

function Tabs() {
  return (
    <TabBarProvider>
      <TabsInner />
    </TabBarProvider>
  );
}

function TabsInner() {
  return (
    <Tab.Navigator
      tabBar={(props) => <AnimatedTabBar {...props} />}
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: T.green,
        tabBarInactiveTintColor: T.muted,
        tabBarStyle: {
          height: 64, paddingBottom: 9, paddingTop: 8,
          borderTopColor: T.line, backgroundColor: T.card,
          // Absolute, so hiding it does not reflow the screen above.
          position: 'absolute', left: 0, right: 0, bottom: 0,
          elevation: 0,
        },
        tabBarLabelStyle: {
          fontSize: 11.5, fontFamily: T.font.semibold, marginTop: 1,
        },
        tabBarIcon: ({ focused, color }) => {
          const Icon = ICON[route.name] ?? LayoutDashboard;
          // Heavier stroke when active does the work a colour change alone
          // cannot at this size.
          return <Icon size={21} strokeWidth={focused ? 2.4 : 1.9} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Home" component={DashboardScreen} />
      {/* Everything that is a voucher: sales, purchases, receipts, payments. */}
      <Tab.Screen name="Books" component={TransactionsScreen} />
      <Tab.Screen name="Outstanding" component={OutstandingScreen} />
      <Tab.Screen name="Reports" component={ReportsScreen} />
      <Tab.Screen name="More" component={MoreScreen} />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  const { ready, me } = useApp();

  /*
   * The lock sits between the session and the figures.
   *
   * Deliberately not between the session and the app: failing it must never
   * sign anybody out. Signing out is the expensive thing to undo, and a
   * forgotten PIN is not a reason to make somebody re-pair a device.
   */
  const lock = useAppLockGate(!!me?.appLock?.enabled, me?.appLock?.minutes ?? 0);

  // Hold the splash until we know whether there is a session, so the app never
  // flashes the login screen at someone who is already signed in.
  if (!ready) return <Loading label="Starting Munim…" />;

  if (me && !me.needsOnboarding && lock.locked) {
    return <LockScreen onUnlocked={lock.unlock} />;
  }

  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerTintColor: T.ink,
          headerStyle: { backgroundColor: '#fff' },
          headerTitleStyle: { fontFamily: T.font.bold },
          contentStyle: { backgroundColor: T.bg },
        }}
      >
        {/* Three states, in order: signed out -> no business yet -> the app.
            An account with no business name has nothing to show, so it never
            reaches the tabs. */}
        {!me ? (
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        ) : me.needsOnboarding ? (
          <Stack.Screen name="Onboarding" component={OnboardingScreen}
            options={{ headerShown: false }} />
        ) : (
          <>
            <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
            <Stack.Screen name="Party" component={PartyScreen}
              options={{ title: 'Statement' }} />
            <Stack.Screen name="LinkTally" component={LinkTallyScreen}
              options={{ title: 'Link Tally' }} />
            <Stack.Screen name="Search" component={SearchScreen}
              options={{ title: 'Search' }} />
            <Stack.Screen name="Notifications" component={NotificationsScreen}
              options={{ title: 'Notifications' }} />
            <Stack.Screen name="Reminders" component={RemindersScreen}
              options={{ title: 'Reminders' }} />
            <Stack.Screen name="Gst" component={GstScreen}
              options={{ title: 'GST' }} />
            <Stack.Screen name="Invoice" component={InvoiceScreen}
              options={{ title: 'Invoice' }} />
            <Stack.Screen name="Voucher" component={VoucherScreen}
              options={{ title: 'Voucher' }} />
            <Stack.Screen name="Items" component={ItemsScreen}
              options={{ title: 'Items & stock' }} />
            <Stack.Screen name="Item" component={ItemScreen}
              options={{ title: 'Item' }} />
            <Stack.Screen name="Parties" component={PartiesScreen}
              options={{ title: 'Parties' }} />
            <Stack.Screen name="CashBank" component={CashBankScreen}
              options={{ title: 'Cash & Bank' }} />
            <Stack.Screen name="Insights" component={InsightsScreen}
              options={{ title: 'Insights' }} />
            <Stack.Screen name="Sync" component={SyncScreen}
              options={{ title: 'Sync' }} />
            <Stack.Screen name="Users" component={UsersScreen}
              options={{ title: 'Users & roles' }} />
            <Stack.Screen name="Security" component={SecurityScreen}
              options={{ title: 'Security' }} />
            <Stack.Screen name="Devices" component={DevicesScreen}
              options={{ title: 'Linked devices' }} />
            <Stack.Screen name="Audit" component={AuditScreen}
              options={{ title: 'Audit log' }} />
            <Stack.Screen name="Account" component={AccountScreen}
              options={{ title: 'Account' }} />
            <Stack.Screen name="Billing" component={BillingScreen}
              options={{ title: 'Plan & billing' }} />
            <Stack.Screen name="Kpi" component={KpiScreen}
              options={{ title: 'Key numbers' }} />
            <Stack.Screen name="Pulse" component={PulseScreen}
              options={{ title: 'Pulse' }} />
            <Stack.Screen name="Customise" component={CustomiseScreen}
              options={{ title: 'Customise' }} />
            <Stack.Screen name="Entry" component={EntryScreen}
              options={{ title: 'New entry' }} />
            <Stack.Screen name="Help" component={HelpScreen}
              options={{ title: 'Help' }} />
            <Stack.Screen name="Ticket" component={TicketScreen}
              options={{ title: 'Ticket' }} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const st = StyleSheet.create({
  tabBarWrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
