# 02 — Tech Stack

One choice per slot. Each has the reason, and the alternative that was rejected.

---

## Decision table

| Layer | Choice | Why this | Rejected |
|---|---|---|---|
| **Connector** | **Go 1.23** | Single ~12 MB `.exe`, **zero runtime to install** on the customer's PC. Install friction is your #1 churn cause | .NET (needs framework), Node (80 MB bundle), Python (nightmare to package) |
| **Backend** | **NestJS + Fastify adapter** (TypeScript) | Modular monolith. Structure without microservice pain. Same language as web + mobile | Express (no structure at scale), Go (slower to build CRUD), Django (splits your language) |
| **Database** | **PostgreSQL 17** | Partitioning, JSONB for raw Tally payloads, materialized views, RLS for tenant isolation. One DB does all of it | MongoDB (accounting data is relational — this is not a debate), MySQL (weaker partitioning + JSON) |
| **ORM** | **Drizzle ORM** | Typed SQL, no hidden N+1, trivially drop to raw SQL for report aggregates | Prisma (fights you on complex aggregates, heavy runtime), TypeORM (unmaintained feel) |
| **Queue + cache** | **Redis 7 + BullMQ** | Reminder scheduling, retries with backoff, rate-limited WhatsApp sends, dashboard cache | RabbitMQ (extra infra for no gain), SQS (worse local dev) |
| **Mobile** | **React Native + Expo (EAS)** | One codebase iOS+Android, and **OTA updates** — ship a fix in minutes without app-store review. For a SaaS whose bugs are customer-data-specific this is decisive | Flutter (great, but Dart splits your language and no shared types), native ×2 (2× the work) |
| **Web** | **Next.js 15 (App Router)** | Dashboard + marketing site + SEO in one app, shares types with the API | Vite SPA (no SEO for marketing), Remix (smaller ecosystem) |
| **Object storage** | **Cloudflare R2** | S3-compatible API, **zero egress fees**. Backups are download-heavy — S3 egress would quietly become your biggest bill | AWS S3 (egress cost), local disk (no) |
| **Auth** | Phone OTP (MSG91) + JWT access/refresh | Indian SMB users will not manage passwords. Phone is the identity | Email/password (bad fit), Auth0 (expensive per MAU, overkill) |
| **WhatsApp** | **Meta Cloud API** (direct) | Cheapest per conversation at scale; full template control | Gupshup/Twilio (easier start, ~2× cost — fine as a fallback provider) |
| **SMS** | MSG91 | Cheapest reliable India DLT-compliant sender | Twilio (expensive in India) |
| **Email** | Amazon SES | ₹ per 1000 emails, negligible | SendGrid (fine, pricier) |
| **Payments** | **Razorpay Subscriptions** | UPI AutoPay mandates — the only way Indian SMBs actually renew | Stripe (limited India recurring support) |
| **Monorepo** | **pnpm workspaces + Turborepo** | Shared types across api/web/mobile; Go connector lives as a sibling folder outside the JS workspace | npm workspaces (slower), Nx (heavier than needed) |
| **Validation** | **Zod**, in `packages/shared` | One schema defines API contract, DB insert shape, and mobile form validation | Manual DTOs (drift), class-validator (Nest-only, unusable in RN) |
| **Testing** | Vitest (TS), `go test` (Go), Playwright (web E2E) | Fast, standard | Jest (slower) |
| **Errors** | **Sentry** (api + mobile + connector) | Connector crashes on a customer's PC are otherwise completely invisible to you | Logs only (you will never see them) |
| **Metrics/logs** | OpenTelemetry → Grafana Cloud free tier | One standard, portable later | Datadog (expensive early) |
| **CI/CD** | GitHub Actions | Build Go binaries for Windows, run migrations, EAS build for mobile | — |
| **Cloud** | **AWS ap-south-1 (Mumbai)** | Accounting data — keep it in India. Latency to customers matters | Any non-India region (data residency objections in sales calls) |

---

## Version pinning

```
Go            1.23.x
Node          22 LTS
PostgreSQL    17
Redis         7.4
React Native  via Expo SDK 54
```

---

## Third-party lead times — start these in WEEK 1

| Item | Lead time | Blocks |
|---|---|---|
| Meta WhatsApp Business + template approval | 1–3 weeks | Reminders module (P3) |
| MSG91 DLT registration (SMS templates) | 1–2 weeks | OTP login (P2!) |
| Razorpay KYC | 3–10 days | Billing (P5) |
| Apple Developer + Google Play accounts | 1–7 days | Any real device testing |
| Code-signing certificate for the `.exe` | 3–7 days | Windows SmartScreen will block an unsigned installer |

**MSG91 DLT blocks OTP login, which blocks the entire mobile app.**
Apply on day one or your P2 slips.
