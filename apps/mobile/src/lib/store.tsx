import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
// Aliased: this file already has its own AppState type for the store.
import { AppState as RNAppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  get, post, loadToken, saveToken, ApiError, type Me, type CompanyRef,
} from './api';
import { readCache, writeCache, clearCache } from './cache';
import { resetNotifyState } from './notify';

type AppState = {
  ready: boolean;
  me: Me | null;
  company: CompanyRef | null;
  privacy: boolean;                       // hide all figures
  setCompany: (guid: string) => void;
  togglePrivacy: () => void;
  refresh: () => Promise<void>;
  signIn: (accessToken: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AppState | null>(null);
const COMPANY_KEY = 'munim.company';
// The last account we saw. Kept so the app can open signed in without waiting
// on the network - the token is what proves who you are, not this.
const ME_KEY = 'munim.me';
const PRIVACY_KEY = 'munim.privacy';

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [guid, setGuid] = useState<string | null>(null);
  const [privacy, setPrivacy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const fresh = await get<Me>('/v1/me');
      setMe(fresh);
      // Remember it, so the next launch does not need the network to know who
      // is signed in.
      void AsyncStorage.setItem(ME_KEY, JSON.stringify(fresh));
    } catch (e) {
      /*
       * Only a 401 ends a session.
       *
       * Anything else - no Wi-Fi, the API not started, a laptop asleep - says
       * nothing about whether the sign-in is still good. Treating those as
       * signed-out is what made people log in again and again, which is exactly
       * what a session that never expires was meant to stop.
       */
      if (e instanceof ApiError && e.status === 401) {
        await saveToken(null);
        await AsyncStorage.removeItem(ME_KEY);
        setMe(null);
      }
    }
  }, []);

  useEffect(() => {
    (async () => {
      const [t, g, p, cached] = await Promise.all([
        loadToken(),
        AsyncStorage.getItem(COMPANY_KEY),
        AsyncStorage.getItem(PRIVACY_KEY),
        AsyncStorage.getItem(ME_KEY),
      ]);
      setGuid(g);
      setPrivacy(p === '1');

      if (t) {
        // Show the app immediately from what we knew last time, then confirm
        // with the server in the background. Opening straight into your books
        // beats a spinner, and beats a login screen you do not need.
        if (cached) {
          try { setMe(JSON.parse(cached) as Me); } catch { /* rewritten below */ }
        }
        setReady(true);
        void refresh();
        return;
      }
      setReady(true);
    })();
  }, [refresh]);

  /**
   * Keep the account in step with what the connector is doing.
   *
   * Linking Tally happens on a different machine, so nothing in the app tells
   * it a company has appeared. Without this, pairing succeeds on the PC and the
   * phone sits on "link your Tally" until someone restarts the app.
   *
   * Poll fast while waiting for that first company - it is the moment somebody
   * is watching the screen - then back off, because after that the company list
   * rarely changes and the reports do their own refreshing.
   */
  const waiting = !!me && me.companies.length === 0;
  useEffect(() => {
    if (!me) return;
    const every = waiting ? 3000 : 60000;
    const id = setInterval(() => { void refresh(); }, every);
    return () => clearInterval(id);
  }, [me, waiting, refresh]);

  // Coming back to the app is the other moment the data is likely stale.
  useEffect(() => {
    const sub = RNAppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const setCompany = useCallback((g: string) => {
    setGuid(g);
    void AsyncStorage.setItem(COMPANY_KEY, g);
  }, []);

  const togglePrivacy = useCallback(() => {
    setPrivacy((p) => {
      void AsyncStorage.setItem(PRIVACY_KEY, p ? '0' : '1');
      return !p;
    });
  }, []);

  const signIn = useCallback(async (accessToken: string) => {
    await saveToken(accessToken);
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    /*
     * Revoke on the server first.
     *
     * Sessions no longer expire, so a token that is only forgotten locally
     * stays valid for ever. Signing out has to actually end it.
     *
     * Best effort: if the network is down we still sign out on this device
     * rather than refusing to - the token goes with it, and the owner can cut
     * it from Devices later.
     */
    try { await post('/v1/auth/logout', {}); } catch { /* offline; clear anyway */ }
    await AsyncStorage.removeItem(ME_KEY);
    await clearCache();          // the next person to use this phone is not you
    await resetNotifyState();    // and should not inherit your notification state
    await saveToken(null);
    setMe(null);
  }, []);

  const company = useMemo(() => {
    if (!me?.companies.length) return null;
    return me.companies.find((c) => c.tallyGuid === guid) ?? me.companies[0];
  }, [me, guid]);

  const value = useMemo<AppState>(() => ({
    ready, me, company, privacy, setCompany, togglePrivacy, refresh, signIn, signOut,
  }), [ready, me, company, privacy, setCompany, togglePrivacy, refresh, signIn, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside AppProvider');
  return v;
}

/**
 * Fetch + loading + error + manual reload, and it keeps itself current.
 *
 * `refreshMs` re-fetches on a timer so a voucher entered in Tally shows up
 * without anyone pulling to refresh - the connector pushes every few seconds,
 * and this is the other half of that. Pass 0 to fetch once.
 */
export function useApi<T>(path: string | null, deps: unknown[] = [], refreshMs = 10000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  /*
   * How old the figures on screen are, and whether the network answered.
   *
   * Both are shown to the user rather than kept private: unlabelled stale
   * numbers are worse than none, because somebody will act on them.
   */
  const [stale, setStale] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  /*
   * Which request `data` belongs to.
   *
   * Screens choose how to render from what they asked for, so handing back the
   * previous request's data - even for one render - draws the Profit & Loss
   * view over Trial Balance data and crashes on a field that is not there.
   *
   * Clearing it in an effect is too late: effects run after render, and the
   * mismatched render has already happened. Comparing paths is synchronous, so
   * there is no frame in which the two disagree.
   */
  const [forPath, setForPath] = useState<string | null>(null);
  const hasData = useRef(false);

  const load = useCallback(async (background = false) => {
    if (!path) { setData(null); setForPath(null); setLoading(false); return; }
    if (!background || !hasData.current) setLoading(true);
    setError(null);

    /*
     * Show what we had while asking again.
     *
     * On a first visit with no connection this is the difference between the
     * app being useful and being a spinner. The figures are labelled with their
     * age, so nobody mistakes last night's receivables for this morning's.
     */
    if (!background && !hasData.current) {
      const cached = await readCache<T>(path);
      if (cached) {
        setData(cached.data);
        setForPath(path);
        setStale(cached.ageMs);
        hasData.current = true;
        setLoading(false);
      }
    }

    try {
      const fresh = await get<T>(path);
      // Stamped with its path, so a slow response for an abandoned request
      // cannot land on a screen that has moved on.
      setData(fresh);
      setForPath(path);
      setStale(null);
      setOffline(false);
      hasData.current = true;
      void writeCache(path, fresh);
    } catch (e) {
      const err = e as ApiError;
      // A request that never reached the server is "offline"; one the server
      // refused is a real error and has to be said plainly.
      const unreachable = err instanceof ApiError
        ? (err.status === 0 || err.code === 'UNREACHABLE' || err.code === 'NO_API_URL')
        : true;
      setOffline(unreachable);

      // Keep the last good numbers when a refresh fails; a dropped Wi-Fi should
      // not wipe a dashboard that is already showing figures.
      if (!hasData.current) {
        const cached = await readCache<T>(path);
        if (cached) {
          setData(cached.data);
          setStale(cached.ageMs);
          hasData.current = true;
        } else if (!background) {
          setError((e as Error).message);
        }
        setForPath(path);
      } else if (!background) {
        setForPath(path);
      }
    } finally { setLoading(false); }
  }, [path]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { hasData.current = false; void load(); }, [path, ...deps]);

  useEffect(() => {
    if (!path || !refreshMs) return;
    const id = setInterval(() => { void load(true); }, refreshMs);
    return () => clearInterval(id);
  }, [path, refreshMs, load]);

  // Re-fetch the moment the user comes back, rather than up to refreshMs later.
  useEffect(() => {
    if (!path) return;
    const sub = RNAppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void load(true);
    });
    return () => sub.remove();
  }, [path, load]);

  const matches = forPath === path;

  /*
   * Same endpoint, different parameters.
   *
   * `data` used to be cleared the instant `path` changed, which treated
   * "changed the date filter" exactly like "opened a different report". The
   * shape only differs in the second case: a sales report for 30 days and for
   * 90 days have identical fields. So a query-only change keeps what is on
   * screen and greys it, rather than blanking the screen for a round trip -
   * which on a phone, on shop wifi, is a long time to look at nothing.
   */
  const shapeOf = (p: string | null) => (p ? p.split('?')[0] : null);
  const sameShape = !matches && !!forPath && !!path
    && shapeOf(forPath) === shapeOf(path);
  const usable = matches || sameShape;

  return {
    data: usable ? data : null,
    // An error belongs to the request that produced it, never to a newer one.
    error: matches ? error : null,
    /** True only when there is nothing at all to show. */
    loading: (loading && !usable) || (!!path && !usable),
    /** True when what is on screen is about to be replaced. */
    refreshing: (loading || sameShape) && usable,
    /** Milliseconds old when these figures came from the cache, else null. */
    stale: matches ? stale : null,
    /*
     * True when the last attempt could not reach the server at all - and only
     * for the request currently on screen. Returned unconditionally, a failure
     * on the previous screen followed the customer to the next one and warned
     * them about a request that had already been abandoned.
     */
    offline: usable ? offline : false,
    reload: () => load(),
  };
}
