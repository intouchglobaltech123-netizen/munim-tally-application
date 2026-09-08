# 09 — Security

You are holding other companies' complete accounting books. A breach does not
mean a bad week — it means the product is over. Treat this doc as requirements,
not suggestions.

---

## Threat model

| Threat | Control |
|---|---|
| Cross-tenant data leak (one bad query) | `org_id` filter in app code **+ Postgres RLS as a second net** |
| Stolen device token from a customer PC | Tokens are per-connector, hashed at rest, revocable from the app, scoped to ingest only |
| Attacker on customer LAN reaching Tally :9000 | Connector binds to `localhost` only; document that the port must not be firewall-forwarded |
| Stolen phone | Short-lived access JWT (15 min) + refresh rotation + remote session revoke |
| Malicious/compromised backup file | Client-side encryption per org before upload; server never sees plaintext keys |
| Employee (yours) browsing customer data | Audit log on every data export + admin access; no prod DB shell for engineers by default |
| OTP brute force / SMS pumping | Rate limits per phone and per IP, exponential lockout, cost alarms |
| Replay of ingest batches | Idempotency keys with 24 h window |

---

## Identity & tokens

```
Access JWT     15 min, RS256, claims: sub, org_id, role
Refresh token  30 days, rotating, single-use, stored hashed, revocable
Device token   connector only, opaque 256-bit, Argon2id-hashed at rest,
               shown exactly once at pairing, scoped: ingest + heartbeat only
Pair code      6 digits, TTL 10 min, single use, rate-limited, Redis-only
```

The device token must never be able to read reports, and the user JWT must never
be able to write to `/ingest`. Separate guards, separate scopes.

---

## Data protection

- **In transit**: TLS 1.3 only. HSTS. Certificate pinning in the connector.
- **At rest**: RDS encryption (KMS), R2 SSE + **client-side encryption for
  backups** using a per-org key derived from a KMS-held master key.
- **PII minimisation**: store customer phone numbers because reminders need
  them; do not store anything you cannot justify to a customer's auditor.
- **Retention**: on cancellation, data is retained 90 days then hard-deleted.
  Publish this. Provide a "delete my data now" path.
- **Backups**: RDS PITR 7 days + daily snapshot 30 days. **Test a restore
  quarterly** — an untested backup is not a backup.

---

## Row-Level Security

Every tenant table gets RLS. The API sets the tenant per transaction:

```sql
BEGIN;
  SET LOCAL app.org_id = '<uuid-from-jwt>';
  -- all queries in this transaction are now tenant-fenced by the DB itself
COMMIT;
```

Use a Drizzle middleware/interceptor so no developer can forget it. Add a CI
test that runs a report query as org A and asserts zero rows from org B.

---

## Connector-specific security

1. **Read-only into Tally.** No write templates exist in the codebase. Add a CI
   grep that fails the build if a request template contains `Import`.
2. **Signed binaries.** An unsigned `.exe` triggers Windows SmartScreen and your
   install conversion collapses. Buy an OV/EV code-signing certificate.
3. **Signed auto-updates.** Verify an Ed25519 signature on the update payload
   before executing. An unsigned auto-updater is a supply-chain backdoor into
   every customer's finance PC.
4. **Least privilege.** Run as a service under a limited account; it needs
   loopback HTTP and one data directory, nothing else.
5. **Local log redaction.** Never write full voucher payloads to the local log
   file — support staff will ask customers to email those logs.

---

## Application hardening

- Validate every input with Zod at the boundary; reject unknown fields.
- Parameterised queries only (Drizzle enforces this) — no string-built SQL.
- Helmet headers, strict CORS allowlist, no wildcard origins.
- Rate limits per the API doc; return `429`, never silently drop.
- Secrets in AWS Secrets Manager. **No secrets in the repo or in the connector
  binary.** CI scans with gitleaks.
- Dependency scanning: `pnpm audit` + `govulncheck` in CI, weekly Dependabot.
- Webhook signature verification for Meta, MSG91 and Razorpay — all three.

---

## Compliance posture (India SMB SaaS)

- Data stored in **ap-south-1 (Mumbai)** — say this on the website; it removes a
  real sales objection.
- DPDP Act: publish a privacy policy, name a grievance officer, honour deletion
  requests, record consent for WhatsApp messaging.
- Play Store / App Store data-safety declarations must match reality.
- SOC 2 is not needed for SMBs, but keep the audit log and access controls that
  would make it achievable later if you move upmarket.

---

## Pre-launch checklist

- [ ] RLS enabled and tested on every tenant table
- [ ] Cross-tenant leak test in CI
- [ ] Device token revocation works end-to-end
- [ ] Connector binary signed; auto-update signature verified
- [ ] Secrets scanned; none in git history
- [ ] Backup restore rehearsed
- [ ] Rate limits verified under load
- [ ] Sentry PII scrubbing on (no amounts/names in error payloads)
- [ ] Privacy policy + terms + data-deletion route live
