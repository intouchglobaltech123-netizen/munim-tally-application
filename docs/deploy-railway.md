# Deploying the API to Railway

Railway builds from a Git repo. There is no server to SSH into — the deploy is
`git push`, and everything else is environment variables set in the dashboard.

## What goes where

| Piece | Where it runs | Why |
|---|---|---|
| API | Railway service, root directory `apps/api` | Needs the database on the private network |
| Postgres | Railway Postgres | |
| Web | **Vercel or Netlify**, not Railway | It is a Next.js app; those hosts build it free and better |
| Connector | The customer's own Windows PC | Unchanged — it dials out, nothing dials in |

`apps/api` has two dependencies (`pg`, `qrcode`) and no workspace links, so it
builds on its own without the rest of the repo.

## Steps

1. **Push the repo to GitHub.** Railway deploys from a branch.

2. **New Project → Deploy from GitHub repo**, pick this repo.

3. **Service settings → Root Directory: `apps/api`.**
   Without this Railway builds the monorepo root and finds no start script.

4. **Add Postgres**: `+ New → Database → Add PostgreSQL`.
   Railway injects `DATABASE_URL` automatically. Use the private URL it gives
   you by default — the public proxy costs egress and needs TLS.

5. **Set the variables below**, then deploy.

Migrations run automatically on boot (`index.js` calls `migrate()`), so there is
no separate release command.

## Variables

**Required — the server will not start without these.**

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `MUNIM_ENCRYPTION_KEY` | 32 bytes of hex — `openssl rand -hex 32` |
| `GOOGLE_CLIENT_IDS` | Your OAuth client ids, comma separated |
| `PUBLIC_API_URL` | The Railway domain, e.g. `https://munim-api.up.railway.app` |

`MUNIM_ENCRYPTION_KEY` is deliberately fatal in production: backups hold a
customer's entire books and are not written unencrypted. **Keep a copy of it
somewhere other than Railway.** Lose it and every backup written with it is
unreadable — there is no recovery path, by design.

**Should be set**

| Variable | Value |
|---|---|
| `MUNIM_OPERATOR_EMAILS` | Your own address, or nobody can reach `/admin` |
| `CORS_ORIGIN` | The web app's URL. Leaving it `*` lets any site call the API with a user's token |
| `GOOGLE_CLIENT_ID_WEB` / `GOOGLE_CLIENT_ID_ANDROID` | If web and Android use separate clients |
| `SUPPORT_EMAIL` | Shown on the Help screen |

**Optional**

| Variable | Default | Notes |
|---|---|---|
| `PG_POOL` | `10` | Lower it if Postgres runs out of connections before the API does |
| `MUNIM_STATE` / `MUNIM_STATE_CODE` | Tamil Nadu / 33 | Decides CGST+SGST vs IGST on your own invoices |
| `MUNIM_GSTIN` | — | Printed on the invoices you issue customers |

## Sizing

Measured against real data in this database, a voucher costs about **2.2 kB**
including indexes:

| Vouchers | Database |
|---|---|
| 10,000 | 37 MB |
| 50,000 | 120 MB |
| 200,000 | 431 MB |
| 500,000 | 1 GB |

One busy shop reaches 50,000 in a year. **A 0.5 GB volume holds roughly one
customer**, and the plan limits in `lib/plans.js` promise Pro customers 5 GB
each — ten times the whole disk. Raise the volume or lower the promise; do not
ship both.

Backups are stored **inside Postgres** as encrypted blobs, so they land on the
same volume. `backup_keep` is per plan (Pro keeps 30).

RAM: the API idles around 46 MB. The one unbounded path is `backup.create`,
which reads a whole company, serialises, gzips and encrypts it in memory — a
large book will exceed 512 MB there. Until that streams, keep backups small or
give the service 1 GB.
