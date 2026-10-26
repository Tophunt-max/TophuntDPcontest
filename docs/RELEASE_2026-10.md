# Release plan and Go/No-Go: production audit Phases A–I (2026-10-26)

Scope: the stacked PRs #157 → #165 (branches `feat/production-audit-phase-a` …
`-phase-i`), 50 commits on top of `main` at `ca0305d`, 199 files. `main` has not
moved since Phase A branched, so the stack applies without a rebase. Phase J adds
only this document and the audit section (no code).

## 1. Regression (clean worktree, `npm ci`, 2026-10-26)

| App | Check | Result |
|---|---|---|
| Worker | migrations check vs `origin/main` | pass: 67 files, 2 new (0065, 0066), none modified |
| | typecheck | pass |
| | tests | **1596 passed** (86 files) |
| | `wrangler deploy --dry-run` production / staging | pass / pass |
| | restore drill (`scripts/restore-drill.sh`) | pass |
| | `npm audit --omit=dev` | 0 high, 0 critical (1 moderate) |
| Expo | lint | 0 errors, 159 warnings (unchanged baseline) |
| | typecheck, icons | pass, pass |
| | tests | **991 passed** (94 files) |
| | web build (`npm run build`) | pass; sw.js stamped, 10 files precached |
| | native export android + ios | pass |
| | `npm audit --omit=dev` | 2 critical, 16 high, 11 moderate (see §6) |
| Admin panel | typecheck, build | pass, pass (no test or lint script exists) |
| | `npm audit --omit=dev` | 5 high (see §6) |

Not run anywhere: GitHub CI on these PRs (CI triggers only on PRs into `main`;
only Phase A's PR targets `main`, and its last run passed); device tests (no
EAS/macOS here); a browser session against staging (staging is not provisioned).

## 2. What production runs today

Checked with read-only GETs on 2026-10-26:

- `GET https://api.tophunt.in/health` → 200.
- `GET /health/deep` → **503**:
  - `secrets`: missing `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`;
  - `integrations`: razorpay not configured;
  - `cron`: `seoAudit` last ran 17 h ago (stale after 13 h). Every other job is fresh.
- `POST /telemetry/events` → 404 and `https://tophunt.in/sw.js` → 404. Production runs
  code from before this stack, as expected.
- `deploy-worker.yml` last ran 2026-08-24 and failed at the `wrangler deploy` step.
  The last GitHub deployment record is from the same day. Production has been
  deployed some other way since, or not at all; which commit is live is unknown.
- `backup-d1.yml`: every run has failed at its preflight step (the repository
  secrets cannot see `tophunt-db`), so **no off-site backup exists**. Time Travel
  (30 days, same account) is the only copy.

## 3. Database changes

Both are additive and applied by the Worker at runtime (`ensureMigrated`):

| Migration | Change | Old code after a rollback |
|---|---|---|
| `0065_feed_dismissals.sql` | new table + index | ignores the table |
| `0066_chat_member_cleared_at.sql` | `chat_members.cleared_at INTEGER` | ignores the column; chats a user cleared show their old messages again |

No Durable Object class or `[[migrations]]` change, so a Worker rollback is safe.

## 4. Compatibility between components

| Combination | Behaviour |
|---|---|
| New Worker, old app | `?token=` sockets still accepted; old clients never send `clientId`, so chat sends are not idempotent until they update; a phone-only account exporting data gets 412; the old app has no re-verify step for export, so that export fails until the app updates |
| New app, old Worker | `createWsTicket` throws → `socketTicket` returns null → `?token=` (code path read; the test covers the tickets-off case). Costs one extra API call per socket open; `/telemetry/events` 404 is dropped; `featureRollout` absent → everyone in |
| New Worker, **old admin panel** | sensitive actions return 412 `reauth_required`; the old panel shows an error. Workaround: sign out and in (fresh login is valid 15 min). **Deploy the panel with the Worker.** |
| New panel, old Worker | no `viewerRole` → full menu (server still enforces roles); no 412s |
| New web build, old Worker | works; the usage counters 404 and are dropped |

## 5. Release order (when authorized)

0. **Before anything:** fix the deploy credentials (same root cause as the backup:
   the token/account in the repository secrets cannot see the production account),
   run `backup-d1.yml` once and confirm an artifact exists, and note the current
   Worker version (`npx wrangler deployments list`) for rollback.
1. Provision staging (replace `REPLACE_WITH_STAGING_*` in `wrangler.toml`; see
   `STAGING_PORT_PLAN.md`), deploy the stack there (`deploy-worker.yml`,
   environment `staging`) and run the §7 checklist.
2. Merge the stack into `main` in order (#157 first, then retarget each next PR to
   `main`, or merge #165 → … → #157 down the stack and #157 into `main` last).
3. Production: Worker → admin panel → web (`npm run build`; Pages build command
   must be `npm run build`) → `eas update --branch production`.
   Optional secret before step 3: `WS_TICKET_SECRET`.
4. Watch for 1 h: `/health/deep`, `error_logs`, Sentry, `/admin/capacity` (D1 rows
   written: migration 0065 and the new money-health cron add load), the uptime
   workflow.

## 6. Rollback

| Component | How | Notes |
|---|---|---|
| Worker | `npx wrangler rollback <version-id>` (RUNBOOK §7) | migrations stay (additive, §3); never `git revert` a DO change (none here) |
| Admin panel | Pages → Deployments → roll back | roll back with the Worker (§4) |
| Web app | Pages → roll back | the service worker stays registered but is network-first for pages and caches only hashed files, so the old build loads correctly. To remove it, deploy a `sw.js` containing only the kill switch below |
| Native app | `eas update --branch production` with the previous commit, or `eas update:rollback` | native binaries are unchanged by this stack |
| Data | Time Travel restore (RUNBOOK §5) | only for data damage, not for a code rollback |

Service worker kill switch (replace `apps/expo/public/sw.js`, rebuild, deploy):

```js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('tophunt-')) await caches.delete(k);
  await self.registration.unregister();
})()));
```

Or build with `EXPO_PUBLIC_SW=off`, which makes the app unregister `/sw.js`.

## 7. Staging checklist (not yet run: staging does not exist)

- Sign-in (email, phone OTP, Google), sign-out, account switch clears feed/stories.
- Feed: Not interested, ranking, offline open shows the saved feed (web: reload offline).
- Contest: join, entry upload (R2 and Bunny), vote, settlement by cron, refund path.
- Wallet: top-up (needs Razorpay test keys), withdrawal request, admin approve
  (expect the password prompt), wallet adjust with reason.
- Chat: send offline then reconnect (no duplicates), delete-for-me, socket uses `?ticket=`.
- Stories: view, complete/skip counted in the Analytics usage card.
- Admin as moderator: menu limited, support tickets masked, payouts 403.
- Data export (phone-only account): re-verify prompt then download.
- `/health/deep` 200 on staging.

## 8. Dependency advisories (`npm audit --omit=dev`, not introduced by this stack)

The stack adds one dev dependency (`fake-indexeddb`) and no runtime ones.

- **Expo app, critical:** `shell-quote` via `react-native` → `react-devtools-core`
  (dev tooling, not in the shipped bundle); `websocket-driver` via `firebase` →
  `@firebase/database` (Realtime Database, which this app does not use).
- **Expo app, high:** mostly the Expo CLI and build chain (`@expo/cli`, `tar`,
  `node-forge`, `undici`, `postcss`, `minimatch`, `picomatch`), `lodash`, `zod`
  (memory exhaustion on oversized constrained collections, fixed in 4.6.6), and
  `@grpc/grpc-js` via firebase.
- **Admin panel, high:** `firebase` 11 (`@firebase/firestore`, `@grpc/grpc-js`) and `zod`.
- Most fixes need major upgrades (Expo SDK, zod 4, firebase). Plan it as a separate
  change with its own device testing. Nothing here was changed.

## 9. Go / No-Go

**Code: GO to merge** into `main` once the owner has reviewed the stack. All local
checks pass, the changes are additive at the database level, and every component
falls back cleanly against the others (§4) except the old admin panel against the
new Worker.

**Production release: NO-GO** until all of these are done:

| # | Blocker | Owner action |
|---|---|---|
| 1 | Production is already unhealthy (503: Razorpay secrets, stale `seoAudit`) | set the Razorpay secrets, or confirm payments are intentionally off and make razorpay optional in the health check; read Worker logs for the `0 */6 * * *` trigger |
| 2 | No backup exists, and the deploy workflow cannot deploy (same credentials) | create an API token in the account that owns `tophunt-db`, update `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, run `backup-d1.yml` once and confirm success |
| 3 | Which Worker version is live is unknown | `wrangler deployments list`; record it as the rollback target |
| 4 | Staging is not provisioned, so §7 cannot run | create the staging D1/KV and fill the placeholders |
| 5 | No device test of the native app (offline sync, uploads, sockets, re-auth) | EAS build to internal testers |

**Not blockers, still open:** decisions on card-coin withdrawal/KYC, fail-closed
`create:{ip}` limit, signed URLs for private media; chat bodies and R2 media have no
backup (RUNBOOK §5); dependency upgrades (§8); single 2 MB (gzip) web bundle.
