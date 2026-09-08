'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { get, post, setToken, type Session } from '../../lib/api';
import {
  renderGoogleButton, friendlyGoogleError, type AuthConfig,
} from '../../lib/google';
import { useAuth } from '../../lib/auth';

/**
 * Sign in with Google. That is the whole screen.
 *
 * No OTP, and no Firebase. SMS is billed per message with no free allowance,
 * and it bought nothing an email address does not already give us. Google
 * Identity Services is a script straight from Google; the accounts live in our
 * own database, so nothing meters users.
 *
 * Sign in once - sessions do not expire. They end when somebody ends them.
 */
export default function LoginPage() {
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const buttonRef = useRef<HTMLDivElement | null>(null);

  const { refresh } = useAuth();
  const router = useRouter();

  useEffect(() => {
    get<AuthConfig>('/v1/auth/config')
      .then(setCfg)
      .catch(() => setErr('Cannot reach the Munim server. Is it running?'));
  }, []);

  /** Google proved the email; our API issues the session that matters. */
  const onToken = useCallback(async (idToken: string) => {
    setErr(null); setBusy(true);
    try {
      const session = await post<Session>('/v1/auth/google', { idToken });
      setToken(session.access);
      await refresh();
      router.replace(session.needsOnboarding ? '/onboarding' : '/');
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }, [refresh, router]);

  useEffect(() => {
    if (!cfg?.google || !buttonRef.current) return;
    void renderGoogleButton(
      buttonRef.current,
      cfg.google.web,      // a browser must use the web client
      (t) => void onToken(t),
      (m) => setErr(friendlyGoogleError(new Error(m))),
    );
  }, [cfg, onToken]);

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-br from-brand-800 to-brand-600 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-white p-7 shadow-xl">
        <div className="mb-1 flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-700 text-lg font-extrabold text-white">
            M
          </span>
          <span className="text-xl font-bold tracking-tight">Munim</span>
        </div>
        <p className="mb-7 text-sm text-muted">Tally on your mobile</p>

        {!cfg ? (
          <p className="text-sm text-muted">Connecting…</p>
        ) : cfg.google ? (
          <>
            <h1 className="mb-1.5 text-lg font-bold">Sign in</h1>
            <p className="mb-5 text-sm text-muted">
              Use the Google account you want your books under. New here? An
              account is created for you.
            </p>

            {/* Google requires their own rendered button, not a styled div. */}
            <div ref={buttonRef} className="flex justify-center" />

            {busy ? (
              <p className="mt-4 text-center text-sm text-muted">Signing you in…</p>
            ) : (
              <p className="mt-5 text-xs text-faint">
                You stay signed in. No code to wait for, and nothing to remember.
              </p>
            )}
          </>
        ) : (
          /* Failing here, visibly, beats a button that always errors. */
          <>
            <h1 className="mb-1.5 text-lg font-bold">Sign-in is not set up yet</h1>
            <p className="text-sm text-muted">
              This server has no Google client configured. Set{' '}
              <code className="rounded bg-line-soft px-1">GOOGLE_CLIENT_IDS</code>{' '}
              in <code className="rounded bg-line-soft px-1">apps/api/.env</code>{' '}
              and restart it.
            </p>
          </>
        )}

        {err ? (
          <p className="mt-4 rounded-lg bg-negative-soft p-2.5 text-sm text-negative">{err}</p>
        ) : null}

        <p className="mt-7 text-xs text-faint">
          Munim reads your Tally data. The only thing it ever writes is a
          voucher you create here and send — and never without an owner
          switching that on. It never changes or deletes anything already in
          your books.
        </p>
      </div>
    </div>
  );
}
