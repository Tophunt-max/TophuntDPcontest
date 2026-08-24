/**
 * User-level blocking and muting — the single source of truth for both.
 *
 * Distinct from `users.isBlocked`, which is an admin disabling an account. This
 * module is about the relation between two ordinary users (migration 0032).
 *
 * Two relations, deliberately different:
 *
 *   **Block — mutual and hard.** Once A blocks B, neither sees the other
 *   anywhere and every interaction write between them is refused. Because it is
 *   mutual, every lookup unions BOTH directions of `user_blocks`; asking only
 *   "did I block them" would let the person who was blocked keep reading and
 *   commenting, which is the entire thing being prevented.
 *
 *   **Mute — one-way and soft.** The muter stops seeing the muted user's content
 *   in their feed and stories. The muted user is never told and loses nothing:
 *   they can still follow, message, comment and interact. Mute is feed curation,
 *   not safety, so it is applied to feed-shaped surfaces only — never to
 *   profiles, chats, comment threads or follower lists.
 *
 * ---------------------------------------------------------------------------
 * Three rules that are easy to get wrong
 * ---------------------------------------------------------------------------
 *
 *  1. **Filter AFTER the cache, never before.** Most hot reads in routes/read.ts
 *     are served from a viewer-agnostic KV cache: the feed candidate pool, the
 *     leaderboard, public profiles, the first page of followers and of comments.
 *     Filtering before the cache is written would poison a SHARED entry with one
 *     viewer's block list and hand it to everybody. Every call site applies
 *     these helpers to the value that came *out* of the cache.
 *
 *  2. **Reads use the cached set; writes query D1 directly.** These lookups now
 *     run on nearly every read, so the per-user set is cached in KV. But KV
 *     deletes are only eventually consistent, so a freshly-created block could
 *     stay invisible to a cached reader for a short window. That is acceptable
 *     for a feed and NOT acceptable for "can this person message me", so
 *     `assertNotBlocked` deliberately bypasses the cache and hits D1 — two
 *     index-served lookups against a tiny table, on paths that are far colder
 *     than reads.
 *
 *  3. **Invalidate BOTH uids.** A block is mutual, so it changes the exclusion
 *     set of the blocker *and* of the blocked user. Invalidating one leaves the
 *     other reading stale permissions.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";
import { cacheGetJson, cachePutJson, delCache } from "./cache";

/** Per-user cached exclusion sets (see rule 2 above). */
export const blockCacheKey = (uid: string) => `cache:blocks:${uid}`;

/**
 * Cache lifetime. Long-ish because the write paths invalidate explicitly, so the
 * TTL is only a backstop against a missed invalidation rather than the primary
 * freshness mechanism.
 */
const BLOCK_CACHE_TTL = 300;

/**
 * Hard ceiling on how many relations are loaded per user.
 *
 * The sets are used to build `NOT IN (...)` filters and in-memory lookups, so an
 * unbounded list would be both a slow query and a large KV value. Someone who
 * has blocked more than this many accounts is a pathological case (or is using
 * blocking as a bulk-filter tool); truncating degrades their filtering slightly
 * instead of degrading everyone's latency.
 */
const MAX_RELATIONS = 1000;

/**
 * Most uids to ever push into a single `NOT IN (...)` / `IN (...)` clause.
 *
 * The exclusion set is bounded by MAX_RELATIONS, but binding that many
 * parameters into one query is a different budget from holding them in memory,
 * and D1 caps bound parameters per statement. The widest list any pre-existing
 * query in this codebase builds is the feed's participant lookup (~300), so this
 * stays well inside proven territory.
 *
 * Every caller that filters in SQL therefore ALSO applies the in-memory filter to
 * the result, so a viewer past this cap still gets a correct response — the SQL
 * clause is an optimisation that keeps pages full, not the thing enforcing the
 * block. `exclusionTruncated` says when that second pass actually matters.
 */
const SQL_EXCLUSION_MAX = 100;

/** The (capped) exclusion list to bind into a SQL `NOT IN` clause. */
export function sqlExclusionList(hidden: Set<string>): string[] {
  const all = [...hidden];
  return all.length <= SQL_EXCLUSION_MAX ? all : all.slice(0, SQL_EXCLUSION_MAX);
}

/** True when `sqlExclusionList` dropped entries, so the SQL filter is partial. */
export function exclusionTruncated(hidden: Set<string>): boolean {
  return hidden.size > SQL_EXCLUSION_MAX;
}

/**
 * A short, stable fingerprint of an exclusion set, for use inside a cache key.
 *
 * The ranked feed caches a per-viewer ORDER of match ids. That order is derived
 * from the already-filtered candidate pool, so a new block takes effect at once
 * (the dropped ids no longer resolve). An UNBLOCK does not: the cached order
 * simply lacks those ids, KV clamps every TTL to a 60s floor, and per-viewer keys
 * cannot be enumerated for invalidation — so the unblocked user would stay out of
 * the feed for up to a minute even through pull-to-refresh.
 *
 * Including this in the key makes any change to the set, in either direction,
 * land on a different cache entry and therefore apply immediately.
 */
export function exclusionVersion(hidden: Set<string>): string {
  if (hidden.size === 0) return "0";
  // djb2 over the sorted uids. Not cryptographic — it only has to change when the
  // set changes, and a collision would cost at most one stale ordering.
  let h = 5381;
  for (const uid of [...hidden].sort()) {
    for (let i = 0; i < uid.length; i++) h = ((h * 33) ^ uid.charCodeAt(i)) >>> 0;
  }
  return `${hidden.size}-${h.toString(36)}`;
}

export interface BlockRelations {
  /** Uids with a block edge in EITHER direction — the safety set. */
  blocked: string[];
  /** Uids this user has blocked, i.e. the ones they are able to unblock. */
  blockedByMe: string[];
  /** Uids this user has muted (one-way). */
  muted: string[];
}

const EMPTY: BlockRelations = { blocked: [], blockedByMe: [], muted: [] };

/** Load a user's relations from D1 (three indexed lookups). */
async function loadRelations(env: Env, uid: string): Promise<BlockRelations> {
  const db = getDb(env);
  const [outgoing, incoming, mutes] = await Promise.all([
    db
      .select({ uid: schema.userBlocks.blockedId })
      .from(schema.userBlocks)
      .where(eq(schema.userBlocks.blockerId, uid))
      .limit(MAX_RELATIONS)
      .all(),
    db
      .select({ uid: schema.userBlocks.blockerId })
      .from(schema.userBlocks)
      .where(eq(schema.userBlocks.blockedId, uid))
      .limit(MAX_RELATIONS)
      .all(),
    db
      .select({ uid: schema.userMutes.mutedId })
      .from(schema.userMutes)
      .where(eq(schema.userMutes.muterId, uid))
      .limit(MAX_RELATIONS)
      .all(),
  ]);

  const blockedByMe = (outgoing as Array<{ uid: string }>).map((r) => r.uid);
  const blocked = [...new Set([...blockedByMe, ...(incoming as Array<{ uid: string }>).map((r) => r.uid)])];
  const muted = (mutes as Array<{ uid: string }>).map((r) => r.uid);
  return { blocked, blockedByMe, muted };
}

/**
 * A user's relations, KV-cached.
 *
 * Fail-open: if the lookup itself throws, an empty set is returned rather than
 * failing the read. That is the deliberate trade-off — a transient D1 blip
 * showing one extra post is better than a blank feed, and the write-path guards
 * (which never use this cache) are what actually keep two blocked users apart.
 */
export async function getRelations(env: Env, uid: string | undefined): Promise<BlockRelations> {
  if (!uid) return EMPTY;
  try {
    const cached = await cacheGetJson<BlockRelations>(env, blockCacheKey(uid));
    if (cached) return cached;
    const fresh = await loadRelations(env, uid);
    // Cached even when empty — the common case is a user with no blocks at all,
    // and that is exactly the lookup worth not repeating on every request.
    await cachePutJson(env, blockCacheKey(uid), fresh, BLOCK_CACHE_TTL);
    return fresh;
  } catch (e) {
    console.error("[blocks] getRelations failed (continuing unfiltered)", uid, e);
    return EMPTY;
  }
}

/**
 * Uids to hide for SAFETY reasons: blocks only, both directions.
 *
 * Use on surfaces where the relationship is the point — profiles, chats, comment
 * threads, follower lists, search, leaderboards.
 */
export async function blockedUidsFor(env: Env, uid: string | undefined): Promise<Set<string>> {
  return new Set((await getRelations(env, uid)).blocked);
}

/**
 * Uids to hide from FEED-shaped surfaces: blocks (both directions) plus this
 * viewer's one-way mutes.
 *
 * Use on the battle feed, the stories bar, suggested users and the notification
 * list — the places a user means when they say "stop showing me this person".
 */
export async function hiddenUidsFor(env: Env, uid: string | undefined): Promise<Set<string>> {
  const rel = await getRelations(env, uid);
  return new Set([...rel.blocked, ...rel.muted]);
}

/**
 * True when a block exists in either direction. Queries D1 directly — see rule 2.
 */
export async function isBlockedBetween(env: Env, a: string, b: string): Promise<boolean> {
  if (!a || !b || a === b) return false;
  const row = await getDb(env)
    .select({ blockerId: schema.userBlocks.blockerId })
    .from(schema.userBlocks)
    .where(
      or(
        and(eq(schema.userBlocks.blockerId, a), eq(schema.userBlocks.blockedId, b)),
        and(eq(schema.userBlocks.blockerId, b), eq(schema.userBlocks.blockedId, a)),
      ),
    )
    .get();
  return !!row;
}

/**
 * Refuse an interaction between two users when either has blocked the other.
 *
 * Reports the SAME message whichever direction the block runs in. Saying "you
 * have been blocked" would tell the blocked user exactly what happened and who
 * did it, which turns a safety tool into a notification — so both sides get the
 * neutral phrasing instead.
 */
export async function assertNotBlocked(env: Env, a: string, b: string): Promise<void> {
  if (await isBlockedBetween(env, a, b)) {
    throw httpsError("permission-denied", "This action isn't available for this account.");
  }
}

/**
 * Refuse an interaction between `uid` and ANY of `others`, in ONE query.
 *
 * The engagement actions (like / comment / react / share / vote) are about a
 * battle with two participants, so the naive version would be two sequential
 * `assertNotBlocked` calls and therefore two round-trips on a hot path. Both
 * halves of the `OR` are index-served: the first by the primary key, the second
 * by idx_user_blocks_blocked.
 */
export async function assertNotBlockedAny(env: Env, uid: string, others: Array<string | null | undefined>): Promise<void> {
  const targets = [...new Set(others.filter((o): o is string => !!o && o !== uid))];
  if (!targets.length) return;
  const row = await getDb(env)
    .select({ blockerId: schema.userBlocks.blockerId })
    .from(schema.userBlocks)
    .where(
      or(
        and(eq(schema.userBlocks.blockerId, uid), inArray(schema.userBlocks.blockedId, targets)),
        and(eq(schema.userBlocks.blockedId, uid), inArray(schema.userBlocks.blockerId, targets)),
      ),
    )
    .get();
  if (row) {
    throw httpsError("permission-denied", "This action isn't available for this account.");
  }
}

/**
 * Should `recipientId` be told about something `actorId` did?
 *
 * False when a block exists in either direction, or when the recipient has muted
 * the actor. One round-trip across both tables — this runs on every single
 * notification, so it is written as a UNION rather than two queries.
 *
 * Fail-OPEN: on error the notification is delivered. Dropping every
 * notification in the app because of a transient database blip is a much worse
 * failure than one notification getting through, and the read paths still hide
 * the actor's actual content either way.
 */
export async function isNotificationSuppressed(env: Env, recipientId: string, actorId: string): Promise<boolean> {
  if (!recipientId || !actorId || recipientId === actorId) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS hit FROM user_blocks
         WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1)
       UNION ALL
       SELECT 1 AS hit FROM user_mutes WHERE muter_id = ?1 AND muted_id = ?2
       LIMIT 1`,
    )
      .bind(recipientId, actorId)
      .first();
    return !!row;
  } catch (e) {
    console.error("[blocks] isNotificationSuppressed failed (delivering anyway)", e);
    return false;
  }
}

/**
 * Refuse an interaction with a story when its author is blocked.
 *
 * Same defence-in-depth reasoning as `assertMatchInteractionAllowed`, and the
 * same tolerance of a missing row.
 */
export async function assertStoryInteractionAllowed(env: Env, uid: string, storyId: string): Promise<void> {
  const story = await getDb(env)
    .select({ userId: schema.stories.userId })
    .from(schema.stories)
    .where(eq(schema.stories.id, storyId))
    .get();
  if (!story) return;
  await assertNotBlockedAny(env, uid, [story.userId]);
}

/**
 * Refuse an interaction with a battle when either participant is blocked.
 *
 * Defence in depth rather than the primary mechanism: a blocked user should
 * never have seen the battle in the first place, because the read paths filter
 * it out. This closes the gap for a client holding a stale feed page or calling
 * the API directly with a known match id.
 *
 * Silently allows the interaction if the match does not exist — the caller's own
 * not-found handling is the right place to report that, and duplicating it here
 * would change the error a client sees for an unrelated reason.
 */
export async function assertMatchInteractionAllowed(env: Env, uid: string, matchId: string): Promise<void> {
  const match = await getDb(env)
    .select({ userA: schema.contestMatches.userA, userB: schema.contestMatches.userB })
    .from(schema.contestMatches)
    .where(eq(schema.contestMatches.id, matchId))
    .get();
  if (!match) return;
  await assertNotBlockedAny(env, uid, [(match.userA as any)?.uid, (match.userB as any)?.uid]);
}

/**
 * Drop the block/mute cache for every uid given. Call for BOTH sides of the
 * relation on every block/unblock (rule 3).
 */
export async function invalidateBlockCache(env: Env, ...uids: string[]): Promise<void> {
  await delCache(env, ...uids.filter(Boolean).map(blockCacheKey));
}

// ---------------------------------------------------------------------------
// Filters for the shapes routes/read.ts actually returns
// ---------------------------------------------------------------------------

/**
 * Remove battles with a hidden participant.
 *
 * Participants live in the `userA` / `userB` JSON snapshots rather than as
 * foreign keys, so there is no join to filter on and this has to run in JS over
 * the page. That is also why it must run per-viewer AFTER the shared candidate
 * pool is read (rule 1).
 */
export function excludeHiddenMatches<T extends { userA?: any; userB?: any }>(
  matches: T[],
  hidden: Set<string>,
): T[] {
  if (hidden.size === 0) return matches;
  return matches.filter((m) => {
    const a = m?.userA?.uid;
    const b = m?.userB?.uid;
    return !(a && hidden.has(a)) && !(b && hidden.has(b));
  });
}

/** Remove rows whose `key` field is a hidden uid. */
export function excludeHiddenBy<T>(rows: T[], hidden: Set<string>, key: (row: T) => string | null | undefined): T[] {
  if (hidden.size === 0) return rows;
  return rows.filter((r) => {
    const uid = key(r);
    return !(uid && hidden.has(uid));
  });
}

/**
 * Resolve display rows for a set of uids, for the "blocked accounts" management
 * screen. Returns them in the order given.
 */
export async function describeUsers(env: Env, uids: string[]): Promise<
  Array<{ uid: string; username: string | null; fullName: string | null; profileImageUrl: string | null }>
> {
  if (!uids.length) return [];
  // Chunked for the same bound-parameter reason as SQL_EXCLUSION_MAX — this list
  // is user-controlled in length, so it cannot go into one `IN (...)`.
  const capped = uids.slice(0, MAX_RELATIONS);
  const chunks: string[][] = [];
  for (let i = 0; i < capped.length; i += SQL_EXCLUSION_MAX) {
    chunks.push(capped.slice(i, i + SQL_EXCLUSION_MAX));
  }
  const db = getDb(env);
  const pages = await Promise.all(
    chunks.map((chunk) =>
      db
        .select({
          uid: schema.users.uid,
          username: schema.users.username,
          fullName: schema.users.fullName,
          profileImageUrl: schema.users.profileImageUrl,
        })
        .from(schema.users)
        .where(inArray(schema.users.uid, chunk))
        .all(),
    ),
  );
  const rows = pages.flat();
  const byUid = new Map(rows.map((r: any) => [r.uid, r]));
  // A relation can outlive the account it points at (deleted user); skip those
  // rather than rendering an empty row the user cannot act on.
  return capped.map((uid) => byUid.get(uid)).filter(Boolean) as any;
}
