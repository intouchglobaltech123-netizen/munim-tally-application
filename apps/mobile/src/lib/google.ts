import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

// Required so the browser tab closes and hands control back after sign-in.
WebBrowser.maybeCompleteAuthSession();

/**
 * Sign in with Google on the phone.
 *
 * Not a WebView. Google has refused OAuth inside embedded WebViews since July
 * 2023 (`disallowed_useragent`) - a host app owning the WebView could read the
 * password being typed - so this opens the system browser, which Google trusts
 * and which already holds the user's Google session.
 *
 * We ask for an ID token directly (`response_type=id_token`) rather than an
 * authorization code. A code exchange needs a client secret, and a secret
 * shipped inside an app is not a secret; the implicit flow avoids having one at
 * all, and the token is verified server-side against Google's certificates
 * before it means anything.
 */
const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};

export class GoogleSignInError extends Error {}

/** The last authorisation URL we sent, so a failure can be diagnosed. */
export let lastAuthUrl = '';

/** Returns the request Google rejected, broken into readable parameters. */
export function describeLastRequest(): string {
  if (!lastAuthUrl) return 'No sign-in has been attempted yet.';
  try {
    const u = new URL(lastAuthUrl);
    const lines = ['endpoint: ' + u.origin + u.pathname];
    u.searchParams.forEach((v, k) => {
      // The challenge and state are long and say nothing useful here.
      lines.push(`${k}: ${k === 'code_challenge' || k === 'state' ? v.slice(0, 12) + '…' : v}`);
    });
    return lines.join('\n');
  } catch {
    return lastAuthUrl;
  }
}

/** "123-abc.apps.googleusercontent.com" -> "com.googleusercontent.apps.123-abc" */
function reversedClientId(clientId: string): string {
  const id = clientId.replace(/\.apps\.googleusercontent\.com$/, '');
  return `com.googleusercontent.apps.${id}`;
}

export async function signInWithGoogle(clientId: string): Promise<string> {
  if (!clientId) throw new GoogleSignInError('Google sign-in is not configured.');

  /*
   * Google does not accept an arbitrary custom scheme for an installed app. It
   * expects the *reversed* client id:
   *
   *   client id  123-abc.apps.googleusercontent.com
   *   scheme     com.googleusercontent.apps.123-abc
   *
   * Deriving it from the client id means there is nothing to keep in sync when
   * the id changes - and getting it wrong shows up as redirect_uri_mismatch,
   * which names neither the expected value nor the one we sent.
   */
  const redirectUri = AuthSession.makeRedirectUri({
    native: `${reversedClientId(clientId)}:/oauth2redirect`,
  });

  /*
   * Authorization code + PKCE, not the implicit flow.
   *
   * An Android OAuth client only supports response_type=code. Asking it for an
   * id_token directly - which is what a Web client wants - is refused with:
   *
   *   Error 400: invalid_request      "Munim's request is invalid"
   *
   * PKCE is what makes this safe without a client secret: the code is useless
   * to anyone who intercepts it, because redeeming it requires the verifier
   * that never left this device.
   */
  const request = new AuthSession.AuthRequest({
    clientId,
    redirectUri,
    scopes: ['openid', 'profile', 'email'],
    responseType: AuthSession.ResponseType.Code,
    usePKCE: true,
    extraParams: {
      // Shop owners often hold a personal and a business account; silently
      // reusing the last one puts books under the wrong login.
      prompt: 'select_account',
    },
  });

  /*
   * Build the URL before opening it, and keep it.
   *
   * Google answers a bad request with "Munim's request is invalid" and nothing
   * else - not which parameter, not what it expected. The only way to tell a
   * wrong redirect_uri from a wrong response_type is to read what we actually
   * sent, so make sure we can.
   */
  await request.makeAuthUrlAsync(DISCOVERY);
  lastAuthUrl = request.url ?? '(not built)';
  console.log('[munim] google auth url:', lastAuthUrl);

  const result = await request.promptAsync(DISCOVERY);

  if (result.type === 'cancel' || result.type === 'dismiss') {
    // Closing Google's own error page looks identical to backing out, so this
    // cannot claim the user cancelled - it may be the request that was refused.
    throw new GoogleSignInError(
      'Sign-in did not complete. If Google showed an error, this is what we '
      + 'sent:\n\n' + describeLastRequest());
  }
  if (result.type === 'error') {
    const code = result.error?.code || '';
    const message = result.error?.message || '';

    // Google's own wording names neither the cause nor the fix.
    if (/redirect_uri_mismatch/i.test(code + message)) {
      throw new GoogleSignInError(
        'This app is using a Google client that does not allow it to sign in. '
        + 'Check the Android OAuth client uses package app.munim.mobile and the '
        + 'SHA-1 of the key this build was signed with.');
    }
    if (/invalid_client|unauthorized_client/i.test(code + message)) {
      throw new GoogleSignInError(
        'Google does not recognise this client id. Check GOOGLE_CLIENT_IDS in '
        + 'apps/api/.env matches the Android client you created.');
    }
    throw new GoogleSignInError(
      `${message || 'Google rejected the sign-in request.'}\n\nWhat we sent:\n`
      + describeLastRequest());
  }
  if (result.type !== 'success' || !result.params?.code) {
    throw new GoogleSignInError('Google did not complete the sign-in.');
  }

  // Swap the code for tokens. No client secret: Android clients do not have
  // one, and a secret shipped inside an app would not be secret anyway.
  const tokens = await AuthSession.exchangeCodeAsync(
    {
      clientId,
      code: result.params.code,
      redirectUri,
      extraParams: { code_verifier: request.codeVerifier ?? '' },
    },
    DISCOVERY,
  );

  const idToken = tokens.idToken;
  if (!idToken) throw new GoogleSignInError('Google did not return a sign-in token.');

  return idToken;
}
