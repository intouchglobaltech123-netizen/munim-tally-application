# Going live

Three pieces, deployed separately.

| Piece | Where | Why there |
|---|---|---|
| API | Railway | Needs Postgres on a private network |
| Postgres | Railway | |
| Web | **Vercel** | See below |
| Connector | The customer's own Windows PC | It dials out; nothing dials in |

## Why the web goes to Vercel, not Railway

Every page in `apps/web` is a client component and there is no server-side data
fetching — the browser calls the API directly using `NEXT_PUBLIC_API_URL`.

That matters because the usual reason to put a frontend next to its API is
private networking between them, and this app never uses it: the web server
makes no API calls at all. So co-locating buys nothing, and costs three things.

  * `next build` wants 1–2 GB of RAM. Vercel's build machines are sized for it;
    a small Railway service is not, and an OOM during build is a confusing
    failure to debug.
  * A traffic spike on the UI would compete for RAM and CPU with the API and
    Postgres. The API is the piece that must not go down — the connectors are
    talking to it every few seconds.
  * Next's image optimisation, caching and routing work on Vercel with no
    configuration. On Railway you are running `next start` in a container and
    doing that work yourself.

Railway for both is a reasonable choice if one dashboard and one bill matter
more. Nothing in the code prevents it — `apps/web/railway.json` is already
there.

---

## 1. Push to GitHub

Create an empty repo (no README, no .gitignore), then:

    git remote add origin https://github.com/<you>/munim.git
    git push -u origin master

## 2. Railway — the API

1. railway.com/new → **Deploy from GitHub repo**
2. Service → **Settings → Root Directory: `apps/api`**
   Without this Railway builds the repo root and finds no start script.
3. **+ New → Database → PostgreSQL.** `DATABASE_URL` is injected automatically.
   Keep the private URL; the public proxy costs egress and needs TLS.
4. **Variables → Raw Editor:**

        NODE_ENV=production
        MUNIM_ENCRYPTION_KEY=<openssl rand -hex 32>
        MUNIM_OPERATOR_EMAILS=<your email>
        GOOGLE_CLIENT_IDS=<your OAuth client ids, comma separated>
        CORS_ORIGIN=*

5. **Settings → Networking → Generate Domain**, then add:

        PUBLIC_API_URL=https://<api-domain>.up.railway.app

6. Check `https://<api-domain>.up.railway.app/v1/health` returns
   `{"ok":true,"service":"munim-api"}`.

Migrations run on boot, so there is no release command.

## 3. Vercel — the web app

1. vercel.com/new → import the same repo
2. **Root Directory: `apps/web`** (Vercel detects Next.js and pnpm on its own)
3. **Environment Variables:**

        NEXT_PUBLIC_API_URL=https://<api-domain>.up.railway.app

   It is read at build time, so changing it later needs a redeploy.
4. Deploy.

## 4. Wire the two together

Back on Railway, replace the wildcard:

    CORS_ORIGIN=https://<your-app>.vercel.app

`*` lets any website call your API with a signed-in user's token. Fine for the
first ten minutes, not fine to leave.

## 5. Google sign-in

Sign-in fails until the new origins are registered. In Google Cloud Console →
Credentials → your OAuth client:

  * **Authorised JavaScript origins:** `https://<your-app>.vercel.app`
  * **Authorised redirect URIs:** the same, plus whatever path your client uses

## 6. The connector

The installer points at whatever `PUBLIC_API_URL` was set to when it was
downloaded. Existing installs on the old address keep talking to the old
address — re-download the setup file from the live site.

---

## Keep in mind

**The encryption key.** `MUNIM_ENCRYPTION_KEY` is deliberately fatal in
production: backups hold a customer's entire books and are not written
unencrypted. Keep a copy somewhere other than Railway. Lose it and every backup
written with it is unreadable — there is no recovery path, by design.

**Storage.** Measured on real data, a voucher costs about 2.2 kB with indexes:
10,000 vouchers ≈ 37 MB, 50,000 ≈ 120 MB, 500,000 ≈ 1 GB. One busy shop reaches
50,000 in a year. A 0.5 GB volume holds roughly one customer, and `lib/plans.js`
currently promises Pro customers 5 GB each. Raise the volume or lower the
promise, but do not ship both.

**Backups are the one unbounded memory path.** `backup.create` reads a whole
company, serialises, gzips and encrypts it in memory. A large book will exceed
512 MB. Until that streams, give the API 1 GB or keep backups small.

**Duplicate React.** Every web page once returned 500 because two copies of
React were installed and hooks threw an invalid-hook-call. It was fixed in
node_modules, which is not committed, so a fresh install could reintroduce it.
If the deployed site 500s, run `npm run check:react` first.
