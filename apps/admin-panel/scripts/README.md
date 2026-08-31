# Admin CLI scripts (Cloudflare / D1)

These operational scripts talk to the Cloudflare Worker's `/admin` endpoints
(D1-backed) using the server-to-server `ADMIN_PROXY_SECRET`. They no longer use
`firebase-admin` or Firestore.

## Setup

Add to `apps/admin/.env.local` (or export before running):

```
WORKER_URL=https://api.tophunt.in
ADMIN_PROXY_SECRET=<same value set on the Worker via `wrangler secret put ADMIN_PROXY_SECRET`>
```

For staging, point `WORKER_URL` at `https://tophunt-api-staging.weadown-in.workers.dev`
instead — staging has no custom domain. Double-check which one is set before
running anything that writes: these scripts talk to whatever `WORKER_URL` says.

## Scripts

| Command | What it does |
|---|---|
| `node scripts/makeAdmin.mjs <email>` | Make a user admin (Firebase custom claim + D1 `users.role`). Defaults to `tophuntinfo@gmail.com`. |
| `node scripts/list-contests.mjs` | List all contest templates from D1. |
| `node scripts/check-db.mjs` | Print D1 row counts (users/posts/reports/support). |
| `node scripts/seed-contests.mjs` | Insert a sample contest template. |
| `node scripts/test-notification.mjs <uid>` | Send a test notification (D1 + FCM push). |
| `node scripts/migrate-videos-to-bunny.mjs` | Migrate existing R2 videos to Bunny Stream (resumable; `--status`, `--target=stories\|matches`, `--limit=N`). Requires Bunny secrets on the Worker. |

No `serviceAccountKey.json` is needed anymore — the Worker holds the Firebase
service account as a secret and performs any Auth operations (e.g. setting the
admin custom claim) via the Identity Toolkit REST API.


## Legal content is no longer seeded by a script

There was a `update-legal-content.mjs` here. It is gone, and nothing replaces it.

It posted `{ legalContent: { privacyPolicy, termsOfService } }` — two of the four
documents. `POST /admin/app-settings` merged the body one level deep at the time,
so sending a partial `legalContent` **replaced** the whole object and silently
deleted the refund policy and the community guidelines. The request returned 200.

Two things changed:

1. The canonical text of all four documents now ships with the Worker, in
   `apps/worker/src/content/legal.ts`. `/read/app-config` falls back to it per
   document, so a legal screen can no longer render "not published yet" — which is
   what tophunt.in was serving for terms, privacy and refund.
2. `POST /admin/app-settings` now merges nested objects recursively, so a partial
   write can no longer erase a sibling.

To change a legal document, edit `apps/worker/src/content/legal.ts` and bump
`LEGAL_LAST_UPDATED` in the same commit. It goes out with the next Worker deploy,
under code review, in git history, and revertable.

To override one without a deploy, use **App Settings → Legal content** in the
admin panel. That form sends all four documents plus every unmanaged config key,
so it is safe. Clearing a textarea reverts that document to the bundled text.
