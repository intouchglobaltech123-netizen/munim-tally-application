# connector — The Munim Agent (Go)

Not built yet. Spec: [docs/04-tally-sync-engine.md](../docs/04-tally-sync-engine.md) ⭐

Runs on the customer's Windows PC beside Tally. Reads Tally's XML gateway on
`localhost:9000` and pushes changes to the cloud. **Read-only into Tally, always.**

## Planned layout
```
connector/
├─ cmd/lkp-agent/          main, service wrapper, systray
├─ internal/
│  ├─ tally/               XML request templates (erp9/, prime/), HTTP client
│  ├─ sanitize/            byte-level cleaner — the highest-value package here
│  ├─ parse/               tolerant XML → structs, Indian number parser
│  ├─ sync/                cursor loop, batching, reconcile
│  ├─ spool/               BoltDB offline queue
│  ├─ api/                 cloud client, pairing, heartbeat, ingest
│  └─ update/              Ed25519-verified self-update
├─ testdata/               anonymised real Tally XML fixtures
└─ installer/              Inno Setup script
```

## Why Go
A single ~12 MB `.exe` with no runtime to install. Install friction is the
biggest churn cause in this category.

## Hard rules
1. Never write to Tally. CI fails the build if a template contains `Import`.
2. Never advance the sync cursor before the server returns 200.
3. Never log full voucher payloads locally — support will ask for these logs.
4. Binary and auto-updates must be signed.

Build with prompts 2 and 5 in [docs/13-build-prompts.md](../docs/13-build-prompts.md).
