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

  // Read after mount: window does not exist while this renders on the server.
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

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

  /*
   * Redrawn on resize, because Google's button is a fixed-width iframe.
   *
   * It is sized once, in pixels, from the space available at that moment. A
   * phone rotated after the page loads - or a keyboard opening and closing -
   * leaves a button sized for the old width, and on the narrow side that means
   * part of it is off the screen.
   */
  useEffect(() => {
    if (!cfg?.google || !buttonRef.current) return;
    const el = buttonRef.current;

    const draw = () => void renderGoogleButton(
      el,
      cfg.google!.web,      // a browser must use the web client
      (t) => void onToken(t),
      (m) => setErr(friendlyGoogleError(new Error(m))),
    );

    draw();
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => { clearTimeout(timer); timer = setTimeout(draw, 150); };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
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

            {/* Google requires their own rendered button, not a styled div.
                min-w-0 so the flex parent may shrink it rather than overflow. */}
            <div ref={buttonRef} className="flex min-w-0 justify-center overflow-x-auto" />

            {busy ? (
              <p className="mt-4 text-center text-sm text-muted">Signing you in…</p>
            ) : (
              <>
                <p className="mt-5 text-xs text-faint">
                  You stay signed in. No code to wait for, and nothing to remember.
                </p>
                {/*
                  A tap that does nothing has no error to show, because Google
                  does not report one. Saying where the button came from at
                  least points whoever set this up at the right screen.
                */}
                <details className="mt-4">
                  <summary className="cursor-pointer text-xs text-faint">
                    Button does nothing when you tap it?
                  </summary>
                  <p className="mt-2 text-xs leading-relaxed text-muted">
                    This site has to be listed on the Google client. In Google
                    Cloud Console open Credentials, pick the OAuth client, and
                    add this address under Authorised JavaScript origins:
                    <code className="mt-1 block break-all rounded bg-line-soft px-1.5 py-1">
                      {origin || '…'}
                    </code>
                    It can take a few minutes to take effect.
                  </p>
                </details>
              </>
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
