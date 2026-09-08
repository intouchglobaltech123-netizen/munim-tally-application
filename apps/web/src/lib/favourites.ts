'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Which reports this person has pinned.
 *
 * Kept in the browser rather than on the server on purpose: a pin is a
 * preference, not business data, and storing it locally means it works offline
 * and costs nothing to sync. The trade-off - pins do not follow you to another
 * device - is the right one for something this cheap to redo.
 */
const KEY = 'munim.favourites.v1';

const read = (): string[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    // Private browsing, or a value someone hand-edited. A missing pin is not
    // worth breaking the page over.
    return [];
  }
};

export function useFavourites() {
  // Start empty and fill on mount: reading localStorage during render would
  // disagree with the server-rendered HTML and blow up hydration.
  const [favs, setFavs] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setFavs(read());
    setReady(true);
  }, []);

  const toggle = useCallback((slug: string) => {
    setFavs((prev) => {
      const next = prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug];
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch { /* storage full or blocked - the pin just will not persist */ }
      return next;
    });
  }, []);

  const isFav = useCallback((slug: string) => favs.includes(slug), [favs]);

  return { favs, isFav, toggle, ready };
}
