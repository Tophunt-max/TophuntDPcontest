# TopHunt API — Cloudflare Worker backend

Replaces the Firebase Cloud Functions backend with a single Cloudflare Worker.
**Firebase Authentication stays** — everything else moves to Cloudflare:

| Concern | Before | After |
|---|---|---|
| Compute | Cloud Functions (`api`, `authHandler`, triggers, schedulers) | Worker (Hono) + Cron Triggers |
| Database | Firestore | **D1** (`env.DB`) |
| Media | AWS S3 (presigned) | **R2** (`env.MEDIA`, presigned) |
| OTP / cache | Firestore docs | **KV** (`env.OTP_KV`, `env.CACHE_KV`) |
| Auth | Firebase Auth | **Firebase Auth** (ID token verified on the edge) |
| Push / SMS / email | FCM / Twilio / Gmail SMTP | FCM v1 / Twilio REST / Resend (HTTP) |

The client contract is unchanged: `POST /api` and `POST /auth` take `{ action, ...data }`
with `Authorization: Bearer <firebaseIdToken>`.

## One-time setup

```bash
cd apps/worker
npm install

# 1. Create resources
wrangler d1 create tophunt-db          # paste database_id into wrangler.toml
wrangler r2 bucket create tophunt-media
wrangler kv namespace create OTP_KV    # paste id into wrangler.toml
wrangler kv namespace create CACHE_KV  # paste id into wrangler.toml

# 2. Apply the schema
wrangler d1 migrations apply tophunt-db --remote

# 3. Secrets (see .dev.vars.example for the full list)
wrangler secret put FIREBASE_SERVICE_ACCOUNT   # service account JSON (Identity Toolkit + FCM)
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put R2_BUCKET
wrangler secret put TWILIO_ACCOUNT_SID
wrangler secret put TWILIO_AUTH_TOKEN
wrangler secret put TWILIO_PHONE_NUMBER
wrangler secret put RESEND_API_KEY
wrangler secret put EMAIL_FROM

# 4. Deploy
wrangler deploy
```

Point `R2_PUBLIC_BASE_URL` (wrangler.toml `[vars]`) at your R2 public bucket / custom domain,
then set the deployed Worker URL in the clients:
`EXPO_PUBLIC_API_URL` (Expo) and `NEXT_PUBLIC_API_URL` (admin).

## Data migration

```bash
# Firestore -> D1
GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json \
  node scripts/migrate-firestore-to-d1.mjs > d1-seed.sql
wrangler d1 execute tophunt-db --remote --file=./d1-seed.sql

# S3 media -> R2
node scripts/migrate-s3-to-r2.mjs
```

## Status

**Ported & compiling** (tsc clean, wrangler bundle OK):
auth (check/create/profile/OTP flows), storage presign, contest matches
(startMatch/joinMatch/submitVote), posts, stories, follow, daily reward, wallet
top-up, admin (setAdminRole/delete/unblock/broadcast/stats/search/contest
template), and all schedulers (resolveContests, monthlyHallOfFame, story
cleanup).

**Not yet ported** (return an explicit error, so nothing fails silently):
- `likeContest` / `commentContest` / `shareContest` — need `match_likes` /
  `match_comments` D1 tables (contestMatches likes/comments were subcollections).
- `adminManageWallet` — source `wallet/adminWalletManagement.ts` not yet reviewed.
- legacy `join` / `vote` — old `entries`/`battles` matchmaking flow.

**Phase 3 — DONE:**
- **Read endpoints** (`/read/*`) replace the client's direct Firestore reads and
  `onSnapshot` listeners: contests, matches, notifications (+ unread count),
  app-config, suggested users, user profile, chats and chat messages.
- **Realtime = polling.** The Expo client `poll()` helper (in
  `services/api.ts`) replaces `onSnapshot` with the same unsubscribe ergonomics.
  Rewired: contestService, notificationService, appSettings, users,
  messageService, the messages list + chat screens, PostCard live votes, and the
  legal pages. (Upgrade path: SSE or Durable Objects for push-style realtime.)
- **Former direct writes** are now Worker actions: `markNotificationsRead`,
  `registerFcmToken`, `equipBadge`, `startChat`, `sendMessage`, `markChatRead`,
  `deleteChat`.
- **Admin Next.js API routes** now proxy to the Worker `/admin/*` (D1) using a
  server-to-server `X-Admin-Secret` (set `WORKER_URL` + `ADMIN_PROXY_SECRET` in
  the admin env). No more Firebase Admin SDK / Firestore in those routes, and the
  hardcoded Cloud Function `run.app` wallet URL is gone.

**Phase 4 — DONE (full cutover):** every remaining Firestore usage in the Expo
app is migrated.
- New D1 tables: `match_likes`, `match_comments`, `match_reactions`, `bookmarks`,
  `highlights`; new columns on `users` (bio, is_private, auth_provider, extra),
  `contest_matches` (reactions), `story_views` (reaction). See
  `migrations/0001_phase4.sql`.
- New `/api` actions: likeContest, commentContest, shareContest, reactToMatch,
  toggleBookmark, addComment, deleteComment, updateProfile, completeSignup,
  viewStory, reactToStory, createHighlight, addStoryToHighlight.
- New `/read` endpoints: leaderboard, users/search, users/:id/posts,
  users/:id/bookmarks, users/:id/(followers|following), comments, stories/feed,
  users/:id/stories, stories/:id/viewers, users/:id/highlights,
  highlights/:id/stories. `/read/matches/:id` returns isLiked/isBookmarked.
- Rewired client: commentService, engagementService, reactionService,
  leaderboardService, storyService, walletService, saveUserProfile, socialAuth,
  useProfileData, and the auth (login/signup/password/phone), profile
  (connections/edit) and splash screens. No runtime Firestore calls remain in the
  app; **Firebase is used only for Authentication** (+ Timestamp type imports).
