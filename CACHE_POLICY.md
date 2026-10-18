# Cache policy

**Last audited:** 2026-10-18 · **Scope:** `apps/expo`, `apps/worker`

This is the single reference for what is cached where, for how long, who may
see it, and what invalidates it. Everything here was checked against the code
(file references below). Nothing in it is a **measured** production hit ratio or
cost. Sections 7 and 8 say what is measured locally and what needs the
Cloudflare dashboard.

## 1. Layers

| # | Layer | Owns | Must NOT hold |
|---|---|---|---|
| 1 | React state / TanStack Query (memory) | Mounted-session UI state | — (cleared on account change) |
| 2 | WatermelonDB (`src/database`) | Story cache, replay-safe action queue, Home feed first-page snapshot | Media bytes, `data:` URIs, chat, wallet or payment data |
| 3 | expo-image / `videoCache` | Media bytes | Structured data |
| 4 | Cloudflare Cache API (`lib/edgeCache.ts`) | Viewer-independent shared read data, per colo | Personalised responses, permission decisions |
| 5 | Isolate memo (`lib/memo.ts`, max 1000 entries) | Bounded, recomputable values (feed pool / order, feed-seen, feed weights, JWKS, Firebase token) | Anything a kill switch, block, session or money decision reads |
| 6 | Workers KV (`CACHE_KV`) | Values that need **globally visible deletes**: `settings:*` (holds `payoutsFrozen`), `cache:blocks:*`, `authstate:*` (`SCALE_TIER` paid/auto), `feed:seen:*` (throttled) | OTPs, rate-limit counters, balances, any hot read cache rewritten at the 60s floor |
| 7 | D1 / Durable Objects | Source of truth. Vote/engagement tallies live in the DO and are batched into D1 | — |

Every tier fails open. A Cache API, memo or KV error falls through to the next
tier and finally to D1. A loader error is returned to the caller; it is never
replaced with stale data. KV write failures, including an exhausted quota, are
logged and swallowed (`cachePutJson`, `readSetting`). Authorization, rate limits
and payment checks always run, whether or not a cache answered.

## 2. Entries

TTLs are seconds unless marked. "Writer purge" means `purgeShared` / `edgePurge`.
Those calls clear the writer's own colo immediately, plus memo and KV. Other colos
converge when the TTL lapses, because the Cache API has no global purge.

### Server: shared edge entries (`READ_CACHE_TTLS`, `routes/read.ts`)

| Route | Key (normalised) | Edge TTL | Invalidation | Per-viewer pass applied after the cache |
|---|---|---|---|---|
| `/read/matches` sort=recent/hot | `cache:matches:<status>:<type\|all>:<sort>:<limit>:<page>`. `<page>` is `first`, `c<cursor>` (parsed with `pageCursor`) or `o<offset>` (floored). Status and type are allow-listed, otherwise not cached | 30 | TTL only (new battles appear on lapse) | `hiddenUidsFor` and `hydrateViewerState` → `private, no-store` |
| `/read/matches` foryou/following | Memo `cache:matches:cand:<status>:<type>` (45s), memo `cache:feedorder:<uid>:…:<exclusionVersion>` (60s) | — | TTL | Blocks/mutes, then viewer flags. Response has `Vary: Authorization` |
| `/read/contests`, `/read/contests/:id` | `cache:contest:list:<type>`, `cache:contest:detail:<id>`. A not-found result is **not** cached | 60 / 30 | `invalidateContestCaches` (admin CRUD, create, cron end) | none (public) |
| `/read/comments` page 1 | `cache:comments:<kind>:<targetId>`. Only `limit=20` is cached, which is what both app clients request | 30 | Writer purge on add/delete, using the **deleted row's** thread | Blocks, `likedByMe` |
| `/read/leaderboard` | `cache:leaderboard:<wins\|votes\|xp>:<limit>`, with `by` normalised | 60 | TTL | Blocked accounts dropped |
| `/read/users/:id` | `cache:user:<uid>` | 30 | Writer purge (profile, follow, block, badge) | Relations, privacy lock (`Vary: Authorization`) |
| `/read/stories/feed` | `cache:stories:feed:v2` | 60 | Writer purge on privacy change and admin block | Audience, blocks, VS privacy |
| `/read/users/suggested` | `cache:users:suggested` | 120 | TTL | Hidden users |
| `/read/blog`, `/read/blog/:slug` | `cache:blog:list:12`, `cache:blog:post:<slug>` | 20 | `invalidateBlogReadCache` | none |
| `/read/blog/categories`, `/sitemap`, `/archive`, `/read/app-config`, `/read/legal` | URL key (`cachedResponse`) | 1800 / 21600 / 1800 / 120 / — | `edgePurgeUrl` on admin save, where wired | none (fully public) |

### Server: isolate memo and KV

| Key | Tier | TTL | Invalidation | Notes |
|---|---|---|---|---|
| `memo:feedWeights` | memo | 30 | `invalidateSetting('appConfig')` drops it in the writer isolate | **New.** Only the 12 ranking numbers are memoised, never `appConfig` itself |
| `settings:<id>` | KV | 1800 | `invalidateSetting` (KV delete, global) | Not memoised **by design**: `payoutsFrozen` |
| `cache:blocks:<uid>` | KV | 3600 | `invalidateBlockCache` | Fails open to an *empty* set (unfiltered) on KV error |
| `authstate:<uid>` | KV | 60 | `invalidateAuthState` / `setCutoff` | Only when `SCALE_TIER` is `paid` or `auto`. **Deployed value: `auto`**; see §6 |
| `feed:seen:<uid>` | memo 900 + KV 3 days | — | account deletion | KV flush at most every 15 min per viewer |

### Client

| Entry | Owner / privacy | Key | Freshness | Invalidation | Survives logout or account switch? |
|---|---|---|---|---|---|
| Home feed snapshot (`src/lib/feedSnapshot.ts`) | Viewer (`u:<uid>` or `guest`) | `${owner}\|${tab}`, at most 2 rows | Painted if ≤ 12h old, then **always** revalidated in the background (PostCard keeps the viewer's own votes and likes in local state, which the snapshot never sees). Pull-to-refresh always hits the network | Replaced on every fresh first page. Dropped on block/mute and when a page comes back empty. A save whose fetch began before a clear is discarded (generation counter) | **No.** `_layout.tsx` wipes it on any uid change, and every write deletes other owners' rows |
| Story cache (`stories`, `user_stories`) | Viewer (signed-in only) | server story id | Per-story `expires_at`. Network-first | Replaced on every feed fetch. Expired rows swept at launch | **No** (`clearLocalStories`) |
| `pending_actions` | uid column | one row per (type, story, uid) | Swept after 7 days; 5 replay attempts | Replay only for the matching uid | Kept, but only that account ever replays them |
| TanStack Query | Mixed. Several keys omit the viewer (`['profile', id]`, `['match', id]` and others) | — | 30s default | `queryClient.clear()` on any uid change | **No** |
| Realtime channel sockets (`realtime.ts`) | Account that opened the socket | one per channel, ref-counted | Stays open 5s after the last listener leaves, so remounts reuse it | Retired after the linger; dropped while idle → not reconnected | **No.** A lingering socket is reused only by the same uid |
| Notification badge (`notificationService.ts`) | uid | memory, per uid | Live socket + 180s safety poll | Dropped when the last subscriber leaves | **No** |
| Media | Public URLs | expo-image / video cache | Platform policy | Settings → Clear cache | Yes (public bytes only) |

## 3. Event → invalidation map

| Event | Invalidates | Remaining staleness |
|---|---|---|
| Match created / joined / activated / completed | Nothing explicit. The matches pages, feed pool and feed order expire | ≤ 30s edge, ≤ 45s pool, ≤ 60s order. Open cards get `match_status` over the socket |
| Vote / like / comment / share | DO tally plus a socket event carrying counts. PostCard applies them without a refetch. Comments page 1 is purged on add/delete | Comment likes: ≤ 30s (`toggleCommentLike` deliberately does not purge) |
| Profile update / badge / follow / block | `cache:user:*`, followers/following, `cache:blocks:*`, and the stories feed on a privacy change | Writer's colo: immediate. Other colos ≤ 30s. Blocks are global (KV) |
| Block / mute (client) | `bumpSocialGraphVersion` → Home refetches on focus, and the feed snapshot is dropped | Immediate on the device |
| Story create / delete / expire | Stories feed expires (60s). Cron removes expired personal stories in batches of 500, oldest first. A row is deleted only after its media delete succeeds, or once it is 7 days past expiry (logged as a leak) | ≤ 60s |
| Contest template change | `invalidateContestCaches` (cron: TTL only, since there is no request context) | ≤ 30–60s in other colos |
| Blog publish / edit / delete | `invalidateBlogReadCache`. Archive and sitemap are not purged | ≤ 20s; archive/sitemap ≤ TTL |
| appConfig / gamification save | `invalidateSetting` (global KV delete), `edgePurgeUrl('/read/app-config')`, and `memo:feedWeights` in the writer isolate | Feed weights ≤ 30s in other isolates. Leaderboard and profile levels ≤ edge TTL |
| Wallet / payout / payment | **Not cached anywhere.** Always D1 | — |
| Account deletion, admin block, session revoke | `invalidateAuthState` (global KV delete), socket close, refresh-token revoke | Bounded by the 60s `authstate` TTL only if a writer misses the invalidation |

Every purge runs **after** the authoritative write succeeds. A failed purge
leaves at most one TTL of staleness, which is why every invalidated edge entry
is ≤ 60s (`test/edgeCache.test.ts`).

## 4. Logout / account switch

1. `app/_layout.tsx` sees the uid change. This covers sign-out, guest → user and
   A → B; cold-start resolution is excluded. It runs `queryClient.clear()`,
   `clearLocalStories()` and `clearFeedSnapshots()`.
2. Home keys every snapshot read by the new owner. It also clears its list
   synchronously before loading, so A's battles are never painted under B, even
   for a frame.
3. Queued story actions are kept but replay only for their own uid.
4. Kept on purpose (see `src/lib/appCache.ts`): device id, theme, onboarding
   flag, remembered email, in-flight uploads, and media bytes (public).
5. Chat content and payment data are never persisted locally.

A local record is never treated as authorization. Every action re-checks on the
Worker.

## 5. Offline behaviour

- Home with a snapshot and no network: the snapshot stays on screen, with a
  "Saved battles · Tap to retry" strip. Without a snapshot: the existing error
  and retry state.
- Load-more never pages from a cached cursor. It waits for the fresh first page,
  because ranking offsets move between requests.
- The offline queue accepts only `view` and `reaction`. Both are idempotent
  upserts on `story_views (story_id, viewer_id)`. There is one row per
  (type, story, uid); a newer reaction replaces the older one, and a replay
  never deletes a row that was rewritten while it was in flight. The queue
  holds at most 200 rows, evicting the oldest first. Wallet, coin, withdrawal and contest-entry
  actions are never queued.

## 6. Known open items (not changed in this pass)

- **`SCALE_TIER = "auto"` is deployed.** On the free plan this spends KV writes
  on `authstate:*` (one per active user per 60s) until the daily quota fails.
  After that, every other KV write fails open, including `settings:*`,
  `cache:blocks:*` and `feed:seen:*`, so their reads fall to D1. This is correct
  but not cheap. Confirm the Cloudflare plan: use `paid` if the account is paid,
  or `free` for a busy free account.
- `sort=hot` orders by a computed score with OFFSET, so it cannot use an index.
  Its 30s page cache is the only bound. A maintained score column is warranted
  only after D1 Insights shows it.
- Feed pool and recent-list queries use `SELECT *` on `contest_matches`,
  including JSON participant blobs. The blog list selects `content`.
- `/read/users/:id` reads the target's full following list, unbounded (a PK
  range).
- Every `/read/blog/:slug` view writes `view_count` to D1, cache hits included.
- Cron N+1: `resolveMatch` notifications, and per-recipient `createNotification`
  in broadcasts.
- Invite-only (`isPrivate`) matches are not filtered from the For You pool. This
  is a product question, not a cache one.
- `idx_matches_status` is now redundant (it is a prefix of
  `idx_matches_status_created`). Drop it after Insights confirms the planner has
  switched.

## 7. Verification

- `apps/worker/test/queryPlans.test.ts` uses `EXPLAIN QUERY PLAN` on the
  migrated schema. It checks that hot reads use an index for both filter and
  order, and that retention sweeps are index ranges.
- `apps/worker/test/cacheAudit.test.ts` checks key normalisation,
  `Vary: Authorization`, no viewer flags in guest responses, the comments limit,
  negative caching, the combined notification count, the feed-weights memo, the
  story-sweep media leak, comment-delete purge, and cache-outcome logging.
- Existing tests that still apply: `edgeCache.test.ts`, `kvBudget.test.ts`,
  `kvWriteVolume.test.ts`.
- `apps/expo/test/feedSnapshot*.test.ts`, `pendingActionQueue.test.ts`,
  `notificationBadgeShare.test.ts` and `storySchemaMigrations.test.ts`.
- `node apps/worker/scripts/bench-hot-queries.mjs [--without 0059] [--analyze]`
  is a repeatable local plan/timing comparison on synthetic data. It is
  **not** D1.

## 8. Observability: what is available where

| Signal | Source |
|---|---|
| Shared-cache outcome per request (`hit` / `kv` / `miss` / `skip` / `bypass`; the last lookup wins) | **Worker log line** field `edgeCache` (Workers Logs). Status only, never the key |
| D1 rows read/written, top queries | Cloudflare dashboard / `wrangler d1 insights` (needs account access); `npm run capacity` |
| KV ops and quota errors | Dashboard. `[cache] … failed (continuing)` / `[settings] …` log lines |
| Cron duration and outcome | `cron_runs` table (admin health) |
| Endpoint latency and status | Worker log line `ms`, `status` |
| Client feed-cache hits, stale renders, offline serves, time to first content | `getFeedCacheStats()` (in-memory). **Not shipped anywhere**; there is no client metrics pipeline, so wiring it to one is a separate decision |
| R2 / CDN origin misses | Dashboard only |
