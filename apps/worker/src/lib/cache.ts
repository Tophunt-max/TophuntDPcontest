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
 * Drop every public cache entry a contest write can invalidate.
 *
 * Lives here rather than in routes/admin.ts because the cron sweep also mutates
 * contest rows (it ends expired ones), and a second copy of this list is how
 * one writer ends up forgetting a key and serving a contest the app should no
 * longer see.
 */
export async function invalidateContestCaches(env: Env, id?: string | string[]): Promise<void> {
  const ids = id === undefined ? [] : Array.isArray(id) ? id : [id];
  // The three list keys are shared by every contest, so they are collected once
  // rather than re-deleted per id — a batch of 200 expiries would otherwise
  // spend 600 redundant writes against KV's daily quota.
  await delCache(env, ...contestListCacheKeys(), ...ids.map(contestDetailCacheKey));
}
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

// --- fail-open ops ----------------------------------------------------------
/** Read JSON from the cache; returns null on miss OR any KV error. */
export async function cacheGetJson<T = any>(env: Env, key: string): Promise<T | null> {
  try {
    return await env.CACHE_KV.get<T>(key, "json");
  } catch {
    return null;
  }
}

/** Write JSON with a TTL; never throws (fail-open on quota / transport blips). */
export async function cachePutJson(env: Env, key: string, data: unknown, ttlSec: number): Promise<void> {
  try {
    await env.CACHE_KV.put(key, JSON.stringify(data), { expirationTtl: Math.max(60, ttlSec) });
  } catch (e) {
    console.error("[cache] put failed (continuing)", key, e);
  }
}

/** Delete one or more keys; never throws. Use to invalidate on writes. */
export async function delCache(env: Env, ...keys: string[]): Promise<void> {
  await Promise.all(
    keys.map((k) =>
      env.CACHE_KV.delete(k).catch((e) => console.error("[cache] delete failed (continuing)", k, e)),
    ),
  );
}
