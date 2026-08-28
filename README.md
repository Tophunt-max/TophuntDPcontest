# TopHunt

A photo and video contest app with a real-money coin economy. Users buy coins, enter
head-to-head contests, the community votes, and winners cash out.

The README used to be the untouched `create-expo-app` template, which described a
Firebase/Expo Go setup this project no longer uses and said nothing about the
backend that actually runs it.

## Architecture

```
apps/expo          React Native + Expo Router app (iOS, Android, web)
apps/worker        Cloudflare Worker API — Hono, D1, R2, KV, Durable Objects
apps/admin-panel   React + Vite admin panel (Cloudflare Pages)
```

- **API** — one Cloudflare Worker. Routes: `/api` (authenticated actions), `/auth`
  (pre-login), `/read` (cursor-paginated reads), `/admin`, `/webhook`, `/upload`,
  `/media/*`, `/ws`.
- **Database** — D1 (SQLite). Migrations in `apps/worker/migrations` are applied
  automatically on the first request of each isolate (`src/db/autoMigrate.ts`) and
  are **append-only**; CI enforces that.
- **Identity** — Firebase Auth remains the source of truth. The Worker verifies ID
  tokens at the edge and re-checks the account's D1 row on every request, so a
  blocked account is revoked immediately rather than an hour later.
- **Media** — R2, with optional Bunny Stream transcoding for video.
- **Hot paths** — votes are counted in a per-match `VoteCounter` Durable Object and
  batch-flushed to D1, keeping the viral path off D1's single writer. Realtime chat
  and notifications use a `RealtimeHub` Durable Object over WebSockets.

## Getting started

Requires Node 22 (`.nvmrc`).

```bash
# API
cd apps/worker
npm ci
cp .dev.vars.example .dev.vars     # then fill it in — see the checklist inside
npm run dev                        # http://localhost:8787

# App
cd apps/expo
npm ci
npm start                          # then pick a platform

# Admin panel
cd apps/admin-panel
npm ci
npm run dev                        # http://localhost:5000
```

Point the app at your API with `EXPO_PUBLIC_API_URL` (see `apps/expo/eas.json` for
how each build profile sets it).

## Verifying a change

```bash
npm run verify            # all three apps
npm run verify:worker     # typecheck + tests + wrangler dry-run
npm run verify:expo       # typecheck + icon gate + tests
npm run verify:admin      # typecheck + build
```

CI runs the same gates plus `expo export -p web` (a bundler-only failure passes
`tsc` and `vitest` while breaking the real build), `expo lint`, a secret scan, a
dependency audit, and the migration append-only check.

## Configuration

Two layers, deliberately separate:

1. **Admin panel → App Settings** — wallet limits, deposit mode, rewarded-ad
   policy, legal copy, contact details. Stored in D1.
2. **Admin panel → Integrations** — which SMS gateway, email provider, payment
   gateway and video CDN to use, plus their credentials.

Credentials set in the panel are **AES-256-GCM encrypted** with
`SETTINGS_ENCRYPTION_KEY`, which stays a Cloudflare secret and is never written to
the database. They are **write-only** through the API: the panel shows a masked hint
and a fingerprint, never the value. Resolution order is always **panel value first,
Worker environment second**, so an existing deployment keeps working and credentials
can be migrated one at a time — the panel shows which source is in effect.

Everything is **fail-closed**. A missing payment secret refuses top-ups rather than
crediting them for free; rewarded ads stay disabled until an admin explicitly opts
in. `GET /health/deep` reports exactly which secrets and providers are missing.

## Deploying

**Everything is deployed by Cloudflare, automatically, on push to `main`:**

| What | By | Check name | Production host |
|---|---|---|---|
| `apps/worker` | Cloudflare Workers Builds | `Workers Builds: tophunt-api` | `https://api.tophunt.in` |
| `apps/expo` (web) | Cloudflare Pages | `Cloudflare Pages: tophuntdpcontest` | `https://tophunt.in` |
| `apps/admin-panel` | Cloudflare Pages | `Cloudflare Pages: tophunt-admin-panel` | `https://admin.tophunt.in` |

Media is served from `https://media.tophunt.in` (the `tophunt-media` R2 bucket's
own custom domain), not from the Worker. Connecting these hostnames, the media URL
backfill and the Transformations switch are all covered by
[`PRODUCTION_DOMAINS.md`](PRODUCTION_DOMAINS.md).

All three are configured on the Cloudflare side, so there is no deploy step in this
repository for them. Nothing else deploys this project — if you see a status from
another provider, it is a leftover integration and should be disconnected.

> **Why is there a `vercel.json`?**
> Only to switch Vercel off. A leftover Vercel project is still connected to this
> repository and was failing on every commit; `git.deploymentEnabled: false` stops
> it building. It is a stopgap, not configuration — **delete `vercel.json` once the
> Vercel project itself is deleted** (Vercel dashboard → project → Settings →
> Delete Project). `vercel.json` is strict JSON and cannot hold a comment, which is
> why this note lives here.

Manual deploys, for staging or when the Cloudflare-side build is unavailable:

```bash
cd apps/worker && npm run deploy          # or: Actions → Deploy Worker
cd apps/admin-panel && npm run deploy
```

`.github/workflows/deploy-worker.yml` is **manual only** (`workflow_dispatch`) so it
cannot race with Workers Builds. It re-runs the gates, deploys, then smoke-tests
`/health/deep` and fails if the deployment cannot reach its dependencies. Its API
token needs `Workers Scripts:Edit`, `D1:Edit` **and** `User → Memberships:Read`.

There is a `staging` environment in `wrangler.toml`; its resource ids are
placeholders until you create them (deliberately, so a staging deploy cannot
silently write to production).

## Operations

- **[docs/RUNBOOK.md](docs/RUNBOOK.md)** — health checks, payment incidents, fraud
  response, cron failures, database restore, credential rotation, rollback.
- Weekly off-site D1 backups: `.github/workflows/backup-d1.yml`.
- Cron heartbeats are recorded in `cron_runs`; a failed job writes an error log, a
  Sentry event and an admin notification.

## Money invariants

Worth knowing before touching anything financial:

- Coins are a **whole-number** currency. Never write a fractional amount
  (`src/lib/money.ts` enforces it). Fiat is integer paise or rounded to 2dp.
- A prize can never exceed the entry-fee pot the two players funded, and the prize
  is **snapshotted on the match** at creation.
- Every balance change and its ledger row are written in **one D1 transaction**,
  gated on the same claim token, so a balance can never move without a ledger entry.
- Anything that could be retried is **idempotent** — via a status compare-and-swap,
  a deterministic ledger id, or a claim in `idempotency_keys`.
- `payments.amount_paise` is money; `payments.coins` is coins. They are not
  interchangeable, and revenue reporting reads only the former.
