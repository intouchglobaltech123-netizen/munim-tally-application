'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { get, getToken, setToken, ApiError, type Me, type CompanyRef } from './api';

type AuthState = {
  me: Me | null;
  loading: boolean;
  /** Why the account could not be loaded, when it is not simply a dead token. */
  error: string | null;
  company: CompanyRef | null;
  setCompanyGuid: (guid: string) => void;
  refresh: () => Promise<void>;
  signOut: () => void;
};

const Ctx = createContext<AuthState | null>(null);
const COMPANY_KEY = 'munim.company';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [companyGuid, setGuid] = useState<string | null>(null);
  const router = useRouter();
  const path = usePathname();

  /*
   * Loads the signed-in user, and does NOT hide why it could not.
   *
   * A 401 is ordinary: the token is dead, so clear it and show the sign-in
   * screen. Anything else is a fault, and swallowing it produced the worst
   * failure this app has had. Sign-in awaited this, saw it resolve, and
   * navigated to the app; the route guard then saw no user and sent the person
   * back to /login, which was still showing "Signing you in…" from before. The
   * result was a spinner that never finished and never said anything, for a
   * server error that had a perfectly good message attached to it.
   *
   * So: a real failure is re-thrown for the caller to show, and remembered here
   * for anything that renders without calling refresh itself.
   */
  const refresh = useCallback(async () => {
    if (!getToken()) { setMe(null); setLoading(false); setError(null); return; }
    try {
      setMe(await get<Me>('/v1/me'));
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // A dead token must not trap the user on a spinner.
        setToken(null); setMe(null); setError(null);
        return;
      }
      setMe(null);
      setError((e as Error).message || 'Could not load your account.');
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  // Swallowed here on purpose: this is the boot-time load with nobody to show
  // it to yet. The message is on `error` for whatever renders next.
  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  // Remember the last company across visits - owners with several books do not
  // want to re-pick every time.
  useEffect(() => {
    try { setGuid(window.localStorage.getItem(COMPANY_KEY)); } catch { /* ignore */ }
  }, []);

  const setCompanyGuid = useCallback((guid: string) => {
    setGuid(guid);
    try { window.localStorage.setItem(COMPANY_KEY, guid); } catch { /* ignore */ }
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setMe(null);
    router.push('/login');
  }, [router]);

  // Route guard.
  //   not signed in            -> /login
  //   signed in, no business   -> /onboarding   (there is nothing to show yet)
  //   signed in and onboarded  -> the app
  useEffect(() => {
    if (loading) return;
    const isLogin = path === '/login';
    const isOnboarding = path === '/onboarding';

    if (!me) {
      // Not while a fault is on screen: bouncing to /login on a server error
      // throws away the only explanation the person is going to get.
      if (!isLogin && !error) router.replace('/login');
      return;
    }
    if (me.needsOnboarding) {
      if (!isOnboarding) router.replace('/onboarding');
      return;
    }
    if (isLogin || isOnboarding) router.replace('/');
  }, [loading, me, path, router]);

  const company = useMemo(() => {
    if (!me?.companies.length) return null;
    return me.companies.find((c) => c.tallyGuid === companyGuid) ?? me.companies[0];
  }, [me, companyGuid]);

  const value = useMemo(
    () => ({ me, loading, error, company, setCompanyGuid, refresh, signOut }),
    [me, loading, error, company, setCompanyGuid, refresh, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
