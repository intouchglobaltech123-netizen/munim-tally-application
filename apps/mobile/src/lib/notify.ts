import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/*
 * Loaded at runtime, not imported.
 *
 * expo-notifications is native code, so it only exists in a build made after it
 * was added. A plain import is evaluated as the bundle loads, and a missing
 * native module then takes the WHOLE APP down with "Cannot find native module
 * 'ExpoPushTokenManager'" - before a single screen renders.
 *
 * That is the wrong trade. Notifications are a convenience; the books are the
 * product. On an older build the app runs exactly as before and the Alerts
 * toggle explains why it is unavailable.
 */
type NotificationsModule = typeof import('expo-notifications');

let mod: NotificationsModule | null = null;
let looked = false;

function notifications(): NotificationsModule | null {
  if (looked) return mod;
  looked = true;
  try {
    /*
     * Ask whether the native side exists BEFORE loading the package.
     *
     * expo-notifications calls requireNativeModule('ExpoPushTokenManager') at
     * the top level of a file its entry point re-exports, so merely requiring
     * it throws on a build that predates the dependency. requireOptionalNative-
     * Module answers the same question by returning null instead - so the
     * throwing module is never evaluated at all.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const core = require('expo-modules-core');
    const native = core.requireOptionalNativeModule?.('ExpoPushTokenManager');
    if (!native) { mod = null; return mod; }

    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    mod = require('expo-notifications') as NotificationsModule;
    mod.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,   // a shop is noisy enough
        shouldSetBadge: false,
      }),
    });
  } catch {
    mod = null;                   // an older build; carry on without it
  }
  return mod;
}

/** False on a build made before notifications were added. */
export function isSupported(): boolean {
  return notifications() !== null;
}

/**
 * Telling the owner when something happens in their books.
 *
 * Local notifications, not push. Push needs a server holding device tokens and
 * a Google project sending through FCM; local needs neither, costs nothing, and
 * for this product says the same thing - the phone already polls every few
 * seconds, so it knows about a new voucher as soon as any server would.
 *
 * The limitation, stated plainly: this fires while the app is open or recently
 * backgrounded. A notification hours after the phone was last opened needs real
 * push, and that is a decision to take when there are customers asking for it.
 *
 * What is deliberately NOT notified:
 *
 *  - the first load after signing in. Everything is new then, and a notification
 *    saying "165 new vouchers" is noise, not news.
 *  - anything while the app is in the foreground. The figure is already on
 *    screen; buzzing about it is insulting.
 */

const SEEN_KEY = 'munim.notify.lastCount';
const ENABLED_KEY = 'munim.notify.enabled';

/** Asks once. A refusal is remembered, so nobody is nagged. */
export async function askPermission(): Promise<boolean> {
  const N = notifications();
  if (!N) return false;
  try {
    const { status: existing } = await N.getPermissionsAsync();
    let status = existing;
    if (existing !== 'granted') {
      ({ status } = await N.requestPermissionsAsync());
    }

    if (Platform.OS === 'android') {
      // Android needs a channel or notifications are silently dropped.
      await N.setNotificationChannelAsync('munim', {
        name: 'Munim',
        importance: N.AndroidImportance.DEFAULT,
        vibrationPattern: [0, 200],
        lockscreenVisibility: N.AndroidNotificationVisibility.PRIVATE,
      });
    }

    const ok = status === 'granted';
    await AsyncStorage.setItem(ENABLED_KEY, ok ? '1' : '0');
    return ok;
  } catch {
    return false;
  }
}

export async function isEnabled(): Promise<boolean> {
  try { return (await AsyncStorage.getItem(ENABLED_KEY)) === '1'; } catch { return false; }
}

export async function setEnabled(on: boolean): Promise<void> {
  try { await AsyncStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

/**
 * Notices new vouchers by watching the count move.
 *
 * Compared against what this phone last saw, not against a server-side "unread"
 * flag - because the same account on two phones should not have one of them
 * silently swallow the other's notification.
 */
export async function notifyIfNewVouchers(
  companyName: string,
  voucherCount: number,
  appIsForeground: boolean,
): Promise<void> {
  const N = notifications();
  if (!N) return;
  try {
    if (!(await isEnabled())) return;

    const raw = await AsyncStorage.getItem(SEEN_KEY);
    const seen = raw ? JSON.parse(raw) as Record<string, number> : {};
    const before = seen[companyName];

    seen[companyName] = voucherCount;
    await AsyncStorage.setItem(SEEN_KEY, JSON.stringify(seen));

    // First time we have seen this company: record the count, say nothing.
    if (before === undefined) return;

    const added = voucherCount - before;
    if (added <= 0) return;
    // On screen already - a buzz about a number they can see is noise.
    if (appIsForeground) return;

    await N.scheduleNotificationAsync({
      content: {
        title: companyName,
        body: added === 1
          ? '1 new entry in your books'
          : `${added} new entries in your books`,
        data: { companyName },
      },
      trigger: null,   // now
    });
  } catch {
    // A notification that fails must never break a refresh.
  }
}

/** Signing out forgets the counts, so the next person starts clean. */
export async function resetNotifyState(): Promise<void> {
  try { await AsyncStorage.multiRemove([SEEN_KEY]); } catch { /* ignore */ }
}
