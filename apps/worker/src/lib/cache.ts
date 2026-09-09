/**
 * Shared KV cache key builders + fail-open invalidation helpers.
 *
 * Cache reads/writes MUST never break a request: KV has a daily write quota,
 * and a blown quota (or transient blip) should degrade to "cache miss", never
 * a 500. So every write/delete here is wrapped and swallows errors.
 *
 * Keys are centralised in this module so the producer (routes/read.ts) and the
 * invalidator (routes/api.ts, routes/admin.ts) always agree on the exact key —
 * a stale-cache bug is usually a key-mismatch bug.
 */
import type { Env } from "../types";
import { memoDelete } from "./memo";

/**
 * Testing kill switch: skip `CACHE_KV` writes made by the read-through CACHES.
 *
 * The free plan's 1,000 KV writes/day is exhausted in a few hours by one person
 * exercising the app, and once it is, `put` returns 429 until 00:00 UTC. Setting
 * `KV_WRITES_DISABLED = "true"` lets a test session run far under the quota:
 * every cache read simply misses and the value is recomputed from D1, which is
 * the fail-open path this module is already built around.
 *
 * Scope, deliberately narrow — this flag affects CACHES and nothing else:
 *
 *   - `OTP_KV` is NEVER affected. OTP codes, send cooldowns, re-auth grants and
 *     the password-reset verified flag must persist or auth breaks outright —
 *     and "breaks" here would mean a code that cannot be verified, or a reset
 *     that no longer needs proof.
 *   - RATE LIMITING cannot be affected: its counters live in the RateLimiter
 *     Durable Object, not in KV. This flag is not a way to turn off abuse or
 *     spend protection. (An earlier version of it did exactly that, by keying off
 *     `failClosed` — see the note in lib/rateLimit.ts for why that was wrong.)
 *   - The Firebase access token and JWKS caches write through `env.CACHE_KV.put`
 *     directly and so keep writing. They are state, not cache. (The `rzp_order`
 *     payment intent used to be listed here too; it is gone — D1 `payment_orders`
 *     was always the authoritative record. See routes/api.ts `createOrder`.)
 *
 * It is still a switch that makes the app cache nothing, so it belongs in a test
 * deployment and not in a production one.
 */
export function kvWritesDisabled(env: Env): boolean {
  return String(env.KV_WRITES_DISABLED ?? "").toLowerCase() === "true";
}

/**
 * Cloudflare's MINIMUM KV expiration TTL, in seconds.
 *
 * This is not a tuning knob — it is a platform floor. `put` with a smaller
 * `expirationTtl` is rejected, so every helper here clamps up to it.
 *
 * ---------------------------------------------------------------------------
 * Why this constant is exported and asserted rather than left inline
 * ---------------------------------------------------------------------------
 * The clamp used to be a bare `Math.max(60, ttlSec)` in two different files, and
 * that quietly broke three documented freshness ceilings: `READ_CACHE_TTLS`
 * declared `matchesPage` as edge 10 + kv 20 (ceiling 30) while the value actually
 * lived 60s in KV, making the real worst case 70s. `contestList` and `leaderboard`
 * were each 20s over their stated ceiling the same way, and `cache:user` — which
 * carries a WALLET BALANCE and whose comment justifies 30s by arguing that 180s
 * "reads as a lost payment" — was really 60s.
 *
 * None of that was visible: `test/edgeCache.test.ts` asserted the arithmetic of the
 * DECLARED constants, so it stayed green while production served older data than
 * the table promised.
 *
 * The second consequence is the cost one. A key that is read continuously is
 * re-written once per TTL lapse, so the floor also sets a WRITE FLOOR of
 * 86400 / 60 = 1,440 writes/day for any hot KV cache key — against a free-plan
 * budget of 1,000/day for the entire Worker. That is why the hot read caches no
 * longer use KV at all (see lib/edgeCache.ts): at a sub-60s freshness requirement,
 * KV is not a cheaper cache, it is an unaffordable one.
 *
 * So: any cache whose freshness requirement is BELOW this floor cannot use KV, and
 * `test/kvBudget.test.ts` asserts that no KV TTL in the codebase sits under it.
 */
export const KV_MIN_TTL_SEC = 60;

// --- key builders ----------------------------------------------------------
/** Public profile of a single user (routes/read.ts GET /users/:id). */
export const userCacheKey = (uid: string) => `cache:user:${uid}`;
/**
 * First page of a user's followers / following list (routes/read.ts).
 * Only the default first page (no cursor) is cached; deeper pages fall through
 * to D1. `toggleFollow` (routes/api.ts) invalidates BOTH sides of the edge:
 * the follower's "following" list and the target's "followers" list.
 */
export const followersCacheKey = (uid: string) => `cache:followers:${uid}`;
export const followingCacheKey = (uid: string) => `cache:following:${uid}`;
/** A single published blog post by slug or id (routes/read.ts GET /blog/:slug). */
export const blogPostCacheKey = (slugOrId: string) => `cache:blog:post:${slugOrId}`;
/** Default public blog list page (routes/read.ts GET /blog?limit=N). */
export const blogListCacheKey = (limit: number) => `cache:blog:list:${limit}`;
/** Public live contest list, optionally filtered to photo or video. */
export const contestListCacheKey = (type: "photo" | "video" | "all" = "all") =>
  `cache:contest:list:${type}`;
/** Every public contest-list key that an admin write must invalidate. */
export const contestListCacheKeys = () => [
  contestListCacheKey("all"),
  contestListCacheKey("photo"),
  contestListCacheKey("video"),
];
/** Public detail for one contest template. */
export const contestDetailCacheKey = (id: string) => `cache:contest:detail:${id}`;
/**
 * Comment list for one target. `targetType` is normalised so the "matches" /
 * "contestMatches" aliases and every caller (reader + all writers) resolve to
 * the SAME key — a key mismatch is the classic stale-cache bug.
 *
 * `blog` gets its own kind rather than falling into the "post" default. Blog
 * comments live in a different table with a different id space, so sharing the
 * prefix would mean a blog article and a social post could name the same key —
 * and the payload shapes differ too (the blog thread carries a `total`), so a
 * collision would not merely serve the wrong thread, it would serve a body the
 * reader cannot interpret.
 */
export const commentsCacheKey = (targetType: string, targetId: string) => {
  const kind =
    targetType === "matches" || targetType === "contestMatches"
      ? "match"
      : targetType === "blog"
        ? "blog"
        : "post";
  return `cache:comments:${kind}:${targetId}`;
};
/**
 * Per-viewer "recently shown in the feed" map (matchId -> times shown). Powers
 * impression fatigue: battles shown repeatedly without engagement sink in the
 * For You ranking. Stored in KV (not D1) with write-behind + fail-open, so it
 * never adds to the hot database write path.
 */
export const feedSeenKey = (uid: string) => `feed:seen:${uid}`;
/**
 * Provider music-search results for a normalised query + limit.
 *
 * EDGE-ONLY (see lib/edgeCache.ts). This key embeds user-supplied search text, so
 * its key space is unbounded and caller-controlled — which is exactly why it must
 * not be a KV key. Build it from `normaliseSearchQuery` / `cappedSearchLimit` so the
 * key cannot disagree with the request that produced it.
 */
export const musicSearchCacheKey = (query: string, limit: number) =>
  `cache:music:search:${limit}:${query.toLowerCase()}`;

// --- fail-open ops ----------------------------------------------------------
/** Read JSON from the cache; returns null on miss OR any KV error. */
export async function cacheGetJson<T = any>(env: Env, key: string): Promise<T | null> {
  try {
    return await env.CACHE_KV.get<T>(key, "json");
  } catch {
    return null;
  }
}

/**
 * Write JSON with a TTL; never throws (fail-open on quota / transport blips).
 *
 * A `ttlSec` below `KV_MIN_TTL_SEC` is clamped UP, because the platform rejects it
 * outright — but it is also logged, loudly, because the clamp is exactly how three
 * documented freshness ceilings were silently exceeded for months. If you are
 * seeing this warning, the caller wants freshness KV cannot provide: move it to the
 * Cache API tier (lib/edgeCache.ts) instead of accepting the clamp.
 */
export async function cachePutJson(env: Env, key: string, data: unknown, ttlSec: number): Promise<void> {
  if (kvWritesDisabled(env)) return;
  if (ttlSec < KV_MIN_TTL_SEC) {
    console.warn(
      `[cache] ttl ${ttlSec}s for "${key}" is below KV's ${KV_MIN_TTL_SEC}s floor and was clamped — ` +
        `the effective staleness is ${KV_MIN_TTL_SEC}s, not ${ttlSec}s. Use the Cache API tier for sub-floor freshness.`,
    );
  }
  try {
    await env.CACHE_KV.put(key, JSON.stringify(data), {
      expirationTtl: Math.max(KV_MIN_TTL_SEC, ttlSec),
    });
  } catch (e) {
    console.error("[cache] put failed (continuing)", key, e);
  }
}

/**
 * Delete one or more keys; never throws. Use to invalidate on writes.
 *
 * Clears this isolate's memo (lib/memo.ts) for the same keys FIRST, so a writer
 * cannot read back the copy it just invalidated. Other isolates keep their copy
 * until its (short) memo ttl lapses — that window is why only values tolerant of
 * a few seconds of staleness are memoised at all.
 *
 * The KV delete still runs when `KV_WRITES_DISABLED` is set: deletes are metered
 * separately from writes, the daily delete quota is nowhere near the limit (16
 * used against 1,000), and skipping an invalidation would leave a stale entry
 * that outlives the test session.
 */
export async function delCache(env: Env, ...keys: string[]): Promise<void> {
  memoDelete(...keys);
  await Promise.all(
    keys.map((k) =>
      env.CACHE_KV.delete(k).catch((e) => console.error("[cache] delete failed (continuing)", k, e)),
    ),
  );
}
