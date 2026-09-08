/**
 * Sign in with Google, without Firebase.
 *
 * Google Identity Services is a single script from Google that hands back an ID
 * token. No SDK, no project, no vendor between us and Google - and nothing that
 * meters monthly active users, because our own database holds the accounts.
 *
 * The token is verified server-side against Google's certificates before it
 * means anything (apps/api/src/lib/google.js).
 */

const GSI_SRC = 'https://accounts.google.com/gsi/client';

export type AuthConfig = {
  provider: 'google' | 'not-configured';
  configured: boolean;
  google: { clientId: string; web: string; android: string } | null;
};

type GsiCredentialResponse = { credential?: string };

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(o: {
            client_id: string;
            callback: (r: GsiCredentialResponse) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
            use_fedcm_for_prompt?: boolean;
          }): void;
          renderButton(el: HTMLElement, o: Record<string, unknown>): void;
          disableAutoSelect(): void;
        };
      };
    };
  }
}

let loading: Promise<void> | null = null;

/** Loads Google's script once, however many times this is called. */
export function loadGoogle(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.google?.accounts?.id) return Promise.resolve();
  if (loading) return loading;

  loading = new Promise<void>((resolve, reject) => {
    const el = document.createElement('script');
    el.src = GSI_SRC;
    el.async = true;
    el.defer = true;
    el.onload = () => resolve();
    el.onerror = () => {
      loading = null;   // let a later attempt retry rather than hang forever
      reject(new Error('Could not reach Google. Check your internet connection.'));
    };
    document.head.appendChild(el);
  });
  return loading;
}

/**
 * Draws Google's own button into `el` and calls back with an ID token.
 *
 * Google requires *their* rendered button rather than a styled div of our own -
 * it is what carries the branding and the click they will accept.
 */
export async function renderGoogleButton(
  el: HTMLElement,
  clientId: string,
  onToken: (idToken: string) => void,
  onError: (message: string) => void,
): Promise<void> {
  try {
    await loadGoogle();
  } catch (e) {
    onError((e as Error).message);
    return;
  }

  const id = window.google?.accounts?.id;
  if (!id) { onError('Google sign-in did not load. Reload the page.'); return; }

  id.initialize({
    client_id: clientId,
    callback: (r) => {
      if (r.credential) onToken(r.credential);
      else onError('Google did not return a sign-in token.');
    },
    // Never sign somebody in silently: shop owners often have a personal and a
    // business account, and picking the wrong one puts books under the wrong login.
    auto_select: false,
    cancel_on_tap_outside: true,
  });

  el.replaceChildren();
  id.renderButton(el, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'pill',
    logo_alignment: 'center',
    width: 320,
  });
}

/** Turns Google's failures into something a shop owner can act on. */
export function friendlyGoogleError(e: unknown): string {
  const msg = (e as Error)?.message || '';
  if (/origin/i.test(msg)) {
    return 'This website is not authorised for that Google client. Add '
      + 'http://localhost:3000 under Authorised JavaScript origins.';
  }
  if (/network|fetch|reach/i.test(msg)) return 'No internet connection.';
  return msg || 'Could not sign you in. Please try again.';
}
