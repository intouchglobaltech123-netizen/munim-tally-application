# 11 — Infrastructure & Deployment

Region: **AWS ap-south-1 (Mumbai)** — accounting data stays in India.

---

## Environments

| Env | Runs on | Data | Purpose |
|---|---|---|---|
| `local` | Docker Compose | Synthetic seed + **mock Tally on :9000** | Everyday development |
| `staging` | 1× small instance, RDS t4g.micro | Anonymised | Pre-release verification |
| `prod` | ECS Fargate ×2, RDS Multi-AZ | Real | Customers |

### Local Docker Compose services
```
postgres:17        redis:7        api (watch mode)
mock-tally:9000    minio (R2-compatible S3 for local files)
```
The mock Tally server means anyone can develop the whole product on Linux/macOS
without a Windows PC. Build it in P0.

---

## Production topology (launch size)

```
Route53 → ACM/TLS → ALB
                     ├── ECS Fargate: api        (2 tasks, autoscale on CPU+queue depth)
                     └── ECS Fargate: worker     (1–2 tasks: rollups, reminders, reconcile)
RDS PostgreSQL 17 Multi-AZ (db.t4g.small → m7g.large as you grow) + PgBouncer
ElastiCache Redis (cache.t4g.micro)
Cloudflare R2 — backups, invoice PDFs, connector installers
Secrets Manager · CloudWatch alarms · Sentry · Grafana Cloud (OTel)
```

Split **api** and **worker** as separate task definitions from day one. A stuck
reminder job must never take down the API.

---

## CI/CD (GitHub Actions)

```
PR:      lint · typecheck · unit tests · go test · migration dry-run · gitleaks
main:    build images → push ECR → migrate → rolling deploy staging → smoke tests
tag v*:  deploy prod (manual approval) 
         + build & sign connector .exe (windows/amd64 + 386) → upload to R2
         + EAS build + submit mobile
```

**Migrations run as a separate step before the app rolls**, and must be
backward-compatible for one release so old and new tasks coexist safely.

---

## Connector distribution

- Inno Setup installer wrapping the signed Go binary; installs as a Windows
  service + tray icon; auto-start on boot.
- Hosted on R2 at a stable URL: `https://dl.munim.app/connector/latest.exe`
- **Signed auto-update**: heartbeat returns an update command → connector
  downloads, verifies Ed25519 signature, swaps binary, restarts service.
- Keep the previous two versions downloadable for rollback.
- Publish a version-adoption dashboard — you need to know how many customers run
  the buggy build you shipped last Tuesday.

---

## Observability

| Signal | Tool | Alert when |
|---|---|---|
| API errors | Sentry | Error rate > 1% for 5 min |
| Ingest lag | Custom metric | p95 connector `last_seen` > 15 min |
| Queue depth | BullMQ → CloudWatch | Reminder queue > 1,000 or stalled |
| DB | RDS Performance Insights | CPU > 70%, connections > 80% |
| Connector fleet | Heartbeat aggregate | > 5% of connectors unhealthy |
| WhatsApp | Provider webhook stats | Delivery rate < 90%, quality rating drop |
| Cost | AWS Budgets | Monthly spend > threshold |

**Connector health is your most important business metric.** If sync silently
breaks for a customer, they experience a dead product and churn without ever
filing a ticket.

---

## Cost estimate

> Full breakdown with free-tier limits, per-message costs and the
> forgotten items: **[20-costs.md](20-costs.md)**.

### Start here: the zero-budget path

The AWS topology above is the *destination*, not the starting point. Paying for
Multi-AZ RDS before product-market fit is how a bootstrapped product dies. Run
everything on one box until something actually breaks.

| Piece | Free option | Ceiling |
|---|---|---|
| **Server** | **Oracle Cloud Always Free** — 4 ARM cores, 24 GB RAM, 200 GB, Mumbai/Hyderabad | Free forever; API + Postgres + Redis together to ~200 users |
| Postgres (alt) | Neon free | 0.5 GB — one large customer fills it |
| Redis (alt) | Upstash free | 10k commands/day |
| Backups / files | Cloudflare R2 free | 10 GB, zero egress |
| Domain | — | ₹700–900/yr — the only unavoidable cost |

Caveats worth knowing before you rely on it: Oracle signup needs a card for
verification (nothing is charged), and ARM capacity in Mumbai is intermittently
unavailable — retry, or use Hyderabad.

### What one customer costs

Storage is the binding constraint, not CPU. A connector sends one small batch
every 30 seconds; that is nothing. Storage per company:

| Company | Vouchers | With `raw` JSONB | Without |
|---|---|---|---|
| Small shop, 2 years | ~20k | ~60 MB | ~15 MB |
| Medium, 5 years | ~150k | ~450 MB | ~90 MB |
| Large, 5 years | ~400k | ~1.2 GB | ~230 MB |

Marginal cost per customer at small scale: **₹5–15/month**. Against ₹3,000–6,000
per company per year, infrastructure margin is above 95%. Dropping `raw` JSONB
once field mapping is stable cuts storage roughly 5x — but keep it until then
(see doc 05 for why).

### Scaling up

| Users | Setup | ₹/month |
|---|---|---|
| 1–50 | Oracle Always Free | **0** |
| 50–200 | Same + R2 backups | 0–300 |
| 200–500 | One ₹800–1,200 VPS (Hostinger / DigitalOcean Mumbai) + managed backups | 1,500–2,500 |
| 500–2,000 | API and DB on separate boxes, PgBouncer | 5,000–9,000 |
| 2,000+ | The AWS topology above: ECS + RDS Multi-AZ | 25,000+ |

Move to the next row when a real signal says so — DB CPU sustained above 70%,
or a restore you cannot afford to get wrong. Not before.

### Messaging is separate and passed through

WhatsApp utility conversations and SMS are per-message costs billed to the
customer as credits (doc 08). They are not infrastructure and must never be
bundled as unlimited.

---

## Runbooks to write before launch

1. A customer's sync is stuck → how to diagnose (heartbeat, cursors, spool) and
   how to trigger a remote full resync.
2. AlterID regression detected → resync procedure.
3. WhatsApp number quality dropped → throttle, review templates, appeal.
4. DB restore from PITR → step-by-step, rehearsed at least once.
5. Rollback a bad connector release → serve previous version, force-update.
