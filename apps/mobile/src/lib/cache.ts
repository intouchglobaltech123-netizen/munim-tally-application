import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The last good answer for every screen, kept on the phone.
 *
 * A shop owner opens Munim on the road, in a basement godown, on a train. If
 * the app can only show figures when the connection is up, it is useless
 * exactly where a phone is most useful - and "check your internet" is not an
 * answer to "how much does Royal Tiles owe me?".
 *
 * So every successful response is written here, and served immediately on the
 * next visit while the network is asked again in the background. The screen is
 * never empty, and the age of the data is always stated rather than implied -
 * unlabelled stale figures are worse than none, because somebody will act on
 * them.
 *
 * Not a cache library: this is a key, a value and a timestamp. Anything more
 * would be more code than the thing it caches.
 */

const PREFIX = 'munim.cache.';

type Entry<T> = { at: number; data: T };

export async function readCache<T>(path: string): Promise<{ data: T; ageMs: number } | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + path);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Entry<T>;
    if (!entry || typeof entry.at !== 'number') return null;
    return { data: entry.data, ageMs: Date.now() - entry.at };
  } catch {
    return null;
  }
}

export async function writeCache<T>(path: string, data: T): Promise<void> {
  try {
    await AsyncStorage.setItem(PREFIX + path, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // A full disk must not break syncing. The next request simply misses.
  }
}

/** Signing out clears it: the next person to use this phone is not the last. */
export async function clearCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((k) => k.startsWith(PREFIX));
    if (ours.length) await AsyncStorage.multiRemove(ours);
  } catch { /* nothing to do */ }
}

/** "just now", "4 minutes ago", "yesterday" - for saying how old figures are. */
export function ageLabel(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
