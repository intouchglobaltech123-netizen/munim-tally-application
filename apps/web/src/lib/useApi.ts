'use client';

import { useCallback, useEffect, useState } from 'react';
import { get } from './api';
import { readCache, writeCache } from './cache';
import { fetchState } from './fetchState';

type State<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Which request `data` belongs to. See below - this is the whole point. */
  forPath: string | null;
  /** Milliseconds old when these figures came from the cache, else null. */
  stale: number | null;
  /** True when the last attempt never reached the server. */
  offline: boolean;
};

/**
 * Minimal data hook: fetch, expose loading/error, allow a manual reload.
 *
 * Deliberately not TanStack Query - this app has a handful of endpoints and a
 * cache library would be more code than the thing it caches.
 *
 * The subtlety worth reading is what happens when `path` changes.
 *
 * `data` used to be cleared the instant the path changed, on the grounds that
 * rendering a Profit & Loss screen over Trial Balance data crashes on a field
 * that does not exist. True - but it treated "changed the date filter" exactly
 * like "navigated to a different report", and those are not the same thing at
 * all. Changing a filter blanked the entire screen to a spinner for the length
 * of a round trip, so every filter press was a white flash and a full redraw.
 *
 * The rule is now narrower and does the job the old one was reaching for: keep
 * the old data when only the QUERY changed, because the shape is guaranteed
 * identical; clear it when the ENDPOINT changed, because the shape is not.
 * Screens get `refreshing` to grey the figures while the new ones arrive,
 * rather than losing the page they are looking at.
 */
export function useApi<T>(path: string | null, deps: unknown[] = [], refreshMs = 0) {
  const [s, setS] = useState<State<T>>({
    data: null, error: null, loading: !!path, forPath: null,
    stale: null, offline: false,
  });

  const load = useCallback(async (background = false) => {
    if (!path) {
      setS({ data: null, error: null, loading: false, forPath: null, stale: null, offline: false });
      return;
    }
    if (!background) setS((p) => ({ ...p, loading: true, error: null }));

    /*
     * Show what we had while asking again.
     *
     * On a counter PC whose line just dropped, this is the difference between
     * the page still being useful and an error. The age is reported alongside,
     * because a stale figure presented as current is how somebody chases the
     * wrong customer.
     */
    if (!background) {
      const cached = readCache<T>(path);
      if (cached) {
        setS({
          data: cached.data, error: null, loading: false,
          forPath: path, stale: cached.ageMs, offline: false,
        });
      }
    }

    try {
      const fresh = await get<T>(path);
      // Stamp the result with the path it came from, so a slow response for an
      // abandoned request cannot land on a screen that has moved on.
      setS({ data: fresh, error: null, loading: false, forPath: path, stale: null, offline: false });
      writeCache(path, fresh);
    } catch (e) {
      // A request that never reached the server is "offline"; one the server
      // refused is a real error and must be said plainly.
      const msg = (e as Error).message;
      const unreachable = /failed to fetch|networkerror|load failed|cannot reach/i.test(msg)
        || (typeof navigator !== 'undefined' && navigator.onLine === false);

      const cached = readCache<T>(path);
      if (cached) {
        setS({
          data: cached.data, error: null, loading: false,
          forPath: path, stale: cached.ageMs, offline: unreachable,
        });
      } else if (background) {
        setS((p) => ({ ...p, loading: false, offline: unreachable }));
      } else {
        setS({ data: null, error: msg, loading: false, forPath: path, stale: null, offline: unreachable });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [path, ...deps]);

  /*
   * Optional polling, for screens watching for something to happen - a
   * connector coming online, a sync landing. Off by default: most screens are
   * read once and navigated away from.
   */
  useEffect(() => {
    if (!path || !refreshMs) return;
    const id = setInterval(() => { void load(true); }, refreshMs);
    return () => clearInterval(id);
  }, [path, refreshMs, load]);

  const matches = s.forPath === path;
  const { usable, loading, refreshing } = fetchState(s.forPath, path, s.loading);

  return {
    data: usable ? s.data : null,
    // An error belongs to the request that produced it, never to a newer one.
    error: matches ? s.error : null,
    /*
     * `loading` means "there is nothing to show", so a screen's skeleton only
     * appears on a genuine first load. `refreshing` means "what you can see is
     * about to be replaced" - screens grey the figures rather than hiding them,
     * which is what makes a filter feel like a filter instead of a page load.
     */
    loading,
    refreshing,
    stale: matches ? s.stale : null,
    /*
     * Belongs to the request currently on screen, not to whatever was asked
     * for before it. Returned unconditionally, a failure on the previous page
     * followed the customer to the next one and warned them about a request
     * that had already been abandoned.
     */
    offline: usable ? s.offline : false,
    reload: () => load(),
  };
}
