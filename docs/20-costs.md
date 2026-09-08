# 20 — What It Costs to Run

Real numbers for running Munim, from your first customer to a thousand.

Rupee figures use ~₹85 = $1. Cloud pricing changes; re-check before you commit
to anything. Everything marked **free** below is a published free tier, not a
trial.

---

## The short answer

| Customers | Infrastructure | Per year |
|---|---|---|
| **1 – 10** | Oracle Always Free + Cloudflare R2 free | **₹900** (domain only) |
| 10 – 200 | Same | **₹900** |
| 200 – 500 | One paid VPS + managed backups | ₹18,000 – 30,000 |
| 500 – 2,000 | API and database on separate boxes | ₹60,000 – 110,000 |

**For 10 users your only unavoidable cost is a domain name — about ₹900 a
year.** Everything else genuinely fits inside free tiers.

At ₹3,000–6,000 per company per year, 10 customers is ₹30,000–60,000 of
revenue against ₹900 of cost.

---

## The ₹0 stack

| Piece | Service | Free allowance | What actually limits you |
|---|---|---|---|
| **Server** | Oracle Cloud **Always Free** (Ampere A1) | 4 ARM cores, **24 GB RAM**, 200 GB block storage, 10 TB egress/month | Nothing, for a long time. See below |
| **Database** | PostgreSQL **on that same box** | — | Disk: 200 GB |
| **Cache/queue** | Redis on the same box | — | RAM, and you have 24 GB |
| **File storage** | Cloudflare **R2** | 10 GB stored, **zero egress**, 1M writes + 10M reads/month | 10 GB — that is backups, not customer data |
| **Phone login** | Firebase Auth | **none — Blaze plan required since Sept 2024** | Billed per SMS; set a budget alert |
| **Email** | Amazon SES / Resend | 3,000/month free (Resend) | Fine for receipts and alerts |
| **Code hosting + CI** | GitHub | Free for public, 2,000 CI minutes for private | CI minutes, eventually |
| **Error tracking** | Sentry | 5,000 errors/month | Fine unless something is badly broken |
| **Uptime alerts** | UptimeRobot | 50 monitors | Fine |
| **Domain** | any registrar | — | **₹700–900/year. The only real cost** |

### Why one free box is genuinely enough

24 GB of RAM and 4 cores is not a toy. Your workload is unusually light:

- each connector sends **one small batch every 30 seconds**
- dashboards read pre-computed rollups, never raw vouchers
- there is no video, no image processing, no ML

A connector's steady-state traffic is a few KB per minute. Ten of them is
nothing. Two hundred of them is still nothing.

---

## How long does free actually last?

Storage is the binding constraint, not CPU or RAM.

### Storage per customer

| Company size | Vouchers | With `raw` JSONB kept | Without |
|---|---|---|---|
| Small shop, 2 years | ~20,000 | ~60 MB | ~15 MB |
| Medium, 5 years | ~150,000 | ~450 MB | ~90 MB |
| Large, 5 years | ~400,000 | ~1.2 GB | ~230 MB |

Assume an average of **~300 MB per customer** while you keep raw payloads.

### So:

```
200 GB usable
  minus ~20 GB for OS, Postgres overhead, indexes, logs
  = ~180 GB for customer data

180 GB / 300 MB  ≈  600 customers
```

**Free tier holds roughly 500–600 customers on storage.** RAM and CPU will
start needing attention somewhere around 200–400, mostly because Postgres wants
more shared buffers as the working set grows.

Realistically: **you will not pay for infrastructure until a few hundred paying
customers**, by which point you have ₹10–20 lakh of annual revenue.

Dropping `raw` JSONB once your Tally field mapping is stable cuts storage about
5×, pushing that ceiling past 2,000 customers. Keep it until then — it is how
you backfill a field you forgot to map without asking every customer to re-sync
five years of books (see [05-database-schema.md](05-database-schema.md)).

---

## Three Oracle gotchas — read before you rely on it

**1. Idle instances get reclaimed.** Oracle reclaims Always Free *compute* that
sits idle (roughly: under 10% CPU, low network, for 7 days). A live connector
polling every 30 seconds plus a database keeps you above that easily — but a
box you set up and leave empty for a fortnight can be taken back. Do not
provision it until you are actually using it.

**2. ARM capacity is often unavailable.** "Out of capacity" in Mumbai is common.
Retry, try Hyderabad, or script the retry. This is the single most annoying part
of Oracle's free tier.

**3. Signup needs a card.** A small authorisation hold, nothing charged. Keep
the account on **Always Free** and do not upgrade to Pay As You Go unless you
mean it — upgrading changes which resources are free.

> If Oracle blocks you: **Hetzner** is €4–5/month (~₹400) for something similar
> but hosted in Europe, which weakens your "your data stays in India" line.
> Within India, the cheapest credible VPS is ₹800–1,200/month.

---

## Costs that are NOT infrastructure

These scale with customers and usage. Bill them through.

### WhatsApp reminders

| | |
|---|---|
| Meta utility conversation (India) | roughly **₹0.11–0.15 per message** |
| 10 customers sending 100 reminders/month each | ~₹150/month |
| Charge model | **Credits, prepaid.** Never "unlimited" |

This is the one cost that grows with usage. One enthusiastic customer chasing
500 invoices a month costs you ~₹70. Sell credits at a markup and it becomes
revenue instead of a leak.

### SMS OTP — avoid paying for it

| Route | Cost | Reality |
|---|---|---|
| **Firebase + Blaze** | **10 SMS/day free**, then ~₹0.85–6 each | Needs a card. No DLT wait — best way to *start* |
| MSG91 / 2Factor | ~₹0.20/SMS prepaid | **1–2 weeks DLT registration**. Several times cheaper at volume |
| Firebase test numbers | free, unlimited | Pre-registered numbers only — development and demos |

Firebase's advertised 50,000-MAU free tier is for **non-phone** providers; SMS
is billed on top. Start on Firebase (10/day covers early onboarding), begin DLT
registration in parallel, and switch at roughly 300 sign-ins a month. See
[18-authentication.md](18-authentication.md).

### Payments

| | |
|---|---|
| Razorpay | **2% + 18% GST** ≈ 2.36% per transaction |
| On ₹5,000/year subscription | ~₹118 per customer per year |
| Setup / monthly fee | ₹0 |

At 10 customers that is ~₹1,200/year — more than your server costs. That is
normal and unavoidable.

---

## Costs people forget

| Item | Cost | When |
|---|---|---|
| **Domain** | ₹700–900/year | Day one. Unavoidable |
| **Code signing certificate** | ₹0 → ₹50,000/year | Only when you ship the `.exe`. The PowerShell connector avoids it entirely — see [17-running.md](17-running.md) |
| Google Play developer | **₹2,100 once** | Before Android release |
| Apple developer | **₹8,500/year** | Only if you do iOS |
| Microsoft Store (optional) | ₹1,700 once | If you distribute the connector via Store |
| Backup egress | **₹0 on R2** | This is why R2, not S3 — S3 egress on restores gets expensive |
| GST registration / accounting | varies | Once you invoice customers |

**Realistic year-one total, 10 customers, Android only:**

```
domain                          900
Play developer (one time)     2,100
Razorpay fees (~10 subs)      1,200
WhatsApp credits (passed on)      0   (billed to customers)
servers, database, storage         0
                             ------
                              4,200  for the year
```

Against ₹30,000–60,000 of revenue.

---

## When each free tier breaks, and what to do

| Signal | What it means | Do this |
|---|---|---|
| Disk above 70% of 200 GB | ~400+ customers | Drop `raw` JSONB older than 24 months, or attach a paid volume (~₹200/mo for 100 GB) |
| Postgres CPU sustained >70% | Working set outgrew RAM | Move Postgres to its own box (₹1,200/mo) |
| R2 above 10 GB | Backups grew | ₹1.30/GB/month after that. 50 GB ≈ ₹65/month |
| Firebase SMS spend rising | more sign-ins | Budget alert should catch it. Consider prepaid MSG91 |
| Sentry >5k errors/mo | Something is genuinely wrong | Fix the errors before paying for more |

Move to the next tier when a **real signal** says so — not on a schedule, and
not because a diagram in [11-infrastructure.md](11-infrastructure.md) shows a
bigger architecture. That AWS topology is the destination, not the starting
point.

---

## Unit economics

| | Per customer per year |
|---|---|
| Revenue | ₹3,000 – 6,000 |
| Infrastructure | ₹60 – 180 (₹5–15/month) |
| Payment gateway | ~₹118 |
| WhatsApp | passed through as credits |
| **Gross margin** | **~95%** |

Your real costs in year one are your time and a domain. That is the whole point
of picking this stack: nothing stops you shipping, and nothing bills you before
you have customers.
