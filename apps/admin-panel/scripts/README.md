# Admin CLI scripts (Cloudflare / D1)

These operational scripts talk to the Cloudflare Worker's `/admin` endpoints
(D1-backed) using the server-to-server `ADMIN_PROXY_SECRET`. They no longer use
`firebase-admin` or Firestore.

## Setup

Add to `apps/admin/.env.local` (or export before running):

```
WORKER_URL=https://tophunt-api.<your-subdomain>.workers.dev
ADMIN_PROXY_SECRET=<same value set on the Worker via `wrangler secret put ADMIN_PROXY_SECRET`>
```

## Scripts

| Command | What it does |
|---|---|
| `node scripts/makeAdmin.mjs <email>` | Make a user admin (Firebase custom claim + D1 `users.role`). Defaults to `tophuntinfo@gmail.com`. |
| `node scripts/list-contests.mjs` | List all contest templates from D1. |
| `node scripts/check-db.mjs` | Print D1 row counts (users/posts/reports/support). |
| `node scripts/seed-contests.mjs` | Insert a sample contest template. |
| `node scripts/update-legal-content.mjs` | Write Privacy Policy + Terms into `settings/appConfig` (D1). |
| `node scripts/test-notification.mjs <uid>` | Send a test notification (D1 + FCM push). |
| `node scripts/migrate-videos-to-bunny.mjs` | Migrate existing R2 videos to Bunny Stream (resumable; `--status`, `--target=stories\|matches`, `--limit=N`). Requires Bunny secrets on the Worker. |

No `serviceAccountKey.json` is needed anymore — the Worker holds the Firebase
service account as a secret and performs any Auth operations (e.g. setting the
admin custom claim) via the Identity Toolkit REST API.
