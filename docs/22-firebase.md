# 22 — Firebase phone sign-in

Real SMS, and Google handles India's DLT registration — the two-week blocker
that makes MSG91 painful to start with.

> **Correction.** Earlier notes in this repo said Firebase phone auth is free to
> 10,000 verifications a month. **That was the pre-September-2024 policy and is
> no longer true.** Phone sign-in now requires the **Blaze plan with a billing
> account**; the Spark plan returns `BILLING_NOT_ENABLED`. SMS is billed per
> message. See [Firebase pricing](https://firebase.google.com/pricing).

The code is written and tested. What remains is creating **your** Firebase
project and pasting four values, which needs your Google account.

---

## What the code already does

```
  phone + code                    your API
 ┌──────────────┐               ┌────────────────────────────────┐
 │ web / mobile │──Firebase────►│                                │
 │              │  ID token     │  verify RS256 against Google's │
 │              │               │  published certificates        │
 │              │               │          ↓                     │
 │              │◄──────────────│  phone → find or create user   │
 │              │  YOUR session │  issue Munim access token      │
 └──────────────┘               └────────────────────────────────┘
```

**Firebase proves one thing: this person controls this phone number.** Your API
still issues its own session, so every route, role check and tenant guard is
untouched — and replacing Firebase with MSG91 later means rewriting one
function, `firebaseSignIn` in `apps/api/src/routes/auth.js`.

Verification is done directly against Google's certificates rather than through
`firebase-admin`: no 50 MB dependency, no service-account file to protect, and
the whole thing is 130 lines you can read.

---

## Step 1 — Create the Firebase project (5 minutes)

1. <https://console.firebase.google.com> → **Add project** → name it `munim`
2. Google Analytics: **off** (you do not need it, and it asks for more consents)
3. In the project: **Build → Authentication → Get started**
4. **Sign-in method → Phone → Enable → Save**
5. **Project settings (gear) → General → Your apps → Web (`</>`)**
   - Nickname `munim-web`, do **not** tick Firebase Hosting
   - Copy the `firebaseConfig` values it shows

You need four of them:

```js
apiKey:     "AIza..."                  // FIREBASE_API_KEY
authDomain: "munim-xxxxx.firebaseapp.com"
projectId:  "munim-xxxxx"              // FIREBASE_PROJECT_ID
appId:      "1:123...:web:abc..."      // FIREBASE_APP_ID
```

> The `apiKey` is **not a secret**. It identifies the project in public client
> code; Firebase's security comes from the authorised-domains list and your
> token verification, not from hiding it.

## Step 1b — Allow the SMS region (India)

Firebase blocks SMS to every region by default on new projects. Enabling the
Phone provider is not enough; probing the project returns:

```
OPERATION_NOT_ALLOWED : SMS unable to be sent until this region enabled by the
app developer.
```

**Authentication → Settings → SMS region policy → Allow → tick India (+91)**
(or "Allow all regions", then restrict later).

Allow only the regions you actually sell in. An open policy is what SMS-pumping
fraud targets: an attacker triggers thousands of sends to a premium-rate range
abroad and you pay for them.

## Step 1c — Billing: try WITHOUT it first

The Firebase console says, on the Phone provider:

> To prevent abuse, new projects currently have a sent SMS daily quota of
> **10/day**. To increase this quota, please add a billing account.

Read that carefully: billing **raises** the quota. It does not gate sending
outright. So **10 SMS a day may work on the free Spark plan** — enough to
onboard your first customers at no cost.

A REST probe of this project returned `BILLING_NOT_ENABLED`, but that probe
carried no reCAPTCHA token, which is not the path a browser takes. **The only
answer that counts is a real sign-in from the web app.** Do that before
attaching a card.

If a real browser sign-in also returns `BILLING_NOT_ENABLED`, then this project
does need Blaze — and then:

Blaze does not mean you start paying for everything; the free allowances on
other services stay. But it needs a card, and **SMS is billed per message**.

Before you enable it:

1. **Set a budget alert.** Google Cloud Console → Billing → Budgets & alerts.
   ₹500/month with alerts at 50% and 90% is plenty of headroom and tells you
   immediately if something is wrong.
2. **Keep the SMS region locked to India.** An open region policy is what
   SMS-pumping fraud targets: an attacker triggers thousands of sends to a
   premium-rate range abroad and you pay for them.
3. **Use test phone numbers for development** (Step 5) — they never send an SMS
   and are never billed.

### If you would rather not attach a card

The seam is one function, `firebaseSignIn` in `apps/api/src/routes/auth.js`.
The alternatives:

| Option | Cost | Catch |
|---|---|---|
| **Firebase + Blaze** | per SMS, ~₹0.50–2 in India | needs a card |
| **MSG91 / 2Factor** | ~₹0.20/SMS, prepaid | **DLT registration, 1–2 weeks** |
| **WhatsApp OTP** (Meta Cloud API) | ~₹0.11–0.15 | template approval, and you want WhatsApp for reminders anyway |
| **Development OTP** | ₹0 | **development only** — see below |

Prepaid providers have one real advantage over Blaze: they cannot run up a bill.

## Step 2 — Authorise your domains

**Authentication → Settings → Authorised domains → Add domain**

Add `localhost` for development, and your real domain before launch. Firebase
refuses to send an SMS from a domain that is not on this list — this is the
single most common "it worked locally, not in production" cause.

## Step 3 — Point the API at it

```bash
# apps/api/.env
FIREBASE_PROJECT_ID=munim-xxxxx
FIREBASE_API_KEY=AIza...
FIREBASE_APP_ID=1:123...:web:abc...
FIREBASE_AUTH_DOMAIN=munim-xxxxx.firebaseapp.com
```

Restart the API and check:

```bash
curl localhost:8080/v1/auth/config
# {"provider":"firebase","firebase":{...},"devOtp":false}
```

**The development OTP route now returns `410 OTP_DISABLED`.** That is
deliberate: a fixed or console-printed code reaching production means anyone
owns every account, so it has to be impossible rather than merely discouraged.

## Step 4 — Web

```bash
corepack pnpm install      # picks up the firebase package
corepack pnpm --filter web dev
```

The login screen reads `/v1/auth/config` and switches itself. Nothing is
hardcoded into the bundle, so one build runs against dev and production.

An **invisible reCAPTCHA** runs before each SMS. That is Firebase's abuse
control and cannot be skipped — it is what stops a stranger burning your quota.

## Step 5 — Test numbers (do this before spending real SMS)

**Authentication → Sign-in method → Phone → "Phone numbers for testing"**

Add a number and a code you choose, e.g. `+91 84380 98627` / `548723`. Up to
**10 per project**.

A registered test number:

- sends **no SMS**, so nothing to wait for
- **does not touch the 10/day quota**
- **skips reCAPTCHA**
- still mints a **real, Google-signed ID token**

That last point is why this is not a fake path. The token is signed RS256 by
Google exactly like a real one, so the server's signature, audience, issuer and
expiry checks all run for real. Only SMS delivery is skipped.

Pick numbers you will never onboard. A test entry **shadows** the real number:
register your own mobile and you can never receive a real SMS on it while that
entry exists — and you will spend an afternoon debugging a problem that is not
there.

### Sign in from a terminal

```bash
node tools/firebase-signin.js +918438098627 548723
```

```
  project : munim-1c4ee
  phone   : +918438098627
  firebase: signed in
  munim   : +918438098627
  business: Arul Enterprises
  status  : ready

  export TOKEN=acc_...
```

It reads the API key from `/v1/auth/config`, so nothing is duplicated in the
repo. Useful in CI and on a machine with no browser.

### Verified end to end on this project

| Step | Result |
|---|---|
| `sendVerificationCode` for the test number | `sessionInfo` returned, **no billing error, no reCAPTCHA** |
| `signInWithPhoneNumber` with the code | real ID token, `iss: securetoken.google.com/munim-1c4ee` |
| `POST /v1/auth/firebase` | Munim session issued, new account created |
| Naming the business | `Arul Enterprises`, onboarded |
| Reading another business's dashboard | **404** — tenant isolation holds |
| Signing in again with the same number | `isNewAccount: false` — same account, not a duplicate |

Note what the first row proves: **test numbers work without a billing
account.** Whether real numbers do on the Spark plan is still the open
question — see Step 1c.

---

## Switching between the two modes

```powershell
.\scripts\auth-mode.ps1 firebase   # real SMS
.\scripts\auth-mode.ps1 dev        # console OTP
.\scripts\auth-mode.ps1            # show current mode
```

It comments or uncomments the `ALLOW_DEV_OTP` lines in `apps/api/.env`.
Restart the API afterwards. Both apps follow whatever `/v1/auth/config` says, so
nothing needs rebuilding.

## Running before billing is enabled

Firebase is configured but cannot send an SMS until Blaze is on. Rather than a
login screen that always fails, set:

```bash
# apps/api/.env
ALLOW_DEV_OTP=1
OTP_FIXED_CODE=123456
```

The server then keeps the development OTP path open, reports
`provider: "dev-otp"` so both apps use it, and **shouts at boot**:

```
!! ALLOW_DEV_OTP=1 - the development OTP route is OPEN
!! despite Firebase being configured. NEVER ship this.
```

Delete those two lines the moment Blaze is enabled. A fixed code in production
means anyone owns every account.

## Mobile: phone sign-in in Expo Go

The obvious route — `@react-native-firebase/auth` — is **native code**, so Expo
Go cannot load it and you need a development build before you can log in once.

The app takes a different route that works today, with no build step:
`src/components/FirebasePhoneAuth.tsx` runs Firebase's **web** SDK inside a
WebView. `react-native-webview` ships in Expo Go, so scanning the QR is enough.

```
LoginScreen                WebView (Firebase web SDK)          your API
-----------                --------------------------          --------
number -> Send code
          opens modal  ->  signInWithPhoneNumber
                           invisible reCAPTCHA
                           user types the 6-digit code
                           getIdToken()
                      <--  postMessage { token }
                                                POST /v1/auth/firebase
                                                verify vs Google certs
                                            <-- your own session
```

**The trick that makes it work:** `baseUrl: 'http://localhost'` on the WebView
source. Firebase refuses reCAPTCHA from an unauthorised origin, and inline
WebView HTML otherwise has origin `about:blank`. Every Firebase project
authorises `localhost` by default, and `baseUrl` makes the document claim that
origin without fetching anything from a real localhost.

Two smaller things that are easy to miss:
- the WebView sends a **desktop-Chrome user agent**; reCAPTCHA refuses to run
  in a client that does not look like a browser
- Firebase's error codes (`auth/invalid-app-credential`) are for developers, so
  the page maps them to sentences a shop owner can act on

**This is not a security shortcut.** The WebView only produces a Firebase ID
token. The API still verifies it against Google's published certificates, so a
forged `postMessage` gets a 401.

### When to switch to a development build

The WebView is right for testing and early customers. Move to
`@react-native-firebase/auth` when you want **auto-reading the SMS code** and
Play Integrity instead of reCAPTCHA:

```bash
cd apps/mobile
corepack pnpm add @react-native-firebase/app @react-native-firebase/auth expo-dev-client
npx expo prebuild
npx eas build --profile development --platform android
```

You also need, from the Firebase console:
- an **Android app** registered with package `app.munim.mobile`
- `google-services.json` placed in `apps/mobile/`
- your **SHA-1** fingerprint added (EAS prints it during the build)

The API side needs no change either way: both post the same `idToken` to the
same `/v1/auth/firebase`.

---

## What it costs

| | |
|---|---|
### The "10,000 free" figure does not mean what people think

Firebase does advertise a large free tier — **50,000 monthly active users** on
Identity Platform (10,000 on the older plan). **That allowance is for
non-phone providers**: email, Google, anonymous. It does not cover SMS.

Phone verification is billed **separately, per message**, on top of MAU:

| | |
|---|---|
| Plan required | **Blaze** (billing account attached) |
| Free SMS | **10 per day** — not 10,000 per month |
| Per verification, India | **$0.01–$0.07** (~₹0.85–₹6). Sources disagree; check your own bill early |
| MAU free tier | 50,000 — **does not apply to SMS** |
| Test phone numbers | free, unlimited, never billed |
| DLT registration | Google's problem, not yours |

**10 SMS/day is roughly 300 a month.** That is genuinely enough while you are
testing and onboarding your first customers, and it costs nothing.

Past that, Firebase is expensive for India. At the high end of the quoted range
it is **~30× an Indian gateway**:

| 1,000 sign-ins/month | Cost |
|---|---|
| Firebase at $0.07 | ~₹6,000 |
| Firebase at $0.01 | ~₹850 |
| MSG91 / 2Factor | **~₹200** |

### So: use Firebase now, plan to move

1. **Today** — Blaze on, budget alert set. Under 10 sign-ins a day you pay
   nothing, and you are live immediately with no DLT wait.
2. **In parallel** — start MSG91's DLT registration. It takes 1–2 weeks of
   calendar time and nothing of yours; do it while Firebase carries you.
3. **When you pass ~300 sign-ins a month** — switch. It is one function,
   `firebaseSignIn` in `apps/api/src/routes/auth.js`.

Verify the real rate on your first bill rather than trusting any blog, this one
included. See [20-costs.md](20-costs.md).

---

## Verification: what is actually checked

`apps/api/src/lib/firebase.js`, and every rule has a test that forges a token
and confirms it is rejected:

| Check | Why |
|---|---|
| `alg` is exactly RS256 | Blocks `alg: none` and HMAC-confusion forgeries |
| Signature against Google's published cert for that `kid` | The actual proof |
| `aud` equals your project id | A token minted for another Firebase project is worthless here |
| `iss` is `securetoken.google.com/<project>` | Same reason |
| `exp` in the future, `iat` not in the future | Replay and clock-forgery |
| `sub` non-empty | No anonymous subject |
| Certificates cached to Google's own `max-age` | Key rotation still works; no fetch per sign-in |

```
$ node --test test/firebase.test.js
✔ accepts a genuine token and returns the phone number
✔ rejects a token signed with a different key
✔ rejects a token with a tampered payload
✔ rejects alg:none
✔ rejects HS256 (algorithm confusion)
✔ rejects an expired token
✔ rejects a token issued for another Firebase project
✔ rejects a wrong issuer
✔ rejects an unknown signing key id
✔ rejects a token with no subject
✔ rejects a token issued in the future
✔ rejects malformed input
✔ refuses to verify when no project id is configured
✔ a token without a phone number returns null rather than throwing
  14 pass, 0 fail
```

The client is told only *"that sign-in could not be verified"* — the specific
failure is logged server-side, because telling an attacker which check they
failed helps them.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `auth/operation-not-allowed` | Phone provider not enabled (Step 1.4) **or** the SMS region is blocked (Step 1b). The message mentions "region" in the second case |
| `auth/captcha-check-failed` | Domain missing from authorised domains — Step 2 |
| `auth/too-many-requests` | Firebase throttling. Use a test number |
| `auth/invalid-app-credential` | Android SHA-1 not registered in the console |
| `410 OTP_DISABLED` | Working as intended: Firebase is on, so the dev route is closed |
| `503 FIREBASE_NOT_CONFIGURED` | API cannot see `FIREBASE_PROJECT_ID` — restart it |
| `BILLING_NOT_ENABLED` | Blaze plan not enabled — Step 1c |
| Works locally, fails in production | Production domain not in authorised domains |
