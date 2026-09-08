# 00 — Start Here

## What this folder is

The complete plan for building Munim. **No code yet, by design.**
You will build the code with Antigravity, using these docs as the spec.

## How to use these docs with Antigravity

1. Open the `munim/` folder as your workspace.
2. Point the agent at the relevant doc before asking it to build.
   Good: *"Read docs/04-tally-sync-engine.md and docs/05-database-schema.md,
   then implement the connector's Tally client in connector/internal/tally/."*
   Bad: *"Build a Tally app."*
3. Build **one phase at a time**, in the order in `12-roadmap.md`.
   Do not let the agent scaffold all four apps on day one — you will get
   4 half-working things instead of 1 working thing.
4. Ready-made prompts are in `13-build-prompts.md`.

## The golden rule

> **Get the connector talking to a real Tally installation before you write
> a single line of UI.**

Everything else in this product is ordinary CRUD. The Tally sync is the
only genuinely hard part, and it is where every competitor's bugs live.
If sync is wrong, no UI saves you. If sync is right, the rest is easy.

## What you need before you start

| Requirement | Why |
|---|---|
| A Windows PC with **Tally Prime** installed | Cannot develop the connector blind |
| A second copy of **Tally ERP 9** (ideally) | The XML differs; ~30% of Indian SMBs still run it |
| Sample company data with 2+ years of vouchers | Empty Tally hides every performance problem |
| Meta WhatsApp Business account | Template approval takes 1–2 weeks — **apply early** |
| Razorpay account | KYC takes days — apply early |

Two of those have multi-week external lead times. Start them in week 1,
not week 12.

## Definition of done for the MVP

A shopkeeper can:
1. Install one `.exe` on the Tally PC and pair it with a 6-digit code.
2. Open the phone app and see today's sales, receivables, payables, cash.
3. Tap a customer and see their pending bills with aging.
4. Send that customer a WhatsApp payment reminder in two taps.
5. Close Tally and shut down the PC — and the app still shows all of it.

Anything beyond those five things is **not MVP**.
