# D1 + R2 load audit

**Date:** 2026-08-24 · **Scope:** `apps/worker`, plus the client polling that drives it

## How to read this

Findings are ranked by **expected** load, reasoned from query shape × call
frequency. They are **not measured**: D1 Insights / R2 metrics were not
available, and the database is nearly empty today (`/read/matches` returns 0
rows), so nothing here shows up in a bill yet. What it shows is where load will
concentrate as data grows — several items are full table scans on the
fastest-growing tables.

---

# D1

## 1. Every authenticated request costs a D1 query — even on a 100% cache hit

`src/middleware/auth.ts:11-20`

```ts
export async function assertAccountNotBlocked(env: Env, uid: string) {
  const account = await getDb(env)
    .select({ status: schema.users.status, isBlocked: schema.users.isBlocked })
    .from(schema.users).where(eq(schema.users.uid, uid)).get();
```

Called from **both** `requireAuth` (:30) and `optionalAuth` (:42). Every hit on
every `/read/*` and `/api` route pays it, and it runs **before** the route's KV
or edge cache is consulted. So the careful 60s caching on `/read/matches`,
`/read/contests`, `/read/users/:id`, `/read/leaderboard` never reaches zero D1
for a signed-in user.

Only 5 routes are ever truly D1-free: `/read/app-config`, `/read/coin-packages`,
`/read/blog`, `/read/blog/categories`, `/read/blog/:slug` — the ones with no auth
middleware.

It is a single-row PK lookup, so it is cheap *per call*. It is almost certainly
the **highest-count** query in the system regardless.

**Fix:** cache the blocked flag in `CACHE_KV` under `blocked:<uid>` with a short
TTL (30–60s), invalidated on the block/unblock admin action — which already
revokes sockets (`admin.ts:91-99`), so the hook exists. Immediate revocation is
preserved by the explicit invalidation; the TTL is only the fallback.

## 2. The For You feed does two full table scans

`src/routes/read.ts:390-401`, on every feed cache miss (≈ once per 60s per active
user, i.e. every app open):

```ts
// votes affinity
SELECT match_id, voted_for_uid FROM votes WHERE voter_uid = ? LIMIT 500
// profile-visit affinity
SELECT ... FROM profile_visits WHERE visitor_id = ? LIMIT 500
```

- `votes` indexes are `(match_id)`, `(match_id, voter_uid)`, `(match_id, device_id)`
  (`0000_init.sql:103`, `0011_voting_integrity.sql:66,68`). **`voter_uid` is never
  a leading column** → full scan of the table that grows fastest in the whole app.
- `profile_visits` has `PRIMARY KEY (user_id, visitor_id)` and no other index
  (`schema.ts:543-551`). `visitor_id` is the **trailing** column → full scan.

`LIMIT 500` bounds the rows returned, not the rows examined.

**Fix:**
```sql
CREATE INDEX idx_votes_voter_created    ON votes (voter_uid, created_at);
CREATE INDEX idx_profile_visits_visitor ON profile_visits (visitor_id);
```
Note `vote_xp_awards` already has exactly this shape (`voter_uid, created_at`) —
`votes` was simply missed.

## 3. `pruneNotifications` scans the whole table twice, every 10 minutes, forever

`src/lib/notify.ts:151-177`, run from the `*/10 * * * *` cron:

```sql
DELETE FROM notifications WHERE id IN (
  SELECT id FROM notifications WHERE read = 1 AND created_at < ? LIMIT 500
)
```

Two passes. Neither predicate has a matching index — `idx_notif_recipient` is
`(recipient_id, created_at)`, `idx_notif_unread` is partial on `(recipient_id)
WHERE read = 0`, `idx_notif_unseen` likewise on `seen = 0`. Nothing leads with
`read = 1` or bare `created_at`.

This runs **144 times a day** whether or not anything is prunable.

**Fix:** `CREATE INDEX idx_notifications_read_created ON notifications (created_at) WHERE read = 1;`
— a partial index matching the predicate exactly.

## 4. `/read/chats` — the single worst query in the codebase

`src/routes/read.ts:1222-1243`. Hot (chat list screen), **no cache, no LIMIT**:

```sql
SELECT * FROM chats
 WHERE EXISTS (SELECT 1 FROM json_each(chats.users) WHERE json_each.value = ?)
 ORDER BY updated_at DESC
```

Four problems at once:
- `json_each()` in a correlated `EXISTS` is **not indexable** → full scan of
  `chats`, invoking a table-valued function per row.
- `chats` has **no indexes at all** (`schema.ts:510-517`) → the `ORDER BY
  updated_at` is a filesort.
- **No `LIMIT`** → returns every chat the user has ever had.
- `SELECT *` drags the wide `users_data` / `last_message` JSON blobs along.

**Fix:** a `chat_members(user_id, chat_id)` join table with
`PRIMARY KEY (user_id, chat_id)`, then an indexed join + `LIMIT 30` and keyset
pagination. Same table also fixes the `json_each` membership check in
`lib/chatAuth.ts` and the `/ws` channel authorization.

## 5. One notification costs the recipient 4 D1 queries — and 4/minute when idle

`src/services/notifications/notificationService.ts:239-245` and `248-256`
register **two** `live()` subscriptions on the **same** channel with the **same**
filter:

| | Channel | Filter | Refetches |
|---|---|---|---|
| `subscribeToUnreadCount` | `user:<uid>` | `type === 'notification'` | `/read/notifications/unread-count` |
| `subscribeToNotifications` | `user:<uid>` | `type === 'notification'` | `/read/notifications` |

So one `notification` publish triggers **two** GETs, each paying the §1 auth
lookup = 4 D1 queries. Worse, each subscription carries `live()`'s default
`fallbackMs = 60000` safety poll, so a foregrounded app with **zero activity**
still costs ~4 D1 queries/minute/user.

**Fix:** have `/read/notifications` return `{ items, unreadCount }` and collapse
to one subscription. The count is already computed by an index-backed
`COUNT(*)`, so this is nearly free to add and halves the traffic.

## 6. Cron N+1: up to ~10k sequential D1 round-trips per tick

`src/cron.ts:189-213` — `for (const m of active) await resolveMatch(env, m)`,
bounded at `PAGE=50 × MAX_PAGES=20` = **1000 matches**. Each `resolveMatch` does
a contest lookup, a possible match UPDATE, a settlement batch, and **2
`createNotification()` calls** — and each `createNotification` is itself 2-4 D1
queries (`notify.ts:335` user lookup, `:353` collapse lookup, `:429` insert,
`:495` `unreadCount()` COUNT).

Also in the same tick:
- `cron.ts:226-235` — per-match `endingSoonNotified` UPDATE inside the loop;
  a textbook `db.batch()` candidate (≤50 statements).
- `broadcast.ts:154-171` — `for (const row of page) await createNotification(...)`
  = 200-400 D1 queries per tick when a broadcast is queued.
- `cron.ts:216-222` — the waiting-for-opponent drain has **no keyset cursor**, so
  if `refundWaitingMatch` no-ops it re-scans the same 50 rows 20 times.

**Fix:** batch the notification inserts (one `db.batch()` per page instead of
per row), drop the `unreadCount()` COUNT from the insert path, and add the
missing keyset cursor.

## 7. Other unindexed hot shapes

| Query | Location | Problem |
|---|---|---|
| `COUNT(*) FROM shares WHERE user_id = ? AND created_at >= ?` | `api.ts:757,791` | `shares` has **zero indexes** (`schema.ts:535-541`) → full scan on the Rewards screen |
| `COUNT(*) FROM votes WHERE voter_uid = ? AND created_at >= ?` | `api.ts:753,787` | same gap as §2 |
| `/read/stories/feed` | `read.ts:1388-1397` | `WHERE expires_at > ? ORDER BY created_at DESC LIMIT 100` — `idx_stories_expires` can't serve the sort, so **all** live stories are read and sorted. No cache. |
| `sort=hot` | `read.ts:646-664` | `ORDER BY (totalVotes + likeCount + commentCount*2 + shareCount*3)` — computed, unindexable — plus OFFSET pagination |
| `/read/users/search` | `read.ts:987-998` | `LIKE 'q%'` can't use `idx_users_username` without `COLLATE NOCASE` → full `users` scan |
| `/read/users/suggested` | `read.ts:970-985` | unfiltered `SELECT ... FROM users LIMIT 50`, no WHERE, no cache |
| `/read/users/:id` | `read.ts:1017` | unbounded `SELECT following_id FROM follows WHERE follower_id = ?` — a user following 10k accounts materialises 10k rows per cache miss |
| `/read/blog/:slug` | `read.ts:1570-1583` | fires a D1 `UPDATE viewCount` on **every** request, even on a KV hit |

## 8. `SELECT *` on wide tables

Worth fixing where it is pure waste: `read.ts:1523-1530` selects `*` from
`blog_posts` for the **list** endpoint, pulling every full article body, and
`mapBlogPost` then **drops** `content`. Same pattern on `contest_matches` for the
feed (up to 150 rows in the candidate pool) and on `users` in `/read/users/:id`,
where `fcmTokens` is read out of D1 only to be stripped in JS (`read.ts:1015`).

## What is already right

Worth stating so it does not get "optimised" later: `hydrateViewerState`
(`read.ts:91-125`) batches viewer flags with 3 parallel `inArray` queries;
`listConnections` (`read.ts:1152-1201`) is a single keyset-paginated `leftJoin`
that documents the N+1 it replaced; `rateLimit` is **KV-backed, not D1**
(`lib/rateLimit.ts:26-46`); `voteCounter.ts:464` batches its entire D1 flush;
`toggleFollow` batches edge + both counters; and `PostCard`'s `live()` deliberately
returns `shouldRefresh: false` for vote/like/comment/share events that carry
counts, so a viral match does **not** cause N clients to refetch.

One gap in that last one: `reaction` events (`api.ts:1499`) are not handled in
`PostCard`'s switch, so they hit `default: return true` → every reaction makes
all N viewers GET the uncached `/read/matches/:id`.

---

# R2

## 9. All media is served through the Worker

> **Status: RESOLVED.** `R2_PUBLIC_BASE_URL` is `https://media.tophunt.in`, the R2
> bucket's own domain, so new media skips the Worker entirely — and existing rows
> no longer wait on the backfill either: `routes/read.ts` canonicalises legacy urls
> onto the media domain on the way out (`lib/media.ts#cdnUrl`,
> `lib/r2.ts#canonicalMediaUrl`), same key, same bucket, same bytes. Running
> `scripts/media-domain-backfill.sql` is still recommended so the stored values are
> canonical and the rewrite can eventually be retired, but it no longer gates cost
> or delivery. `PRODUCTION_DOMAINS.md` §5.
>
> Note the one exception, by design: `contest-banners/images/` and
> `vs-cards/images/` keep their stored url. Those objects are deleted while their
> urls may still be referenced, and the delete path purges the colo entry for the
> stored url only — a canonicalised url would be a second cache entry nobody
> purges. See `PROXY_ONLY_PREFIXES` in `lib/media.ts`.

At the time of this audit:

```toml
R2_PUBLIC_BASE_URL = "https://tophunt-api.weadown-in.workers.dev/media"
```

Every avatar, thumbnail and image is a **Worker invocation**. The handler
(`index.ts:112-199`) is well built — content-hash keys, `immutable` +
`max-age=31536000`, and a Cache API lookup before touching R2 — so **R2 class-B
operations** are only paid on a per-colo cache miss. But the Worker request is
paid every time, cached or not.

This one config line is also the root cause of §10 and §11.

## 10. Video streaming bypasses the edge cache entirely

`wrangler.toml:123` — `BUNNY_CDN_HOSTNAME = ""`, so Bunny Stream is **disabled**
and video is served from R2 through the Worker. And in `index.ts:152`:

```ts
const useEdgeCache = !hasDeletionLifecycle && !ranged;
```

Ranged requests are deliberately excluded (storing a 206 under the full-URL key
would poison the cache — the reasoning is sound). But video players *always* use
Range requests. So **every chunk and every seek is an uncached R2 GET plus a
Worker invocation**, for the whole duration of every video watched.

This is the largest R2 operation driver the moment video gets real usage.

> **Status: largely resolved for R2-served video.** Video urls are now
> canonicalised onto `media.tophunt.in` on the read path (story `mediaUrl`, match
> participant `mediaUrl`), so the CDN satisfies ranges itself and the Worker is out
> of the loop — no invocation, no per-chunk R2 GET. This mattered more than the
> image work: video is the one case a variant helper can never cover, which is why
> `cdnUrl` is deliberately separate from `imgVariant` and independent of
> `MEDIA_TRANSFORMATIONS`.
>
> The `/media/*` route keeps the ranged-request cache bypass exactly as described,
> and that is still correct — it remains the path for already-shipped app builds
> holding absolute legacy urls, which no server-side rewrite can reach.

**Remaining fix:** finish the Bunny Stream cutover (`MEDIA_MIGRATION_PLAN.md`
already plans it) so video leaves R2 entirely.

## 11. Thumbnails serve full-size originals

`MEDIA_TRANSFORMATIONS = "false"`, and `lib/media.ts` requires a
non-`workers.dev` host with no path prefix. At audit time neither held, so
`thumbUrl()` / `optimizedUrl()` / `profileImageUrlThumb` **return the original URL**.

> **Status: RESOLVED.** Host condition holds (`https://media.tophunt.in` — real
> zone, no path prefix), Transformations is enabled on the zone, and
> `MEDIA_TRANSFORMATIONS = "true"`. Verified on production rather than assumed: the
> `cf-resized: … f=true` response header is only emitted when the resizing pipeline
> actually ran. `PRODUCTION_DOMAINS.md` §6.
>
> Measured on real production objects (WebP, `Accept: image/webp`):
>
> | Asset | Was served | Now | Saving |
> |---|---|---|---|
> | Feed contest entry → 320px thumb | 97,068 B | 15,278 B | 84% |
> | Feed contest entry → 1080px | 97,068 B | 50,638 B | 48% |
> | Avatar (rendered at 96px) | 65,757 B | 2,738 B | 96% |
> | Blog cover → 320px card | 13,875 B | 4,792 B | 65% |
>
> Two bugs were found in the process, both fixed:
>
> 1. `imgVariant` only matched the CURRENT base, so every pre-cutover row was
>    excluded from optimisation permanently. Urls are canonicalised first now.
> 2. The presets used `fit=cover`, which **upscales** a source narrower than the
>    target. The 1080 preset on a 645x1440 portrait entry produced 84,436 B —
>    *larger* than `scale-down`'s 50,638 B, and blurrier. Portrait is the common
>    shape in a DP contest, so this was the normal case. All presets are
>    `scale-down` now.

Client-side upload optimisation is good (`imageOptimize.ts:40-48`: avatars capped
at 512px, stories at 1920px), which limits the damage. But a 1920px story image
is what gets served into a grid thumbnail — wasted bandwidth on every feed
render, and a slower app.

**Fix (done):** same as §9 — a custom domain on a Cloudflare zone, then flip
`MEDIA_TRANSFORMATIONS` to `"true"`. `lib/media.ts` was already written so that
this needed **no client release**, and it did not: the Expo client had already
adopted the `*Thumb` / `*Optimized` fields with `|| mediaUrl` fallbacks, so the
flag alone turned them into real variants.

---

# Recommended order

Cheap and high-leverage first.

| # | Action | Effort | Wins |
|---|---|---|---|
| 1 | Add the 6 missing indexes (§2, §3, §7) | **S** — one migration | Turns several full scans into seeks |
| 2 | Point media at a custom domain, then enable Transformations | **S** — DNS + 1 var | Fixes §9, §10, §11 at once |
| 3 | KV-cache the blocked-account check | **S** | Removes ~1 D1 query from *every* request |
| 4 | Merge the two notification subscriptions | **S** | Halves idle traffic (§5) |
| 5 | Handle `reaction` in `PostCard.shouldRefresh` | **XS** | Removes an N-client amplifier (§8) |
| 6 | Batch the cron notification inserts, add the keyset cursor | **M** | Cuts the 10-min spike (§6) |
| 7 | `chat_members` join table | **M** | Fixes the worst query (§4) |
| 8 | Explicit column lists on the blog list + feed | **S** | Less D1 I/O per row |
| 9 | Cache `/read/stories/feed`, `/read/users/suggested` | **S** | Two uncached hot routes |

Items 1-5 are all small and together address the highest-frequency load. Item 2
is the only one needing infrastructure access rather than a code change.

**Before starting:** turn on D1 Insights and R2 metrics and capture a baseline.
Everything above is reasoned from code, and the ranking should be confirmed
against real query counts once there is production traffic.
