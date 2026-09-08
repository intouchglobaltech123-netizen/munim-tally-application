# 18 — Authentication: cheap, but real

Phone number is the identity. Indian shop owners will not manage a password,
and the mobile number is what the WhatsApp reminders go to anyway.

The problem: **sending an SMS costs money, and in India it also costs weeks.**

---

## What SMS OTP actually costs you

| Item | Reality |
|---|---|
| DLT registration (TRAI mandate) | **1–2 weeks**, needs company documents. Without it no transactional SMS is delivered at all |
| Per SMS (MSG91 / equivalent) | ~₹0.15–0.25 |
| Sender ID + template approval | Another few days, per template |

At 500 sign-ins a month that is under ₹150 — trivially cheap. The killer is not
the money, it is that **DLT blocks you for two weeks before you can log a single
user in**, including yourself.

---

## The zero-rupee option that is also better

**Firebase Authentication — phone sign-in.**

| | |
|---|---|
| Cost | **Blaze plan required** (billing account). Billed per SMS |
| DLT | **Google's problem, not yours.** No registration, no template approval |
| Time to working login | An afternoon |
| Web + Android + iOS | One SDK each, all first-party |
| Bot abuse | reCAPTCHA / Play Integrity built in |

**Correction to an earlier draft of this doc.** Two things were wrong:

1. Phone sign-in has needed the **Blaze plan** since September 2024. The Spark
   plan returns `BILLING_NOT_ENABLED`.
2. Firebase's advertised free tier — 50,000 MAU (10,000 on the older plan) — is
   for **non-phone** providers. SMS is billed separately, per message. The free
   SMS allowance is **10 per day**, not 10,000 per month.

At India rates ($0.01–$0.07 per verification) Firebase can be **several times**
an Indian gateway. It is the right choice to *start* — 10/day covers early
onboarding at no cost, with no DLT wait — but plan to move to MSG91 once you
pass roughly 300 sign-ins a month.

The trade: you depend on Google, and the phone number lives in Firebase as well
as your database. For an SMB accounting product that is an acceptable trade at
this stage — and it is reversible, because the only thing your backend needs is
*"this request proves ownership of +91XXXXXXXXXX"*.

### How it plugs in without lock-in

Keep your own session. Firebase only proves the phone number:

```
app / web                       your API
─────────                       ────────
Firebase phone sign-in
  → Firebase ID token   ──POST /v1/auth/firebase──►  verify token with
                                                     Firebase Admin SDK
                                                     ↓
                                                     phone → find/create user
                                                     ↓
                                              ◄──  your own access + refresh
```

Your API still issues your own tokens, so every route, role check and tenant
guard is unchanged. Swapping Firebase for MSG91 later means rewriting **one
endpoint**.

That is why the dev API keeps auth behind a single seam:

| Provider | Where | Use |
|---|---|---|
| `console` | prints the OTP to the terminal | development (today) |
| `firebase` | verify ID token | launch |
| `msg91` | DLT SMS | past ~300 sign-ins/month, where it is several times cheaper |

---

## What NOT to do

| Idea | Why not |
|---|---|
| Email + password | Shop owners will not use it. Password reset becomes your support load |
| WhatsApp OTP | Costs *more* than SMS per message, and needs the same Meta approval as reminders |
| "Just trust the device" — no auth | Accounting data. One shared phone and a customer sees another's books |
| Hardcoded OTP in production | `123456` is a **development** shortcut. Ship it and anyone owns every account |

> The `123456` OTP in `mock-cloud` exists so the demo is reproducible. It is
> gated on the dev provider and must never reach production. Make that a
> release checklist item.

---

## Rate limits — needed on day one

SMS costs real money, so an unthrottled OTP endpoint is a way for a stranger to
spend your balance:

| Limit | Value |
|---|---|
| Per phone number | 3 requests / 10 minutes |
| Per IP | 20 requests / hour |
| Verification attempts | 5 per request, then invalidate |
| OTP lifetime | 5 minutes |

Firebase enforces its own quotas too, but do not rely on someone else's limits
to protect your bill.

---

## The pairing flow needs no SMS at all

Worth noticing: **linking a Tally PC costs nothing.** The computer shows a QR;
the already-signed-in phone approves it. No second OTP, no SMS, and the PC never
touches the owner's phone number or any credential of theirs.

That was a UX decision first, but it is also why authentication cost scales with
*customers*, not with *machines*. A customer with three shop computers still
costs one verification.
