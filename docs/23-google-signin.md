# 23 — Sign in with Google

Google is the primary way in. No SMS, no OTP, no password.

**Why:** every SMS is billed per message, with no free allowance. Google
Sign-In is free to **50,000 monthly active users**. At this product's size that
is the difference between a real running cost and none at all.

Phone sign-in still exists behind a link, because accounts created by phone
need a way back in. New customers will not see it.

---

## Set it up — about 10 minutes

### 1. Create the OAuth clients

<https://console.cloud.google.com> → your project → **APIs & Services** →
**Credentials** → **Create credentials** → **OAuth client ID**.

If it asks for a consent screen first: **External**, app name `Munim`, your
email twice, Save. It can stay in "Testing" while only you use it.

Make **two** clients — Android and web are separate clients for the same
product:

| Client | Type | What it needs |
|---|---|---|
| Munim Android | Android | package `app.munim.mobile`, plus the **SHA-1** that `eas build` prints |
| Munim Web | Web application | Authorised origin `http://localhost:3000` |

Copy both client IDs. They look like `123-abc.apps.googleusercontent.com`.
**No client secret is needed** — a secret shipped inside an app is not a secret,
so the mobile app asks Google for an ID token directly instead.

### 2. Tell the API

In `apps/api/.env` — comma-separated, because any of your clients may
legitimately have minted the token the app sends:

```
GOOGLE_CLIENT_IDS=123-android.apps.googleusercontent.com,123-web.apps.googleusercontent.com
```

Restart the API. Confirm it took:

```bash
curl -s localhost:8080/v1/auth/config
```

`"provider":"google"` means the apps will now show the Google button. Until
then they fall back to phone sign-in, so a half-configured server fails
visibly here rather than at somebody's login.

### 3. Web — nothing else to do

```bash
corepack pnpm web
```

Open <http://localhost:3000>. One button.

### 4. Mobile — needs a development build

**Expo Go cannot do this.** Google refuses OAuth inside embedded WebViews
(`disallowed_useragent`, enforced since July 2023), so sign-in has to open the
**system browser** — and the browser has to be able to hand control back to the
app through the `munim://` scheme. Expo Go's redirect is an `exp://` URL, which
Google will not accept.

```powershell
corepack pnpm install
cd apps\mobile
npx eas build --profile development --platform android
```

Install the APK it produces. From then on `npx expo start --dev-client`.

---

## How it works

```
app / web                        your API
─────────                        ────────
system browser -> Google
  ← Google ID token
                POST /v1/auth/google
                  verify RS256 against Google's certs
                  check audience, issuer, expiry
                  require a VERIFIED email
                            ↓
                  find or create the account
                            ↓
                  ← your own 60-day session
```

Your API issues its own session, so every route, role check and tenant guard is
unchanged. Google only ever proves *"this person controls this email address"*.

**An unverified email is never treated as an identity.** Anyone can type
somebody else's address at sign-up; matching on it would hand them that account.

---

## One thing to know about existing accounts

An account created by **phone** has no email on it, so signing in with Google
creates a **separate** account — correct behaviour, since nothing proves the two
belong to the same person.

If you have Tally data under a phone-only account, the quickest fix is to sign
in with Google and pair the connector again:

```powershell
.\connector-ps\Munim-Connector.ps1 pair -Cloud http://localhost:8080
.\connector-ps\Munim-Connector.ps1 sync
```

A full re-sync takes seconds — nothing is lost but the org name.

Once an account has both identifiers, either one signs you in. Linking only ever
fills a **blank** field; it never overwrites an identity that is already set,
because that is how an established account gets taken over.

---

## Costs

| | |
|---|---|
| Google Sign-In | **free to 50,000 MAU** |
| Phone / SMS | billed per message, no free allowance |
| OAuth clients | free, unlimited |

See [20-costs.md](20-costs.md).
