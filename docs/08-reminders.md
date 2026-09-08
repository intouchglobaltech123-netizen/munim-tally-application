# 08 — Payment Reminders

The highest willingness-to-pay module. Also the one that gets you banned by Meta
if built carelessly.

---

## Channels

| Channel | Provider | Cost shape | Use for |
|---|---|---|---|
| **WhatsApp** | Meta Cloud API | Per 24 h conversation | Primary — this is where Indian SMBs live |
| **SMS** | MSG91 (DLT-registered) | Per message | Fallback when WhatsApp fails/no WA |
| **Email** | Amazon SES | Negligible | Statement attachments, B2B customers |

---

## WhatsApp rules you cannot design around

1. **Business-initiated messages must use a pre-approved template.** You cannot
   send free-form text to someone who has not messaged you in the last 24 h.
2. Template approval takes days. **Submit templates in week 1**, not week 12.
3. Templates support variables only — `{{1}}`, `{{2}}` — no arbitrary layout.
4. Quality rating: too many blocks/reports and your number is throttled or
   banned. **Rate-limit, cap per party per week, and honour opt-outs.**
5. Recipients must have opted in. Record consent (`ledger.wa_opt_in`, source,
   timestamp) — Meta can ask for it.

### Starter templates (submit these)

```
payment_due_v1     (utility)
  Hello {{1}}, this is a payment reminder from {{2}}.
  Invoice {{3}} dated {{4}} for ₹{{5}} is pending.
  Kindly arrange the payment. Thank you.

payment_overdue_v1 (utility)
  Hello {{1}}, invoice {{2}} for ₹{{3}} is overdue by {{4}} days.
  Please clear at your earliest convenience. — {{5}}

statement_share_v1 (utility, with document header)
  Hello {{1}}, please find your account statement from {{2}}
  as on {{3}}. Closing balance: ₹{{4}}.
```

Keep templates in `packages/shared/templates.ts` with their approved variable
order — a mismatch between your call and the approved template is rejected at
send time, not at build time.

---

## Engine design

```
BullMQ repeatable job per org, business days at reminder_rules.send_at
  │
  ├─ load rules  → days_after_due [7,15,30], channels, template
  ├─ select bills WHERE pending_amt > 0
  │                AND due_date + rule_day = today
  │                AND party has phone AND wa_opt_in
  ├─ suppress: already reminded for this bill+rule, party muted,
  │            org out of credits, party paid since
  ├─ group by party → ONE message per party (never one per invoice)
  └─ enqueue send jobs on a rate-limited queue
        worker → provider API → store provider_msg_id → status=sent
        webhook → delivered / read / failed → update row, retry via SMS on fail
```

**Group by party.** Sending five WhatsApps to one customer for five invoices is
the fastest way to get reported as spam and lose the number.

---

## Guardrails (build these on day one, not after an incident)

| Guardrail | Rule |
|---|---|
| Frequency cap | Max 1 reminder per party per 7 days, per company |
| Quiet hours | Send only 09:00–19:00 IST, business days |
| Opt-out | "Reply STOP" honoured → `wa_opt_in = false`, permanent |
| Credit check | Block send when `message_credits.balance <= 0`, surface in app |
| Dry-run mode | Owner can preview the exact message before enabling automation |
| Kill switch | One env flag halts all outbound sends across the platform |
| Test mode | Staging sends only to a whitelist of internal numbers |

---

## Manual send (MVP path)

Automation is P3. But **manual send ships in P2** because it is trivially useful:
owner opens a party → taps Remind → sees the message → confirms → sent.
That single flow is often what converts the trial.

---

## Metrics to track

- Delivery rate, read rate per template
- **Days-to-payment with vs without a reminder** — this is the ROI number that
  goes on your pricing page and into renewal conversations
- Opt-out rate (watch it; > 2% means your copy or frequency is wrong)
- Credits consumed per org per month (drives pricing)
