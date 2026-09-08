# packages/db — Drizzle schema & migrations

Not built yet. Spec: [docs/05-database-schema.md](../../docs/05-database-schema.md).

Contains:
- Drizzle table definitions for all tables
- SQL migrations (checked in, never edited after merge)
- `vouchers` FY partitioning + a job to create next year's partition
- RLS policies for every tenant table
- **Seeder**: a synthetic company with 400k vouchers / 5k parties for load tests

Migration rule: each migration must be backward-compatible for one release, so
old and new API tasks can run against it during a rolling deploy.

Build with prompt 3 in [docs/13-build-prompts.md](../../docs/13-build-prompts.md).
