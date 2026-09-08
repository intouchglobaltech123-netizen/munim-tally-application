# Munim

**Tally on your mobile. Real-time business insights, anywhere.**

Munim is a SaaS product that connects to a business's Tally Prime / Tally ERP 9
installation and mirrors that data to the cloud, so the owner can see sales,
receivables, payables, cash position and reports on their phone — and send
payment reminders over WhatsApp/SMS/Email.

> Category reference: Livekeeping, Biz Analyst, Tally on Mobile.

---

## The one-line technical truth

Tally runs on a desktop PC on a local network. It has **no cloud API**.
So a small **connector agent** installed on that PC reads Tally's built-in
HTTP-XML gateway (`localhost:9000`) and pushes changes to our cloud.
**The mobile app never talks to Tally.** It reads only our cloud.

That single design decision is why the app works when the shop PC is switched off.

---

## Repository map

```
munim/
├─ apps/
│  ├─ api/          NestJS backend — ingest, reports, auth, reminders, billing
│  ├─ web/          Next.js — web dashboard + marketing site
│  └─ mobile/       Expo React Native — the product users pay for  (BUILT)
├─ packages/
│  ├─ shared/       Zod schemas + TS types shared by api / web / mobile
│  └─ db/           Drizzle schema + SQL migrations
├─ connector/       Go — the Windows agent that reads Tally  (BUILT)
├─ mock-tally/      Emulates Tally's XML gateway on :9000     (BUILT)
├─ mock-cloud/      Multi-tenant dev API (auth, ingest, admin)  (BUILT)
├─ infra/           Docker Compose (dev) + Terraform (prod)
└─ docs/            👈 READ THIS FIRST. The full plan lives here.
```

---

## Read the docs in this order

| # | Doc | What it answers |
|---|---|---|
| 00 | [Start Here](docs/00-START-HERE.md) | How to use these docs, build order |
| 01 | [Product Scope](docs/01-product-scope.md) | What we build, what we deliberately don't |
| 02 | [Tech Stack](docs/02-tech-stack.md) | Every technology choice + the reason |
| 03 | [Architecture](docs/03-architecture.md) | How the pieces fit together |
| 04 | [Tally Sync Engine](docs/04-tally-sync-engine.md) | ⭐ The hardest and most important doc |
| 05 | [Database Schema](docs/05-database-schema.md) | Tables, indexes, partitioning, rollups |
| 06 | [API Contract](docs/06-api-contract.md) | Every endpoint, request/response shape |
| 07 | [Mobile App Spec](docs/07-mobile-app-spec.md) | Screens, navigation, offline behaviour |
| 08 | [Reminders](docs/08-reminders.md) | WhatsApp/SMS/Email engine |
| 09 | [Security](docs/09-security.md) | Multi-tenancy, tokens, encryption, RLS |
| 10 | [Performance](docs/10-performance.md) | The rules that keep it fast at 400k vouchers |
| 11 | [Infrastructure](docs/11-infrastructure.md) | Deployment, environments, cost |
| 12 | [Roadmap](docs/12-roadmap.md) | Phased plan, week by week |
| 13 | [Build Prompts](docs/13-build-prompts.md) | 👈 Copy-paste prompts for Antigravity |
| 14 | [Status](docs/14-status.md) | What is actually built vs. still scaffold |
| 15 | [Installer & Pairing](docs/15-installer.md) | The .exe, the checks, the QR wizard |
| 16 | [The Four Surfaces](docs/16-product-surfaces.md) | Connector, mobile, web, admin — who each is for |
| 17 | [How to Run It](docs/17-running.md) | 👈 Real Tally, sign the exe, the full journey |
| 18 | [Authentication](docs/18-authentication.md) | Phone login that costs ₹0 to run |
| 19 | [Tally Setup](docs/19-tally-setup.md) | Turn on the gateway, create a company, add test data |
| 20 | [What It Costs](docs/20-costs.md) | ₹900/year to 200 customers — the full breakdown |
| 21 | [Feature Set](docs/21-features.md) | Every metric and report, matched to Livekeeping |
| 22 | [Firebase sign-in](docs/22-firebase.md) | Real SMS auth, free to 10k/month |

---

## Status

**P0 (sync engine) is built and verified.** Everything else is scaffold.
See [docs/14-status.md](docs/14-status.md) for exactly what is real.

```powershell
# one time
corepack pnpm install
powershell -ExecutionPolicy Bypass -File .\scripts\dev-sign.ps1   # Windows blocks unsigned exes

# every day
node mock-cloud\src\index.js                     # API on :8080
corepack pnpm --filter web dev                    # web on :3000
.\connector\dist\Munim.exe setup                 # link this Tally PC
```

Sign in with your mobile number, name your business, scan the connector's QR.
No demo data. Full guide: [docs/17-running.md](docs/17-running.md).
Next up is P1: make `POST /v1/ingest` actually store what the connector already
produces. Build order: [docs/12-roadmap.md](docs/12-roadmap.md),
prompts: [docs/13-build-prompts.md](docs/13-build-prompts.md).
