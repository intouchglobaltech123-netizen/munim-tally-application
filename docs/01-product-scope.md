# 01 — Product Scope

## Who this is for

Indian SMB owners (₹1–50 crore turnover) who run their books in Tally, whose
accountant sits at one desktop, and who currently have to phone that accountant
to ask "how much is that customer owing us?"

Their real problems, in the order they feel them:

1. **"Who owes me money?"** — cash flow is the daily anxiety.
2. **"Chasing payments is awkward and slow."**
3. **"I can't see my business when I'm travelling."**
4. **"My data lives on one PC and it could die tomorrow."**

Every module below maps to one of those four.

---

## Modules

| # | Module | Solves | MVP? |
|---|---|---|---|
| 1 | **Tally sync engine** | Everything depends on it | ✅ Yes |
| 2 | **Dashboard** — sales, receivables, payables, cash | #3 | ✅ Yes |
| 3 | **Outstanding + aging** — bill-wise, per party | #1 | ✅ Yes |
| 4 | **Payment reminders** — WhatsApp / SMS / Email | #2 | ✅ Yes |
| 5 | **Ledger drilldown** — statement per party | #1 | ✅ Yes |
| 6 | **Cloud backup** — nightly company file to object storage | #4 | ⬜ P4 |
| 7 | **Reports** — top items, inactive customers, sales analysis | #3 | ⬜ P4 |
| 8 | **Multi-user + roles** — owner, accountant, salesman | — | ⬜ P4 |
| 9 | **Billing & subscriptions** | Revenue | ⬜ P5 |
| 10 | **Stock / inventory view** | — | ⬜ Post-MVP |
| 11 | **GST summary (GSTR-1/3B style)** | — | ⬜ Post-MVP |

---

## Deliberately NOT building

Saying no is how this ships in 4 months instead of 18.

| Not building | Why |
|---|---|
| **Writing data back into Tally** | Huge trust and liability risk. Read-only is a *sales advantage* — say it on the pricing page |
| Full invoicing / billing app | That is a different product (Vyapar's category), not Tally-companion |
| E-way bill / e-invoice generation | Regulated, complex, needs GSP partnership. Phase 3 of the company, not the MVP |
| Desktop app | The whole pitch is "on mobile". Web dashboard covers desktop |
| Offline-first *editing* | Read-only cache is enough. Two-way offline sync is months of work |
| Custom report builder | Sounds great in a demo, used by <2% of users |
| Multi-language UI at launch | English + Hindi labels only. Add Gujarati/Tamil after PMF |

---

## Pricing shape (plan for it in the schema now)

- Per **company** (Tally company), per year — not per user. Owners add family members freely; you charge for books.
- Free 14-day trial, no card.
- Tiers by feature: Basic (dashboard + outstanding) → Pro (+ reminders + reports) → Business (+ multi-user + backup).
- **WhatsApp messages billed as credits**, passed through at a markup. This is a real per-message cost — never bundle it as unlimited.

Schema implication: `orgs.plan`, `orgs.trial_ends_at`, `subscriptions`, and a
`message_credits` ledger must exist from day one, even if unused in MVP.

---

## What makes this win against incumbents

The screenshot comparison writes the marketing copy for you:

1. **True incremental sync** (ALTERID cursor), not scheduled full re-imports.
2. **Free cloud backup** included, not a plan upsell.
3. **Reminders on WhatsApp**, which is the channel Indian SMBs actually use.
4. **Simple UI** — one screen answers "how is my business today".

Those are all engineering decisions, not marketing decisions. They are
specified in docs 04, 08 and 10.
