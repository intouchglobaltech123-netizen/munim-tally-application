# infra — Local dev & production infrastructure

Not built yet. Spec: [docs/11-infrastructure.md](../docs/11-infrastructure.md).

## Planned
```
infra/
├─ docker-compose.yml      postgres:17, redis:7, minio, mock-tally
├─ terraform/              ECS Fargate, RDS Multi-AZ, ElastiCache, ALB,
│                          Secrets Manager, R2 bindings — ap-south-1
└─ runbooks/               the 5 operational runbooks from doc 11
```

Region is **ap-south-1 (Mumbai)** — accounting data stays in India, and saying so
removes a real sales objection.

Split `api` and `worker` into separate ECS services from day one: a stuck
reminder job must never take down the API.

Build with prompt 10 in [docs/13-build-prompts.md](../docs/13-build-prompts.md).
