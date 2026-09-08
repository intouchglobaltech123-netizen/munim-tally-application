'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { get, getToken, setToken, ApiError, type Me, type CompanyRef } from './api';

type AuthState = {
  me: Me | null;
  loading: boolean;
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
  const [companyGuid, setGuid] = useState<string | null>(null);
  const router = useRouter();
  const path = usePathname();

  const refresh = useCallback(async () => {
    if (!getToken()) { setMe(null); setLoading(false); return; }
    try {
      setMe(await get<Me>('/v1/me'));
    } catch (e) {
      // A dead token must not trap the user on a spinner.
      if (e instanceof ApiError && e.status === 401) { setToken(null); setMe(null); }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

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
      if (!isLogin) router.replace('/login');
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
    () => ({ me, loading, company, setCompanyGuid, refresh, signOut }),
    [me, loading, company, setCompanyGuid, refresh, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside AuthProvider');
  return v;
}
