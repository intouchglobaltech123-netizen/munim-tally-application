# packages/shared — Contracts

Not built yet.

The single source of truth shared by api, web and mobile:
- Zod schemas for **every** API request/response in docs/06-api-contract.md
- Inferred TypeScript types
- Money helpers (integer **paise** on the wire, formatting to en-IN)
- Error code enum — stable machine codes, never message-text matching
- WhatsApp template registry with approved variable order

Rule: if a shape crosses the network, it is defined here. No exceptions, or the
three clients drift.

Build with prompt 3 in [docs/13-build-prompts.md](../../docs/13-build-prompts.md).
