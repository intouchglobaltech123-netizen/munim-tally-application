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
            itp_support?: boolean;
            ux_mode?: 'popup' | 'redirect';
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
 * Surfaces the one failure Google refuses to hand back.
 *
 * When the client ID has not been told about this origin, GIS still draws the
 * button and still accepts the tap - and then does nothing at all. It reports
 * the reason by writing to the browser console and nowhere else: no callback,
 * no rejected promise, no event. So the person sees a sign-in button that
 * simply does not work, which is the single most confusing way this can fail
 * and exactly what it looked like on the deployed site.
 *
 * Reading the console back is not elegant. It is, as far as Google exposes
 * anything, the only way to tell somebody why they are stuck.
 */
function watchForGsiComplaints(onError: (message: string) => void): void {
  if (typeof console === 'undefined' || watching) return;
  watching = true;

  const original = console.error;
  console.error = (...args: unknown[]) => {
    const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
    if (/origin|client ID|client_id/i.test(text) && /google|gsi|not allowed|invalid/i.test(text)) {
      onError(friendlyGoogleError(new Error(`origin: ${text}`)));
    }
    original.apply(console, args as []);
  };
}

let watching = false;

/**
 * How wide Google's button should be drawn, for the space it has.
 *
 * The width has to be a number: Google renders the button inside an iframe of
 * exactly this many pixels and ignores CSS applied from outside. It was fixed
 * at 320, which is wider than the card on any ordinary phone - a 360px screen
 * leaves about 256px inside the padding - so the button hung off the edge and
 * part of what people were tapping was not on the screen at all.
 *
 * Google clamps to 200-400 itself and errors outside that, so this does too.
 */
export function buttonWidth(available: number): number {
  if (!Number.isFinite(available) || available <= 0) return 280;
  return Math.max(200, Math.min(400, Math.floor(available)));
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

  watchForGsiComplaints(onError);

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
    /*
     * Both of these are about phones.
     *
     * Safari's tracking prevention blocks the third-party storage the popup
     * flow relies on; itp_support is Google's route around that. FedCM is what
     * Chrome is moving everyone to, and without it the prompt is increasingly
     * refused outright on mobile Chrome.
     */
    itp_support: true,
    use_fedcm_for_prompt: true,
  });

  el.replaceChildren();
  id.renderButton(el, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'pill',
    logo_alignment: 'center',
    width: buttonWidth(el.clientWidth || el.parentElement?.clientWidth || 0),
  });
}

/**
 * Turns Google's failures into something a shop owner can act on.
 *
 * The origin case names the address the browser is actually on. Hard-coding
 * localhost was fine while this only ran on a laptop; on a deployed site it
 * told people to authorise the wrong thing, which is worse than saying
 * nothing.
 */
export function friendlyGoogleError(e: unknown): string {
  const msg = (e as Error)?.message || '';
  if (/origin/i.test(msg)) {
    const here = typeof window === 'undefined' ? 'this site' : window.location.origin;
    return `Google has not been told about ${here}. In Google Cloud Console, `
      + `open Credentials, pick this OAuth client, and add ${here} under `
      + 'Authorised JavaScript origins.';
  }
  if (/network|fetch|reach/i.test(msg)) return 'No internet connection.';
  return msg || 'Could not sign you in. Please try again.';
}
