'use client';

/**
 * The last good answer for every screen, kept in the browser.
 *
 * A shop's line goes down mid-afternoon and the counter PC still needs to show
 * what is owed. Serving the last known figures beats an error page - provided
 * their age is stated, because unlabelled stale numbers are worse than none.
 *
 * localStorage rather than a service worker: this is a key, a value and a
 * timestamp, and a worker would be far more machinery than the thing it caches.
 */

const PREFIX = 'munim.cache.';

type Entry<T> = { at: number; data: T };

export function readCache<T>(path: string): { data: T; ageMs: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PREFIX + path);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Entry<T>;
    if (!entry || typeof entry.at !== 'number') return null;
    return { data: entry.data, ageMs: Date.now() - entry.at };
  } catch {
    return null;
  }
}

export function writeCache<T>(path: string, data: T): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREFIX + path, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Quota exceeded on a browser with little room. Drop our own entries and
    // move on: a failed cache write must never break a working page.
    try {
      Object.keys(window.localStorage)
        .filter((k) => k.startsWith(PREFIX))
        .forEach((k) => window.localStorage.removeItem(k));
    } catch { /* nothing more to try */ }
  }
}

/** Signing out clears it: a shared counter PC must not keep the last person's books. */
export function clearCache(): void {
  if (typeof window === 'undefined') return;
  try {
    Object.keys(window.localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .forEach((k) => window.localStorage.removeItem(k));
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
