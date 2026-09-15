/**
 * /read — GET endpoints that replace the client's direct Firestore reads and
 * onSnapshot listeners. Realtime is achieved by polling these endpoints
 * (see the client `subscribe*` helpers). Responses use the camelCase shapes
 * the existing screens already consume, so UI code stays unchanged.
 */
import { Hono } from "hono";
import { and, or, eq, desc, asc, gt, lt, sql, inArray, notInArray, isNull, like } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getDb, schema, type NotificationActor } from "../db";
import { perPlayerEntryFee } from "../lib/money";
import { httpsError } from "../lib/http";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { getAppConfig } from "../lib/settings";
import { resolveLegalContent } from "../content/legal";
import { enrichMatchMedia, avatarUrl, thumbUrl, optimizedUrl, cdnUrl, canonicalizeMediaHtml } from "../lib/media";
import {
  userCacheKey,
  blogPostCacheKey,
  blogListCacheKey,
  contestListCacheKey,
  contestDetailCacheKey,
  commentsCacheKey,
  feedSeenKey,
  followersCacheKey,
  followingCacheKey,
  musicSearchCacheKey,
  cachePutJson,
} from "../lib/cache";
import { cachedJson, cachedResponse } from "../lib/edgeCache";
import { memoGet, memoPut } from "../lib/memo";
import { getLiveTally, getViewerVote } from "../lib/voteCounter";
import { publicPrize } from "../lib/prizes";
import { rateLimit } from "../lib/rateLimit";
import {
  searchTracks,
  searchCatalog,
  getCatalog,
  normaliseSearchQuery,
  cappedSearchLimit,
  type MusicTrack,
} from "../lib/music";
import { assertChatMember } from "../lib/chatAuth";
import {
  blockedUidsFor,
  describeUsers,
  exclusionTruncated,
  exclusionVersion,
  excludeHiddenBy,
  excludeHiddenMatches,
  getRelations,
  hiddenUidsFor,
  sqlExclusionList,
} from "../lib/blocks";
import {
  DELETED_STATUS,
  PENDING_DELETION_STATUS,
  PUBLICLY_HIDDEN_STATUSES,
  isHiddenAccountStatus,
} from "../lib/accountStatus";
import { resolveUsername } from "../lib/userIdentifiers";

export const readRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Accounts that must not appear in any public listing.
 *
 * An account that has asked to be deleted, or has already been anonymised, still
 * has a `users` row — the row is what keeps the financial ledger and other
 * people's contest results from being orphaned. Nothing here filtered on it, so
 * a deleted account stayed fully listable: it showed up in search and in Suggested
 * People as "Deleted user", it could be followed, and its profile was still
 * fetchable. Telling a user their account is gone while it is still browsable is
 * the kind of gap that makes the whole deletion promise untrue.
 *
 * `status IS NULL` is explicitly allowed: rows created before the column had a
 * default carry NULL, and a bare `NOT IN` evaluates to NULL for them — which
 * SQLite treats as false, so every legacy account would have vanished from the
 * app instead.
 */
const publiclyVisibleUser = sql`(${schema.users.status} IS NULL OR ${schema.users.status} NOT IN (${sql.join(
  PUBLICLY_HIDDEN_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)}))`;

/** The live, per-user fields that a SNAPSHOT froze and must not be trusted for. */
interface LiveUserFields {
  /** The admin verified badge. */
  verified: boolean;
  /** The user's CURRENT profile photo (raw url, un-canonicalised); null when none. */
  avatar: string | null;
  /** The user's CURRENT username (handle shown across the app). */
  username: string | null;
  /** Fallback display name when the username is empty. */
  fullName: string | null;
}

/**
 * The current verified flag, profile photo AND username/name for a batch of
 * uids, in ONE query.
 *
 * Three things about a user drift after a snapshot captures them: the admin
 * verified badge, their PROFILE PHOTO, and their USERNAME. Almost every surface
 * renders a person from a SNAPSHOT taken at write time (a battle's userA/userB
 * blob, a chat member list, a notification actor), so a user who verifies,
 * un-verifies, changes their photo, or RENAMES themselves never reaches those
 * surfaces — the old value is frozen there forever. Baking the fresh values into
 * each snapshot would only move the staleness around; instead every read that
 * shows a person looks them up live, in one batched query, and injects them, so
 * the badge, avatar and name are always current no matter how old the snapshot
 * is.
 */
async function liveUserFields(
  env: Env,
  uids: (string | null | undefined)[],
): Promise<Map<string, LiveUserFields>> {
  const unique = [...new Set(uids.filter((u): u is string => !!u))];
  if (!unique.length) return new Map();
  try {
    const rows = await getDb(env)
      .select({
        uid: schema.users.uid,
        verified: schema.users.verified,
        avatar: schema.users.profileImageUrl,
        username: schema.users.username,
        fullName: schema.users.fullName,
      })
      .from(schema.users)
      .where(inArray(schema.users.uid, unique))
      .all();
    return new Map(
      rows.map((r) => [
        r.uid,
        { verified: !!r.verified, avatar: r.avatar ?? null, username: r.username ?? null, fullName: r.fullName ?? null },
      ]),
    );
  } catch (e) {
    // This enrichment is cosmetic; a lookup failure must degrade to the snapshot
    // as-is, never break the read it decorates.
    console.error("[read] live user lookup failed", e);
    return new Map();
  }
}

/**
 * Refresh both participants of each battle from a single live lookup — the
 * verified badge, the profile photo AND the username.
 *
 * `enrichMatchMedia` has already derived `profilePicThumb` from the SNAPSHOT's
 * (possibly stale) `profilePic` by the time this runs, so both the canonical url
 * and its thumb are overwritten from the current row — otherwise a photo change
 * would reach the fallback field but not the one the client actually prefers.
 * An empty string (not null) clears a removed photo, matching the snapshot's own
 * `profilePic: "" ` convention so the client falls through to local initials.
 * The username is likewise refreshed so a rename shows on the feed; it falls
 * back to fullName, then to whatever the snapshot already had.
 *
 * Mutates the mapped match objects in place (their userA/userB are fresh copies
 * from mapMatch, not the cached row), so it is safe to run before the page is
 * cached — the fresh fields then travel with the cached copy.
 */
async function enrichParticipants(env: Env, matches: any[]): Promise<void> {
  const live = await liveUserFields(
    env,
    matches.flatMap((m) => [m?.userA?.uid, m?.userB?.uid]),
  );
  if (!live.size) return;
  const apply = (p: any) => {
    if (!p?.uid) return p;
    const u = live.get(p.uid);
    if (!u) return p;
    return {
      ...p,
      verified: u.verified,
      profilePic: cdnUrl(env, u.avatar) ?? "",
      profilePicThumb: avatarUrl(env, u.avatar) ?? "",
      username: u.username || u.fullName || p.username,
    };
  };
  for (const m of matches) {
    m.userA = apply(m.userA);
    m.userB = apply(m.userB);
  }
}

/** One read cache's lifetimes and the staleness bound it must respect. */
export interface ReadCacheTtl {
  /** Colo (Cache API) lifetime, seconds. This is the primary tier. */
  edge: number;
  /**
   * Durable KV lifetime, or `null` for edge-only.
   *
   * MUST be >= `KV_MIN_TTL_SEC` when set. A smaller number is not a shorter cache —
   * the platform clamps it up to 60s — which is exactly how three of these ceilings
   * were silently exceeded (see below).
   */
  kv: number | null;
  /** True when some writer explicitly purges this key. */
  invalidated: boolean;
  /** Worst-case staleness this endpoint must stay within, seconds. */
  ceiling: number;
}

/**
 * Read-cache lifetimes, in one table so they are reviewable together.
 *
 * ---------------------------------------------------------------------------
 * Why `kv` is now null everywhere, and what that fixed
 * ---------------------------------------------------------------------------
 * These were all two-tier (Cache API in front of KV) on the reasoning that KV is
 * the durable, globally-invalidatable tier. Two things were wrong with that:
 *
 *  1. THE COST MODEL. A KV write happens when both tiers miss, and a KV entry's
 *     lifetime is its own TTL — so writes land at ~86400/kv per key per day no
 *     matter how well the edge tier works. The edge tier saves READS, not WRITES
 *     (lib/edgeCache.ts spells this out). At KV's 60s floor that is a write floor
 *     of 1,440/day per hot key, against 1,000/day for the whole Worker.
 *
 *  2. THE CEILINGS WERE FICTION. `cachePutJson` clamps sub-60s TTLs up to 60s, so
 *     three rows here promised a bound they did not deliver, and the test asserted
 *     the DECLARED arithmetic so it never noticed:
 *
 *       matchesPage   declared 10+20 = 30   actual 10+60 = 70   (+40s)
 *       contestList   declared 20+40 = 60   actual 20+60 = 80   (+20s)
 *       leaderboard   declared 20+40 = 60   actual 20+60 = 80   (+20s)
 *
 *     The user profile was the worst of them: its comment justifies a 30s TTL by
 *     arguing that three minutes "reads as a lost payment" for a wallet balance,
 *     and it was really serving 60s.
 *
 * Edge-only fixes both at once: every ceiling below is now the literal edge TTL, and
 * every one of them is TIGHTER than what production actually served.
 *
 * ---------------------------------------------------------------------------
 * What replaces global invalidation
 * ---------------------------------------------------------------------------
 * A KV delete reached every colo; `cache.delete()` reaches only the colo running it.
 * So for the `invalidated` rows the writers now call `edgePurge`, which makes the
 * WRITER'S OWN colo consistent immediately — the colo the person who made the change
 * is almost always served from — and every other colo converges within `edge`.
 * Because `edge` here is 20–60s rather than the 300–600s the KV tier used, the
 * remote tail is short enough to be the right trade for removing the writes.
 *
 * If a future cache genuinely cannot tolerate a per-colo tail (a legal takedown with
 * a hard SLA, say), it must set `kv` — and then it must also respect the 60s floor.
 * `test/kvBudget.test.ts` enforces that rule.
 */
export const READ_CACHE_TTLS = {
  /**
   * Nothing invalidates a scheduled contest ENTERING its window (the filter is
   * `startsAt < now`), and nothing on the client can surface a contest the payload
   * omits — so 60s is a product requirement, not a cost preference. Admin edits and
   * the cron expiry sweep additionally purge, via `invalidateContestCaches`.
   */
  contestList: { edge: 60, kv: null, invalidated: true, ceiling: 60 },
  /**
   * Was 30s edge over a 300s KV entry (330s ceiling). A detail lookup is a single row
   * by primary key, so it is the cheapest query here to recompute and had the least to
   * gain from a durable tier — while being per-contest-id, i.e. the key family whose
   * count grew with the catalogue.
   *
   * 30s and NOT 60s, deliberately. This row is `invalidated`, and for an invalidated
   * row `edge` is also the POST-INVALIDATION tail in colos other than the writer's. At
   * 60s a deleted or disqualified contest would be served remotely for twice as long as
   * the 30s the old edge tail gave — the one place in this table where moving to
   * edge-only could have made a tail worse rather than better. 30s keeps every tail at
   * or below what it replaced.
   *
   * Note the cron expiry sweep has no request context, so for that writer there is no
   * colo purge at all and this TTL is the whole story. That is the reason it must stay
   * short.
   */
  contestDetail: { edge: 30, kv: null, invalidated: true, ceiling: 30 },
  /** Nothing invalidates a page of the list; a new battle appears when it lapses. */
  matchesPage: { edge: 30, kv: null, invalidated: false, ceiling: 30 },
  /** Standings move when a match resolves; nothing invalidates. */
  leaderboard: { edge: 60, kv: null, invalidated: false, ceiling: 60 },
  /**
   * The public profile, and the strictest ceiling in the table.
   *
   * It carries `dpcoin`, and NONE of the ~15 coin-mutating paths invalidate it, so
   * the TTL is the only thing bounding how long a user sees a stale balance after
   * paying an entry fee or buying coins. 30s was the intended bound all along; this
   * is the first version that actually delivers it.
   */
  userProfile: { edge: 30, kv: null, invalidated: true, ceiling: 30 },
  /**
   * First page of a comment thread. `toggleCommentLike` mutates `likeCount` on these
   * rows and does NOT purge, so the TTL alone bounds how long other viewers see a
   * stale like count — which is why it stays short. Adding a comment DOES purge.
   */
  comments: { edge: 30, kv: null, invalidated: true, ceiling: 30 },
  /**
   * First page of a followers / following list. Was 180s in KV; 30s edge-only is
   * fresher for the changes nothing purges (a member's renamed handle or new avatar)
   * as well as free.
   */
  connections: { edge: 30, kv: null, invalidated: true, ceiling: 30 },
  /**
   * Blog list and post.
   *
   * These keep the SHORTEST edge TTLs in the table because `invalidateBlogReadCache`
   * also runs for DELETE and UNPUBLISH, and a post pulled for legal reasons must
   * stop being served promptly. Previously the tail was ~10s in every colo (global
   * KV delete plus a 10s edge tail); now it is 0s in the colo that took the action
   * and <=20s elsewhere. Slightly longer remotely, immediate locally, and no longer
   * one KV write per hot article per 10 minutes.
   */
  blogList: { edge: 20, kv: null, invalidated: true, ceiling: 20 },
  blogPost: { edge: 20, kv: null, invalidated: true, ceiling: 20 },
  /**
   * Third-party music-search results. Keeps the 6h lifetime the KV version had —
   * the iTunes catalogue does not move quickly and nothing invalidates this.
   *
   * The reason it MOVED is not freshness but the shape of its key space: it embeds
   * the user's search text, so on KV it was an unbounded, caller-controlled supply of
   * writes on the Worker's scarcest quota. See `musicSearchCacheKey`.
   */
  musicSearch: { edge: 6 * 60 * 60, kv: null, invalidated: false, ceiling: 6 * 60 * 60 },
  /**
   * Suggested-users pool. Shared and viewer-AGNOSTIC — the per-viewer block/mute
   * filter runs on every request AFTER this cache, so a blocked account is never
   * baked into the shared entry (the rule lib/edgeCache.ts states for `cachedJson`).
   * Nothing invalidates it: a newly-public account simply appears when the entry
   * lapses, which for a discovery list is a freshness the TTL can own. Edge-only —
   * a pure function of `users` that a miss recomputes, needing no cross-colo purge.
   *
   * This is the endpoint the audit flagged as an unfiltered `SELECT ... FROM users
   * LIMIT 50` on every open (D1_R2_LOAD_AUDIT.md §7); the cache removes that scan
   * from the hot path entirely, and a guest pays ZERO D1 for it.
   */
  usersSuggested: { edge: 120, kv: null, invalidated: false, ceiling: 120 },
  /**
   * Stories bar. A shared base of the live stories; the per-viewer block/mute
   * filter, grouping and current-user-first ordering all run per request after the
   * cache. `expiresAt > now` is evaluated once per fill, so a story can linger in the
   * bar up to `edge` seconds past expiry — the same staleness the feed list already
   * accepts, and harmless for a bar. Edge-only for the same reason as above.
   *
   * Was uncached and read up to 100 rows on every feed open (§7). At 1500 users
   * opening the app repeatedly that was the single largest avoidable rows_read
   * source after the feed itself.
   */
  storiesFeed: { edge: 60, kv: null, invalidated: false, ceiling: 60 },
  // `satisfies`, NOT `: Record<string, ReadCacheTtl>`. A string index signature makes
  // every dotted access type-check, so a typo like `READ_CACHE_TTLS.userProfle.edge`
  // would compile as `number`, evaluate to `undefined`, fail the `edgeTtlSec > 0` guard
  // and silently serve that endpoint uncached from D1 forever — invisible to
  // test/kvBudget.test.ts, whose assertion is that zero KV writes happen, which a
  // completely disabled cache also satisfies. This keeps the field checking and the
  // literal keys.
} satisfies Record<string, ReadCacheTtl>;

/**
 * Hydrate per-viewer engagement state (vote / like / bookmark) onto a PUBLIC
 * match list without polluting the shared cache. The base list is identical for
 * every caller (cacheable); this runs per-request for the signed-in viewer only
 * and returns fresh copies so the cached array objects are never mutated.
 *
 * Three indexed batch queries cover the whole page. A vote cast within the last
 * flush window (~5s) may not be persisted to D1 yet; the per-match live
 * subscription (/read/matches/:id, served from the VoteCounter DO) reconciles
 * that momentary gap. Without this, the feed always renders "not voted / not
 * liked" on load and only corrects once each card's live() refetch of
 * /matches/:id returns the viewer's own state.
 */
async function hydrateViewerState(db: any, matches: any[], uid: string): Promise<any[]> {
  const ids = matches.map((m) => m?.id).filter(Boolean) as string[];
  if (ids.length === 0) return matches;
  const [voteRows, likeRows, bookmarkRows] = await Promise.all([
    db
      .select({ matchId: schema.votes.matchId, votedForUid: schema.votes.votedForUid })
      .from(schema.votes)
      .where(and(eq(schema.votes.voterUid, uid), inArray(schema.votes.matchId, ids)))
      .all(),
    db
      .select({ matchId: schema.matchLikes.matchId })
      .from(schema.matchLikes)
      .where(and(eq(schema.matchLikes.userId, uid), inArray(schema.matchLikes.matchId, ids)))
      .all(),
    db
      .select({ matchId: schema.bookmarks.matchId })
      .from(schema.bookmarks)
      .where(and(eq(schema.bookmarks.userId, uid), inArray(schema.bookmarks.matchId, ids)))
      .all(),
  ]);
  const voteByMatch = new Map<string, string>(
    (voteRows as Array<{ matchId: string; votedForUid: string }>).map((r) => [r.matchId, r.votedForUid]),
  );
  const likedSet = new Set<string>((likeRows as Array<{ matchId: string }>).map((r) => r.matchId));
  const bookmarkedSet = new Set<string>((bookmarkRows as Array<{ matchId: string }>).map((r) => r.matchId));
  return matches.map((m) => {
    const votedForUid = voteByMatch.get(m.id) ?? null;
    return {
      ...m,
      hasVoted: !!votedForUid,
      votedForUid,
      isLiked: likedSet.has(m.id),
      isBookmarked: bookmarkedSet.has(m.id),
    };
  });
}

// ============================ FEED RANKING ================================
// Instagram-style ranking: a two-stage recommender.
//   1) Candidate generation — a user-agnostic pool scored by content signals
//      (freshness, engagement velocity, closing-soon urgency, prize). Cached
//      briefly and shared by everyone, so D1 sees ~one query per window.
//   2) Personalized re-rank — cheap per-viewer signals (affinity: do you follow
//      a participant?; novelty: have you already voted?) adjust that base score.
// This mirrors how large feeds work (candidate gen + ranking) while staying
// light enough for D1 + the edge cache.
const FEED_CANDIDATE_POOL = 150;
const FEED_RESULT_WINDOW_MS = 24 * 60 * 60 * 1000; // keep finished battles visible ~1 day
const FEED_RESULT_POOL = 40; // recently-finished battles pulled into the pool
const FEED_RESULT_TAU_H = 10; // result-freshness decay (hours) for finished battles
const FEED_DIVERSITY_WINDOW = 2; // don't repeat a participant within N neighbouring slots
const FEED_AFFINITY_LOOKBACK = 500; // cap on how many past votes/visits we scan
const FEED_SEEN_MAX_KEYS = 300; // bound the per-user seen map size in KV
const FEED_SEEN_TTL = 3 * 86_400; // fatigue persists ~3 days
/**
 * Candidate-pool and per-viewer-order lifetimes, in ISOLATE MEMORY (see the note
 * at the `candKey` read). Same durations the KV versions used, so feed freshness
 * and pagination stability are unchanged — only the storage moved.
 */
const FEED_POOL_TTL = 45;
const FEED_ORDER_TTL = 60;
/**
 * How long the viewer's fatigue map stays in isolate memory.
 *
 * This is the working copy: it is updated on EVERY feed load, so fatigue is as
 * accurate as it was before. Only the durable KV copy is throttled below.
 */
const FEED_SEEN_MEMO_TTL = 900;
/**
 * Minimum gap between durable KV writes of the fatigue map, per viewer.
 *
 * `bumpSeen` used to `put` on every single feed request with no ttl gating of any
 * kind, which made it the largest consumer of the free plan's 1,000 KV
 * writes/day: a client that refreshes the feed every 10 seconds spends 360
 * writes an hour, so one person scrolling for three hours exhausted the entire
 * daily quota on impression tracking alone — and then every OTHER cache write in
 * the Worker started failing with 429 for the rest of the day.
 *
 * Throttling only the FLUSH (not the counting) is what makes this free: the
 * increments land in isolate memory immediately, so within a session the ranking
 * sees exactly the counts it saw before. KV is only the copy that has to survive
 * an isolate going away, and a fatigue map is the definition of data that can
 * afford to lose its last few minutes.
 *
 * Raised 5min -> 15min, which takes the per-active-viewer cost from ~288 writes/day
 * to ~96. This is now the LARGEST remaining KV write source in the Worker — it is
 * the only one that scales with active users rather than with content — so it is
 * also the one worth being least generous with. The cost of the longer window is
 * bounded and self-correcting: an isolate eviction loses at most 15 minutes of one
 * viewer's impression counts, after which the ranking simply shows them a battle
 * they had already scrolled past once.
 *
 * It cannot move off KV. Unlike the read caches, this value is not recomputable from
 * D1 — it IS the record — and it must be shared across the isolates and colos
 * serving one viewer, which rules out both isolate memory alone and the per-colo
 * Cache API. A Durable Object per viewer would work and would remove the KV write
 * entirely; it is the right next step if this ever needs to go lower, and is not
 * taken here because 96 writes/day per active viewer is affordable and a DO per user
 * is a materially bigger change than a constant.
 */
const FEED_SEEN_FLUSH_INTERVAL_MS = 15 * 60_000;

/**
 * The viewer's impression-fatigue state.
 *
 * `flushedAt` is stored INSIDE the value rather than under a second key because
 * a separate "last flushed" key would itself need a write per flush, which is
 * the cost being removed.
 */
/** Current envelope version. Bumping this REQUIRES reading the note in parseSeen. */
const FEED_SEEN_VERSION = 2;

interface SeenState {
  /** matchId -> times shown to this viewer. */
  map: Record<string, number>;
  /** ms since epoch of the last durable KV write. */
  flushedAt: number;
  /**
   * True when this state could not be loaded and is therefore NOT the viewer's
   * real history. Such a state is never memoised and never flushed — see
   * `loadSeen`.
   */
  transient?: boolean;
}

/**
 * Coerce whatever is in KV into a `SeenState`.
 *
 * BACKWARD compatibility: the pre-existing shape had the value BE the bare
 * `matchId -> count` map. Those entries have a 3-day ttl, so they keep arriving
 * for three days after this deploys, and treating one as an empty map would
 * silently reset fatigue for every currently-active user. The `v` marker is what
 * distinguishes them — a structural guess ("does it have a `map` property?") would
 * misread a legacy map that happened to contain a match id called `map`, and
 * because the counts are NESTED under `map` rather than spread, no legacy id can
 * collide with the envelope's own fields either.
 *
 * FORWARD compatibility, which matters just as much: a Cloudflare deploy is not
 * atomic across colos, so if this envelope is ever versioned up to 3, isolates
 * still running THIS code will read that value. Without the version check below
 * they would take the whole envelope as the count map and increment
 * `map.map` — `Math.min((obj || 0) + 1, 99)` on a nested object is `NaN`, which
 * then flushes back to KV as `null` and corrupts the entry for every reader. So an
 * unrecognised version is treated as "start over": lossy, never destructive.
 */
function parseSeen(raw: unknown): SeenState {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, any>;
    if (obj.v === FEED_SEEN_VERSION && obj.map && typeof obj.map === "object") {
      return { map: obj.map as Record<string, number>, flushedAt: Number(obj.flushedAt) || 0 };
    }
    // A version we do not understand — from a newer deploy. Do not try to read it.
    if (typeof obj.v === "number") return { map: {}, flushedAt: 0 };
    // Legacy: the value itself is the map. flushedAt 0 means "flush on next
    // bump", which upgrades the entry to the new shape on first use.
    return { map: obj as Record<string, number>, flushedAt: 0 };
  }
  return { map: {}, flushedAt: 0 };
}

/** Bound the map to the most-penalising ids. Mutates and returns the same object. */
function pruneSeen(map: Record<string, number>): Record<string, number> {
  const keys = Object.keys(map);
  if (keys.length > FEED_SEEN_MAX_KEYS) {
    // Drop the least-seen entries first — they need the least fatigue.
    keys.sort((a, b) => (map[a] || 0) - (map[b] || 0));
    for (const k of keys.slice(0, keys.length - FEED_SEEN_MAX_KEYS)) delete map[k];
  }
  return map;
}

/**
 * The viewer's fatigue state, preferring this isolate's working copy.
 *
 * Both readers go through here — the ranker and `bumpSeen` — so they always agree
 * on the same object, and the ranker sees increments this isolate has not flushed
 * yet.
 *
 * Reads KV directly rather than through `cacheGetJson`, because that helper
 * collapses "missing" and "the read failed" into the same `null`. That distinction
 * was harmless when every request re-read KV, but it is not harmless now: an empty
 * map produced by a transport blip would be memoised for FEED_SEEN_MEMO_TTL, have
 * its ttl refreshed on every subsequent load, and be flushed over up to three days
 * of real history. A failed read therefore returns a `transient` state that is
 * neither cached nor written back, so the next request simply tries KV again.
 */
async function loadSeen(env: Env, uid: string): Promise<SeenState> {
  const key = feedSeenKey(uid);
  const memo = memoGet<SeenState>(key);
  if (memo) return memo;
  let raw: unknown;
  try {
    raw = await env.CACHE_KV.get(key, "json");
  } catch (e) {
    console.error("[feed] seen load failed (not caching, not flushing)", uid, e);
    return { map: {}, flushedAt: Date.now(), transient: true };
  }
  const state = parseSeen(raw);
  memoPut(key, state, FEED_SEEN_MEMO_TTL);
  return state;
}

/**
 * Tunable ranking weights. Defaults live here but can be overridden at runtime
 * from the `appConfig.feedWeights` setting (admin panel) — so the feed can be
 * A/B-tuned without a redeploy. Missing keys fall back to these.
 */
interface FeedWeights {
  freshness: number;
  velocity: number;
  urgency: number;
  prize: number;
  follow: number;
  votedAffinity: number;
  visitAffinity: number;
  votedPenalty: number;
  seenPenalty: number;
  seenCap: number;
  result: number; // prominence bump for a freshly-finished battle's result
  resultVotedBoost: number; // extra bump when you voted on that finished battle
}
const FEED_DEFAULT_WEIGHTS: FeedWeights = {
  freshness: 2.2,
  velocity: 1.6,
  urgency: 1.2,
  prize: 0.3,
  follow: 3.0,
  votedAffinity: 1.5,
  visitAffinity: 1.0,
  votedPenalty: 1.5,
  seenPenalty: 0.6,
  seenCap: 5,
  result: 2.6,
  resultVotedBoost: 2.0,
};

async function getFeedWeights(env: Env): Promise<FeedWeights> {
  try {
    const cfg = await getAppConfig(env);
    const w = cfg?.feedWeights;
    if (w && typeof w === "object") {
      const merged = { ...FEED_DEFAULT_WEIGHTS } as Record<string, number>;
      for (const k of Object.keys(FEED_DEFAULT_WEIGHTS)) {
        if (typeof w[k] === "number" && Number.isFinite(w[k])) merged[k] = w[k];
      }
      return merged as unknown as FeedWeights;
    }
  } catch {
    /* fall through to defaults */
  }
  return FEED_DEFAULT_WEIGHTS;
}

/**
 * Write-behind impression tracking (fail-open). Increments the times each served
 * battle was shown to this viewer, prunes to the most-penalising keys, and never
 * throws — so a blip can't break the feed and it never touches D1.
 *
 * Two tiers, for the reason set out on FEED_SEEN_FLUSH_INTERVAL_MS: counts are
 * updated in isolate memory on every call, and pushed to KV at most once every
 * five minutes per viewer.
 */
async function bumpSeen(env: Env, uid: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const key = feedSeenKey(uid);
    const state = await loadSeen(env, uid);
    // Could not read the real history — counting onto an empty map and writing it
    // back would erase it. Skip entirely; one lost page of impressions is nothing.
    if (state.transient) return;

    const map = state.map;
    for (const id of ids) map[id] = Math.min((map[id] || 0) + 1, 99);
    pruneSeen(map);

    // memo holds the state BY REFERENCE, so the mutations above are already
    // visible to the next request in this isolate. Re-put to refresh its ttl and
    // to cover the cold-miss case where `loadSeen` built the object itself.
    memoPut(key, state, FEED_SEEN_MEMO_TTL);

    const now = Date.now();
    if (now - state.flushedAt < FEED_SEEN_FLUSH_INTERVAL_MS) return;
    // Claim the flush window BEFORE awaiting, so two concurrent requests in this
    // isolate cannot both decide to write.
    state.flushedAt = now;

    // Merge with the durable copy instead of overwriting it.
    //
    // This request's isolate is not the only one serving this viewer, and it has
    // not re-read KV since it warmed its memo. A blind write would discard
    // whatever another isolate flushed in the meantime, so counts would converge
    // on the maximum held by any ONE isolate rather than on the real total —
    // fatigue would quietly weaken by roughly the isolate fan-out.
    //
    // Per-id MAX, not sum: both copies descend from the same durable baseline, so
    // adding them would double-count everything already flushed.
    let merged = map;
    try {
      const durable = parseSeen(await env.CACHE_KV.get(key, "json"));
      merged = { ...durable.map };
      for (const [id, count] of Object.entries(map)) {
        merged[id] = Math.min(Math.max(merged[id] || 0, count), 99);
      }
      pruneSeen(merged);
      // Adopt the merged view so this isolate stops diverging from KV.
      state.map = merged;
      memoPut(key, state, FEED_SEEN_MEMO_TTL);
    } catch (e) {
      // Merge is an improvement, not a requirement. On a read failure write what
      // this isolate knows rather than losing the flush.
      console.error("[feed] seen merge failed (writing local view)", uid, e);
      merged = map;
    }

    await cachePutJson(env, key, { v: FEED_SEEN_VERSION, map: merged, flushedAt: now }, FEED_SEEN_TTL);
  } catch {
    /* fail-open: impression fatigue is best-effort */
  }
}

/**
 * Spread out battles that share a participant so one creator can't dominate
 * several consecutive slots (Instagram-style diversity pass). Greedy: keep the
 * score order, but skip a candidate whose participant appeared in the last
 * `window` picks and take the next distinct one instead.
 */
function diversifyFeed(items: any[], window: number): any[] {
  if (items.length <= 2) return items;
  const pool = items.slice();
  const out: any[] = [];
  const recent: string[] = [];
  while (pool.length > 0) {
    let idx = pool.findIndex((m) => {
      const a = m.userA?.uid;
      const b = m.userB?.uid;
      return !(a && recent.includes(a)) && !(b && recent.includes(b));
    });
    if (idx === -1) idx = 0; // everything conflicts → take the best remaining
    const [chosen] = pool.splice(idx, 1);
    out.push(chosen);
    if (chosen.userA?.uid) recent.push(chosen.userA.uid);
    if (chosen.userB?.uid) recent.push(chosen.userB.uid);
    while (recent.length > window * 2) recent.shift();
  }
  return out;
}

/** User-agnostic content score for one match (higher = show sooner). */
function rankBaseScore(r: any, now: number, w: FeedWeights): number {
  const isCompleted = r.status === "completed";
  const startedAt = Number(r.activatedAt || r.createdAt || now);
  const finishedAt = Number(r.expiresAt || startedAt);
  const startAgeH = Math.max(0, (now - startedAt) / 3_600_000);
  const lifetimeH = Math.max(0.5, (finishedAt - startedAt) / 3_600_000);

  let reactions = 0;
  if (r.reactions && typeof r.reactions === "object") {
    for (const v of Object.values(r.reactions)) reactions += Number(v) || 0;
  }
  // Weighted engagement: shares > comments > likes/votes (harder actions count more).
  const engagement =
    (Number(r.totalVotes) || 0) +
    (Number(r.likeCount) || 0) +
    (Number(r.commentCount) || 0) * 2 +
    (Number(r.shareCount) || 0) * 3 +
    reactions;

  // Active: engagement rate since it started (a new hot battle out-ranks an old
  // slow one). Completed: average rate over its whole life (how hot it was).
  const velocity = engagement / ((isCompleted ? lifetimeH : startAgeH) + 2);

  // Active freshness decays from when it started. Completed "result freshness"
  // decays from when it FINISHED — a just-declared winner is fresh content, so
  // it surfaces near the top and only sinks as the result ages.
  const finishAgeH = Math.max(0, (now - finishedAt) / 3_600_000);
  const freshness = isCompleted
    ? Math.exp(-finishAgeH / FEED_RESULT_TAU_H)
    : Math.exp(-startAgeH / 24);

  // Closing-soon urgency only applies while voting is open.
  let urgency = 0;
  if (!isCompleted && Number.isFinite(finishedAt)) {
    const hoursLeft = (finishedAt - now) / 3_600_000;
    if (hoursLeft > 0 && hoursLeft <= 6) urgency = 1 - hoursLeft / 6;
  }
  const prize = Math.log1p(Number(r.entryFee) || 0);

  let score = w.freshness * freshness + w.velocity * Math.log1p(velocity) + w.urgency * urgency + w.prize * prize;
  // Prominence bump for a fresh result so winners surface instead of sinking to
  // the bottom; scaled by result-freshness so it fades as the result ages.
  if (isCompleted) score += w.result * freshness;
  return score;
}

/**
 * Serve the personalized "For You" feed. Candidate pool is cached user-agnostic;
 * the per-viewer re-rank + engagement hydration run per request (never cached).
 * Pagination is offset-based over the ranked pool (stable within a cache window).
 */
async function servePersonalizedFeed(
  c: any,
  db: any,
  opts: { status: string; type?: string; limit: number; cursorRaw?: string; uid?: string; following?: boolean },
) {
  const { status, type, limit, cursorRaw, uid, following } = opts;
  const now = Date.now();
  const w = await getFeedWeights(c.env);

  // The "Following" tab is inherently personal — signed-out users get nothing.
  if (following && !uid) return c.json({ items: [], nextCursor: null });

  // The candidate pool and the per-viewer order below live in ISOLATE MEMORY, not
  // KV. Both are written on a cache MISS, so their write rate is set purely by
  // their ttl: at 45s and 60s that was ~1,920 and ~1,440 KV writes a day
  // respectively — either one alone over the free plan's 1,000/day budget for the
  // entire Worker, which is why throttling `bumpSeen` did not fix the quota on its
  // own.
  //
  // Neither is a correctness dependency. Both are pure functions of D1 rows plus
  // the ranking weights, and a miss simply recomputes them — which is exactly what
  // a KV miss already did. Moving them to memory therefore trades a KV write for
  // one D1 query per isolate per window. That is the right trade here: D1's free
  // allowance is measured in millions of rows a day and this query is two indexed
  // reads capped at 190 rows, while KV writes are the scarce resource by three
  // orders of magnitude. If isolate fan-out ever grows enough for the repeated D1
  // query to matter, the answer is a longer window, not a return to KV.
  const candKey = `cache:matches:cand:${status}:${type || "all"}`;
  // Cloned on the way out. The memo hands back the SAME object it stored, and the
  // enrichment below mutates match objects in place, so a shared pool would let one
  // request's edits leak into every later request's view of the cache. Reading from
  // KV used to give each caller a private copy for free (it deserialises), and this
  // keeps that property — at less cost than the JSON.parse it replaces.
  const pooled = memoGet<any[]>(candKey);
  let candidates: any[] | null = pooled ? structuredClone(pooled) : null;
  if (!candidates) {
    const typeConds = type ? [eq(schema.contestMatches.type, type)] : [];
    const activeRows = await db
      .select()
      .from(schema.contestMatches)
      .where(and(eq(schema.contestMatches.status, status), ...typeConds))
      .orderBy(desc(schema.contestMatches.createdAt))
      .limit(FEED_CANDIDATE_POOL)
      .all();
    let rows = activeRows as any[];
    // On the live feed (status=active), also surface recently-finished battles
    // so their winner/result stays visible for a while instead of vanishing the
    // moment a winner is declared. Ranking (freshness) keeps them below active.
    if (status === "active") {
      const cutoff = now - FEED_RESULT_WINDOW_MS;
      const completedRows = await db
        .select()
        .from(schema.contestMatches)
        .where(and(eq(schema.contestMatches.status, "completed"), gt(schema.contestMatches.expiresAt, cutoff), ...typeConds))
        .orderBy(desc(schema.contestMatches.expiresAt))
        .limit(FEED_RESULT_POOL)
        .all();
      rows = [...activeRows, ...(completedRows as any[])];
    }
    candidates = rows
      .map((r) => ({ ...enrichMatchMedia(c.env, mapMatch(r)), _base: rankBaseScore(r, now, w) }))
      .sort((a, b) => b._base - a._base);
    await enrichParticipants(c.env, candidates);
    // Store a clone for the same reason it is cloned on read: this request goes on
    // to filter and rank `candidates`, and must not be able to reach the cached copy.
    memoPut(candKey, structuredClone(candidates), FEED_POOL_TTL);
  }

  // Per-viewer block/mute filter, applied to the value that came OUT of the
  // shared pool and AFTER it has been written back. Filtering before the
  // cachePut above would store one viewer's exclusions in an entry every other
  // viewer then reads.
  //
  // Doing it here rather than further down also covers the cached-order branch
  // below for free: that branch rebuilds the page by looking each cached id up
  // in `byId`, so an id dropped from `candidates` resolves to undefined and is
  // already discarded by its `.filter(Boolean)`. Without this, a block would
  // take up to the 60s order-cache TTL to take effect.
  //
  // A battle is dropped when EITHER participant is hidden, and this set includes
  // mutes. Muting one creator therefore also hides the battles of whoever they
  // are up against: a 1-v-1 card is half each person's photo, so there is no
  // version of it with the muted side omitted, and showing it would defeat the
  // mute. Accepted deliberately — the alternative is showing muted content.
  let hidden = new Set<string>();
  if (uid) {
    hidden = await hiddenUidsFor(c.env, uid);
    candidates = excludeHiddenMatches(candidates, hidden);
  }

  // Per-user ranked order is cached briefly. On load-more / repeat requests
  // within the TTL we reuse it: this skips the affinity re-queries AND keeps
  // pagination stable (the feed doesn't reshuffle as you scroll).
  // The exclusion version is part of the key so that UNBLOCKING also takes effect
  // immediately — see exclusionVersion() in lib/blocks.ts for why filtering the
  // pool alone only fixes the block direction.
  const orderKey = uid
    ? `cache:feedorder:${uid}:${following ? "following" : "foryou"}:${status}:${type || "all"}:${exclusionVersion(hidden)}`
    : "";
  // Isolate memory, not KV — see the note on the candidate pool above. A plain
  // string[], and the reader below only maps over it, but it is copied anyway so
  // that this cache cannot be reached through the value it handed out.
  const storedOrder = uid && candidates.length > 0 ? memoGet<string[]>(orderKey) : undefined;
  const cachedOrder = storedOrder ? storedOrder.slice() : null;

  let ranked: any[];
  if (uid && candidates.length > 0 && Array.isArray(cachedOrder)) {
    const byId = new Map<string, any>(candidates.map((m) => [m.id, m]));
    ranked = (cachedOrder as string[]).map((id) => byId.get(id)).filter(Boolean);
  } else if (uid && candidates.length > 0) {
    const participantUids = Array.from(
      new Set(candidates.flatMap((m) => [m.userA?.uid, m.userB?.uid]).filter(Boolean) as string[]),
    );
    // Three cheap per-viewer affinity signals ("your history with this creator"):
    //   follows (strongest), past votes (backed them before), profile visits.
    const [followRows, voteRows, visitRows, seenState] = await Promise.all([
      participantUids.length
        ? db
            .select({ following: schema.follows.followingId })
            .from(schema.follows)
            .where(and(eq(schema.follows.followerId, uid), inArray(schema.follows.followingId, participantUids)))
            .all()
        : Promise.resolve([] as Array<{ following: string }>),
      db
        .select({ matchId: schema.votes.matchId, votedForUid: schema.votes.votedForUid })
        .from(schema.votes)
        .where(eq(schema.votes.voterUid, uid))
        .limit(FEED_AFFINITY_LOOKBACK)
        .all(),
      db
        .select({ userId: schema.profileVisits.userId })
        .from(schema.profileVisits)
        .where(eq(schema.profileVisits.visitorId, uid))
        .limit(FEED_AFFINITY_LOOKBACK)
        .all(),
      loadSeen(c.env, uid),
    ]);
    const followSet = new Set((followRows as Array<{ following: string }>).map((r) => r.following));
    // Same scan gives both the affinity set (creators backed) and the novelty
    // set (this exact battle already voted on).
    const votedForSet = new Set((voteRows as Array<{ votedForUid: string }>).map((r) => r.votedForUid));
    const votedMatchSet = new Set((voteRows as Array<{ matchId: string }>).map((r) => r.matchId));
    const visitedSet = new Set((visitRows as Array<{ userId: string }>).map((r) => r.userId));
    const seen = seenState.map;

    let scored = candidates.map((m) => {
      const a = m.userA?.uid;
      const b = m.userB?.uid;
      let s = m._base as number;
      const followed = followSet.has(a) || followSet.has(b);
      if (followed) s += w.follow;
      if (votedForSet.has(a) || votedForSet.has(b)) s += w.votedAffinity;
      if (visitedSet.has(a) || visitedSet.has(b)) s += w.visitAffinity;
      if (m.status === "completed") {
        // Finished battle: you voted on it → you want to see who won, so boost
        // its result to you (the opposite of the active-feed novelty penalty).
        // No impression fatigue either — results only live for the short window.
        if (votedMatchSet.has(m.id)) s += w.resultVotedBoost;
      } else {
        if (votedMatchSet.has(m.id)) s -= w.votedPenalty;
        // Impression fatigue: shown before but not voted on → demote, scaled by
        // how many times it was shown (capped).
        const seenCount = seen[m.id] || 0;
        if (seenCount > 0 && !votedMatchSet.has(m.id)) {
          s -= w.seenPenalty * Math.min(seenCount, w.seenCap);
        }
      }
      return { m, s, followed };
    });
    // "Following" tab: keep only battles featuring someone the viewer follows.
    if (following) scored = scored.filter((x) => x.followed);
    // Diversity pass so one creator doesn't stack several battles in a row.
    ranked = diversifyFeed(scored.sort((a, b) => b.s - a.s).map((x) => x.m), FEED_DIVERSITY_WINDOW);
    // Cache the id order for stable, cheap pagination within the window.
    memoPut(orderKey, ranked.map((m) => m.id), FEED_ORDER_TTL);
  } else if (following) {
    ranked = []; // signed-in but no candidates, or the empty-pool case
  } else {
    // Signed-out: shared content ranking + diversity (no personalization).
    ranked = diversifyFeed(candidates, FEED_DIVERSITY_WINDOW);
  }

  const offset = cursorRaw ? Math.max(parseInt(cursorRaw, 10) || 0, 0) : 0;
  const pageItems = ranked.slice(offset, offset + limit).map((m) => {
    const { _base, ...rest } = m; // strip the internal score from the response
    return rest;
  });
  const nextCursor = offset + limit < ranked.length ? offset + limit : null;
  if (nextCursor != null) c.header("X-Next-Cursor", String(nextCursor));

  // Record what we just showed this viewer (write-behind, KV) so repeatedly
  // shown-but-ignored battles fatigue on the next load.
  if (uid && pageItems.length > 0) {
    c.executionCtx.waitUntil(bumpSeen(c.env, uid, pageItems.map((m: any) => m.id)));
  }

  if (uid) {
    c.header("Cache-Control", "private, no-store");
    return c.json({ items: await hydrateViewerState(db, pageItems, uid), nextCursor });
  }
  c.header("Cache-Control", "public, max-age=15");
  return c.json({ items: pageItems, nextCursor });
}

// --- mappers ---------------------------------------------------------------
const mapContest = (r: any) => ({
  id: r.id,
  ...(r.extra || {}),
  title: r.title,
  name: r.title,
  type: r.type,
  bannerUrl: r.bannerUrl ?? (r.extra?.bannerUrl) ?? null,
  status: r.status,
  totalEntryFee: r.totalEntryFee,
  entryFishCoins: r.totalEntryFee,
  entryDpcoin: r.totalEntryFee,
  // What ONE player is actually charged, computed by the same function the
  // ledger uses. totalEntryFee is the pot for both players, and every screen
  // was halving it by hand — inconsistently, so two of them advertised double
  // the real price. Serve the number instead of asking each card to derive it.
  entryFeePerPlayer: perPlayerEntryFee(r.totalEntryFee),
  rewardCoins: r.rewardCoins,
  winningCoins: r.rewardCoins,
  // What the winner actually gets. One helper (lib/prizes.ts publicPrize) so every
  // surface — Explore, both contest lists, the setup screens — reads the prize the
  // same way, which is the lesson `contestPricing` already taught about entry fees
  // being computed five different ways.
  ...publicPrize(r),
  voteDurationDays: r.voteDurationDays,
  autoCancelHours: r.autoCancelHours,
  minVotes: r.minVotes,
  // Validity window as ABSOLUTE epoch milliseconds, deliberately not a
  // precomputed "seconds remaining": this response is cached for 60s (KV +
  // Cache-Control below), so a relative figure would be served up to a minute
  // stale and every client's countdown would be wrong by that much. Null on
  // either side means unbounded. The app counts down against endsAt itself.
  startsAt: r.startsAt ?? null,
  endsAt: r.endsAt ?? null,
  // Free vs paid is derived, not stored twice. Derived from the PER-PLAYER fee
  // rather than the pot so it can never contradict the price shown next to it:
  // perPlayerEntryFee floors, so a legacy odd total of 1 charges nobody
  // anything, and testing the pot instead would label that contest "paid" and
  // then quote it at 0 coins.
  isFree: perPlayerEntryFee(r.totalEntryFee) <= 0,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
});

const mapMatch = (r: any) => ({
  id: r.id,
  contestId: r.contestId,
  status: r.status,
  type: r.type,
  title: r.title,
  entryFee: r.entryFee,
  isPrivate: r.isPrivate,
  invitedUid: r.invitedUid,
  joinIdA: r.joinIdA,
  joinIdB: r.joinIdB,
  userA: r.userA,
  userB: r.userB,
  totalVotes: r.totalVotes,
  likeCount: r.likeCount,
  commentCount: r.commentCount,
  shareCount: r.shareCount,
  winnerUid: r.winnerUid,
  rewardAmount: r.rewardAmount,
  /**
   * The match's own prize snapshot, so a client can say what a battle is worth
   * without also fetching its contest template.
   *
   * `publicPrize` degrades a NULL `prize_type` to `coins`, which is right for the
   * rows that have one: `prize_type` is NULL only on matches written before
   * migration 0042, and every contest that existed then awarded coins. Matches
   * created since carry the real snapshot (see `startMatch`).
   *
   * `prizeProductDescription` is therefore always null here — `contest_matches` has
   * four prize columns, not five. That is deliberate: the description is contest
   * copy, not part of what settlement owes, so it does not need freezing. Read it
   * from the contest template if a screen ever wants it.
   */
  ...publicPrize(r),
  /**
   * The composite head-to-head image, once a client has produced one
   * (migration 0033). Null is normal and permanent for battles created before
   * this existed, or where capture is unavailable — every reader must fall back
   * to laying the two entries out itself.
   */
  vsImageUrl: r.vsImageUrl ?? null,
  minVotesRequired: r.minVotesRequired,
  endingSoonNotified: r.endingSoonNotified,
  createdAt: r.createdAt,
  activatedAt: r.activatedAt,
  completedAt: r.completedAt,
  expiresAt: r.expiresAt,
});

const mapNotification = (env: Env, r: any) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  type: r.type,
  read: !!r.read,
  targetId: r.targetId,
  image: r.image,
  // Lightweight 128px variant for the 48px row image — cuts R2/CDN bytes on the
  // wire. Falls back to the original URL for external/non-R2 images.
  imageThumb: avatarUrl(env, r.image),
  data: r.data ?? null, // admin deep-link payload ({ url?: ... }); json column
  /** True once shown in the list; `read` means actually opened. */
  seen: !!r.seen,
  // --- grouping (migration 0018) ---
  /** Most recent actor, for the row avatar. */
  actorId: r.actorId ?? null,
  /**
   * Up to a few recent actors. More may have been folded in than are listed
   * here — `actorCount` is the authoritative total.
   */
  actors: (r.actors ?? null) as NotificationActor[] | null,
  /** Distinct actors folded into this row; 1 for ungrouped notifications. */
  actorCount: r.actorCount ?? 1,
  /**
   * NOTE: for collapsible types this is the LAST ACTIVITY time, not the first —
   * collapsing bumps it so the regrouped notification returns to the top. The
   * cursor pagination on this endpoint relies on that.
   */
  createdAt: r.createdAt, // epoch ms
});

/**
 * Blog rows are permanent, so their media urls are the ones most likely to
 * predate the media domain cutover — including the `<img src>` urls embedded in
 * `content` HTML by the importer. Canonicalising on the way out moves them off
 * the Worker proxy without waiting for `scripts/media-domain-backfill.sql`.
 *
 * `coverImageUrlThumb` is additive: the list view renders a card-sized image and
 * was downloading the full-resolution original to do it.
 */
const mapBlogPost = (env: Env, r: any, opts: { withContent?: boolean } = {}) => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  excerpt: r.excerpt,
  coverImageUrl: cdnUrl(env, r.coverImageUrl),
  coverImageUrlThumb: thumbUrl(env, r.coverImageUrl),
  category: r.category,
  tags: r.tags || [],
  author: r.author,
  viewCount: r.viewCount ?? 0,
  publishedAt: r.publishedAt ?? r.createdAt,
  createdAt: r.createdAt,
  ...(opts.withContent
    ? {
        content: canonicalizeMediaHtml(env, r.content),
        metaTitle: r.metaTitle || r.title,
        metaDescription: r.metaDescription || r.excerpt,
        canonicalUrl: r.canonicalUrl,
      }
    : {}),
});

// ================= CONTESTS =================
readRoute.get("/contests", optionalAuth, async (c) => {
  const typeParam = c.req.query("type");
  if (typeParam && typeParam !== "photo" && typeParam !== "video") {
    throw httpsError("invalid-argument", "type must be photo or video.");
  }
  const type = typeParam as "photo" | "video" | undefined;
  const key = contestListCacheKey(type ?? "all");
  const db = getDb(c.env);
  // Fully public and identical for every caller, so a shared entry is safe.
  //
  // The 60s is a product requirement, not a cost preference. Admin edits are covered
  // by `invalidateContestCaches` (including the cron that ends expired ones), but
  // SCHEDULING is not: the filter below is `startsAt < now`, and nothing invalidates at
  // the moment a scheduled contest enters its window, so appearance is gated purely on
  // a cache miss. The client-side mitigation only helps in the other direction — it can
  // count down and disable an entry whose `endsAt` has passed, because that entry is
  // already in the response, but nothing on the client can surface a contest the
  // payload omits.
  //
  // Edge-only, so the 60s here IS the whole bound rather than one of two composing
  // tiers — the previous 20s edge over a KV entry that the platform floored to 60s
  // actually served up to 80s. See READ_CACHE_TTLS.
  const contests = await cachedJson<any[]>(c, {
    key,
    edgeTtlSec: READ_CACHE_TTLS.contestList.edge,
    kvTtlSec: READ_CACHE_TTLS.contestList.kv,
    load: async () => {
      // Only templates that are live AND inside their validity window. Both edges
      // are nullable and NULL means unbounded, so every contest created before
      // migration 0038 still matches — this filter must not silently empty the
      // Start a New Battle rail for existing data.
      //
      // A scheduled contest (startsAt in the future) can therefore be saved as
      // 'live' up front and it stays hidden until its moment arrives, instead of an
      // admin having to be awake to flip the status by hand.
      const nowMs = Date.now();
      const conds = [
        eq(schema.contests.status, "live"),
        or(isNull(schema.contests.startsAt), lt(schema.contests.startsAt, nowMs)),
        or(isNull(schema.contests.endsAt), gt(schema.contests.endsAt, nowMs)),
      ];
      if (type) conds.push(eq(schema.contests.type, type));
      const rows = await db.select().from(schema.contests).where(and(...conds)).all();
      return rows.map(mapContest);
    },
  });
  c.header("Cache-Control", "public, max-age=60");
  return c.json(contests);
});

readRoute.get("/contests/:id", optionalAuth, async (c) => {
  const id = c.req.param("id");
  const key = contestDetailCacheKey(id);
  const db = getDb(c.env);
  // Unlike the LIST above, a detail lookup is by id and does not filter on the
  // validity window, so the scheduling gap described there does not apply:
  // `invalidateContestCaches` covers every mutation of this row, and the join path
  // re-reads the contest from D1 and calls `assertContestOpenNow`, so a stale detail
  // payload can never authorise an entry outside the window. Hence the longer KV
  // ttl, and an edge tier on top.
  //
  // The value is WRAPPED so a cached not-found (null) stays distinguishable from a
  // cache miss — `cachedJson` treats a bare null as a miss.
  const { contest } = await cachedJson<{ contest: ReturnType<typeof mapContest> | null }>(c, {
    key,
    edgeTtlSec: READ_CACHE_TTLS.contestDetail.edge,
    kvTtlSec: READ_CACHE_TTLS.contestDetail.kv,
    load: async () => {
      const row = await db.select().from(schema.contests).where(eq(schema.contests.id, id)).get();
      return { contest: row ? mapContest(row) : null };
    },
  });
  c.header("Cache-Control", "public, max-age=60");
  return c.json(contest);
});

// ================= MATCHES =================
readRoute.get("/matches", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status") || "active";
  const type = c.req.query("type");
  // sort=foryou (personalized ranking) | following (only creators you follow) |
  // hot (engagement-ranked) | recent (default, keyset by createdAt).
  const sortParam = c.req.query("sort");
  const sort =
    sortParam === "hot"
      ? "hot"
      : sortParam === "foryou"
        ? "foryou"
        : sortParam === "following"
          ? "following"
          : "recent";
  const limit = Math.min(parseInt(c.req.query("limit") || "30", 10), 100);
  const cursorRaw = c.req.query("cursor");
  // Signed-in viewer (optionalAuth). Only the base list is cached publicly; the
  // viewer's vote state is layered on per-request so refresh keeps "Voted".
  const uid = c.get("user")?.uid;

  // Ranked feeds ("For You" + "Following") share a caching model (shared
  // candidate pool + per-viewer re-rank), so they return before the per-page
  // cache below and respond as { items, nextCursor }.
  if (sort === "foryou" || sort === "following") {
    return servePersonalizedFeed(c, db, { status, type, limit, cursorRaw, uid, following: sort === "following" });
  }

  // The user-agnostic base list for this page, from the colo cache and otherwise D1.
  // Every parameter that changes the payload is in the key, so the entry is safe to
  // share; the viewer's vote state and block filter are layered on AFTER, onto a copy,
  // which is why this returns data rather than a whole response.
  //
  // nextCursor rides in the X-Next-Cursor header (the body stays a plain array —
  // non-breaking), so it has to be cached alongside the rows.
  const cacheKey = `cache:matches:${status}:${type || "all"}:${sort}:${limit}:${cursorRaw || "0"}`;
  const { matches, nextCursor } = await cachedJson<{ matches: any[]; nextCursor: number | null }>(c, {
    key: cacheKey,
    // Nothing invalidates this key — a new battle appears when the entry lapses — so
    // the ttl IS the freshness policy. 30s is the same ceiling this page has always
    // declared, and now actually honours: the old 10s edge sat over a KV entry the
    // platform floored to 60s, so the real worst case was 70s. See READ_CACHE_TTLS.
    edgeTtlSec: READ_CACHE_TTLS.matchesPage.edge,
    kvTtlSec: READ_CACHE_TTLS.matchesPage.kv,
    load: async () => {
      const conds = [eq(schema.contestMatches.status, status)];
      if (type) conds.push(eq(schema.contestMatches.type, type));

      if (sort === "hot") {
        // Engagement-weighted ranking; paginate by numeric offset.
        const offset = cursorRaw ? Math.max(parseInt(cursorRaw, 10), 0) : 0;
        const score = sql`(
          ${schema.contestMatches.totalVotes}
          + ${schema.contestMatches.likeCount}
          + ${schema.contestMatches.commentCount} * 2
          + ${schema.contestMatches.shareCount} * 3
        )`;
        const rows = await db
          .select()
          .from(schema.contestMatches)
          .where(and(...conds))
          .orderBy(desc(score), desc(schema.contestMatches.createdAt))
          .limit(limit)
          .offset(offset)
          .all();
        const list = rows.map(mapMatch).map((m) => enrichMatchMedia(c.env, m));
        await enrichParticipants(c.env, list);
        return { matches: list, nextCursor: rows.length === limit ? offset + limit : null };
      }

      // Keyset pagination by createdAt — stable and index-friendly.
      if (cursorRaw) conds.push(lt(schema.contestMatches.createdAt, parseInt(cursorRaw, 10)));
      const rows = await db
        .select()
        .from(schema.contestMatches)
        .where(and(...conds))
        .orderBy(desc(schema.contestMatches.createdAt))
        .limit(limit)
        .all();
      const list = rows.map(mapMatch).map((m) => enrichMatchMedia(c.env, m));
      await enrichParticipants(c.env, list);
      return {
        matches: list,
        nextCursor: rows.length === limit ? rows[rows.length - 1].createdAt : null,
      };
    },
  });

  if (nextCursor != null) c.header("X-Next-Cursor", String(nextCursor));
  if (uid) {
    // Per-user data — must never be stored by a shared/edge cache.
    c.header("Cache-Control", "private, no-store");
    // Filtered on the way out of the shared page cache, never on the way in.
    const visible = excludeHiddenMatches(matches, await hiddenUidsFor(c.env, uid));
    return c.json(await hydrateViewerState(db, visible, uid));
  }
  c.header("Cache-Control", "public, max-age=15");
  return c.json(matches);
});

readRoute.get("/matches/:id", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const row = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, id)).get();
  if (!row) return c.json(null);
  // A battle involving a blocked user reads as nonexistent. Reported as "no such
  // battle" rather than "not allowed" so the response cannot be used to probe
  // who has blocked whom. Only BLOCKS hide a battle outright — a mute keeps it
  // reachable by direct link, because muting is about the feed, not access.
  const directViewer = c.get("user")?.uid;
  if (directViewer) {
    const blocked = await blockedUidsFor(c.env, directViewer);
    const pa = (row.userA as any)?.uid;
    const pb = (row.userB as any)?.uid;
    if ((pa && blocked.has(pa)) || (pb && blocked.has(pb))) return c.json(null);
  }
  const out: any = mapMatch(row);
  await enrichParticipants(c.env, [out]);
  // For LIVE battles, surface the authoritative vote tally straight from the
  // per-match VoteCounter DO — D1 only holds the last (up to 5s) flushed
  // snapshot. Read-only (no flush, no D1 write); fail-open to the D1 snapshot.
  if (row.status === "active" && out.userA?.uid && out.userB?.uid) {
    try {
      const t = await getLiveTally(c.env, id, out.userA.uid, out.userB.uid);
      out.userA = { ...out.userA, votes: t.votesA };
      out.userB = { ...out.userB, votes: t.votesB };
      out.totalVotes = t.total;
    } catch {
      /* DO unreachable — keep D1 snapshot values */
    }
  }
  const uid = c.get("user")?.uid;
  if (uid) {
    const [liked, bookmarked] = await Promise.all([
      db.select().from(schema.matchLikes).where(and(eq(schema.matchLikes.matchId, id), eq(schema.matchLikes.userId, uid))).get(),
      db.select().from(schema.bookmarks).where(and(eq(schema.bookmarks.userId, uid), eq(schema.bookmarks.matchId, id))).get(),
    ]);
    out.isLiked = !!liked;
    out.isBookmarked = !!bookmarked;

    // Viewer vote state must come from the actor while active because D1 can be
    // up to one flush window behind. Completed matches are immutable and can use
    // their persisted audit row without waking a Durable Object.
    if (row.status === "active") {
      try {
        const viewerVote = await getViewerVote(c.env, id, uid);
        out.hasVoted = viewerVote.hasVoted;
        out.votedForUid = viewerVote.votedForUid;
      } catch {
        const vote = await db.select({ votedForUid: schema.votes.votedForUid })
          .from(schema.votes)
          .where(and(eq(schema.votes.matchId, id), eq(schema.votes.voterUid, uid)))
          .get();
        out.hasVoted = !!vote;
        out.votedForUid = vote?.votedForUid ?? null;
      }
    } else {
      const vote = await db.select({ votedForUid: schema.votes.votedForUid })
        .from(schema.votes)
        .where(and(eq(schema.votes.matchId, id), eq(schema.votes.voterUid, uid)))
        .get();
      out.hasVoted = !!vote;
      out.votedForUid = vote?.votedForUid ?? null;
    }
  }
  return c.json(enrichMatchMedia(c.env, out));
});

// ================= LEADERBOARD =================
readRoute.get("/leaderboard", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const by = c.req.query("by") || "wins"; // wins | votes | xp
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  // Leaderboard changes slowly (on match resolution) — cache 30s in KV.
  const viewerUid = c.get("user")?.uid;
  /**
   * Drop blocked accounts from a leaderboard page.
   *
   * Applied after the shared cache is read, so the cached top-N stays identical
   * for everyone. A consequence worth knowing: a viewer who has blocked someone
   * in the top N sees a SHORTER list rather than the next person promoted into
   * the gap. Back-filling would mean over-fetching and re-ranking per viewer on
   * an endpoint whose whole point is to be one cached query, and a rank is a
   * global fact — quietly renumbering it per viewer would be worse.
   */
  const visibleRanks = async (rows: any[]) => {
    if (!viewerUid) return rows;
    const blocked = await blockedUidsFor(c.env, viewerUid);
    // Only downgrade cacheability when the response was ACTUALLY filtered. The
    // overwhelming majority of viewers block nobody, and marking their responses
    // private would throw away edge caching on one of the hottest endpoints for
    // no benefit.
    if (blocked.size === 0) return rows;
    c.header("Cache-Control", "private, no-store");
    return excludeHiddenBy(rows, blocked, (r) => r.uid);
  };

  // A rank is a global fact, so this entry is identical for everyone and both tiers
  // are safe. The per-viewer block filter runs on the way OUT, via visibleRanks.
  const cacheKey = `cache:leaderboard:${by}:${limit}`;
  const enriched = await cachedJson<any[]>(c, {
    key: cacheKey,
    // Nothing invalidates this — the standings move when a match resolves — so the ttl
    // is the freshness policy. 60s, down from the 80s the old 20s-edge-over-a-floored-
    // 60s-KV-entry actually served. The leaderboard is the most expensive query here (a
    // full ordered scan of publicly visible users) and the one people refresh most,
    // which is exactly the shape a colo cache is for.
    edgeTtlSec: READ_CACHE_TTLS.leaderboard.edge,
    kvTtlSec: READ_CACHE_TTLS.leaderboard.kv,
    load: async () => {
      const orderCol =
        by === "votes" ? schema.users.totalVotesReceived : by === "xp" ? schema.users.xp : schema.users.wins;
      const rows = await db
        .select({
          uid: schema.users.uid,
          username: schema.users.username,
          fullName: schema.users.fullName,
          profileImageUrl: schema.users.profileImageUrl,
          wins: schema.users.wins,
          totalVotesReceived: schema.users.totalVotesReceived,
          xp: schema.users.xp,
          level: schema.users.level,
          badges: schema.users.badges,
          equippedBadge: schema.users.equippedBadge,
          verified: schema.users.verified,
        })
        .from(schema.users)
        .where(publiclyVisibleUser)
        .orderBy(desc(orderCol))
        .limit(limit)
        .all();
      return rows.map((r: any) => ({ ...r, profileImageUrlThumb: avatarUrl(c.env, r.profileImageUrl) }));
    },
  });
  // visibleRanks downgrades this to private only if it actually filtered.
  c.header("Cache-Control", "public, max-age=30");
  return c.json(await visibleRanks(enriched));
});

// ================= APP CONFIG =================
/**
 * Public app configuration.
 *
 * This endpoint is UNAUTHENTICATED — the app reads it before login to learn about
 * maintenance mode, minimum version and feature flags. It used to return the
 * whole `appConfig` document, so anything an admin stored there was public:
 * `adminAlertEmail` was already leaking, and every new operational setting would
 * have leaked by default.
 *
 * It now projects an explicit allow-list. New settings are private unless they
 * are deliberately added here.
 */
readRoute.get("/app-config", async (c) => {
  // No query parameters: the edge key is the bare path, so `?anything=1` cannot
  // mint extra colo entries for a byte-identical response. See `urlEdgeKey`.
  return cachedResponse(c, 120, async () => {
    const cfg: any = (await getAppConfig(c.env)) || {};
    const ads = cfg.ads || {};
    const withdrawal = cfg.withdrawal || {};
    return {
      // Gates the client must honour before/at login.
      maintenanceMode: !!cfg.maintenanceMode,
      maintenanceMessage: cfg.maintenanceMessage || "",
      forceUpdate: !!cfg.forceUpdate,
      minAppVersion: cfg.minAppVersion || "",
      announcement: {
        enabled: !!cfg.announcement?.enabled,
        message: cfg.announcement?.message || "",
        link: cfg.announcement?.link || "",
      },
      features: cfg.features || {},
      // Auth method availability, so the client can hide what is not configured.
      googleLogin: cfg.googleLogin !== false,
      appleLogin: cfg.appleLogin !== false,
      facebookLogin: cfg.facebookLogin === true,
      // Wallet rules the wallet screens render. Deliberately only the limits the
      // user is subject to — never internal accounting fields.
      withdrawal: {
        enabled: withdrawal.enabled !== false,
        payoutsFrozen: withdrawal.payoutsFrozen === true,
        minAmount: Number(withdrawal.minAmount ?? 0),
        maxAmount: Number(withdrawal.maxAmount ?? 0),
        maxPerDay: Number(withdrawal.maxPerDay ?? 0),
        conversionRate: Number(withdrawal.conversionRate ?? 1),
      },
      paymentGateway: { mode: cfg.paymentGateway?.mode || "auto" },
      // Whether to show the rewarded-ad task at all.
      ads: { enabled: ads.enabled === true, reward: Number(ads.reward ?? 0), dailyCap: Number(ads.dailyCap ?? 0) },
      // NB: `legalContent` is deliberately NOT here — see GET /read/legal below.
      supportEmail: cfg.supportEmail || "",
      socialLinks: cfg.socialLinks || {},
    };
  });
});

/**
 * Long-form legal documents.
 *
 * ## Why this is not part of /read/app-config
 *
 * It was, and that is a mistake worth not repeating. `app-config` is polled by the
 * whole app — it carries maintenance mode, the minimum version and the feature
 * flags, so every client fetches it whether or not anyone opens a policy. The four
 * documents are ~28 KB of text (~10 KB gzipped), which would make every one of
 * those polls an order of magnitude larger to serve content that four screens read
 * and nothing else does.
 *
 * Split out, the cost falls only on the screen that needs it, and the two can be
 * cached on their own merits: config changes when an admin flips a switch, legal
 * text changes a few times a year.
 *
 * ## Why the content can never be empty
 *
 * `resolveLegalContent` falls back per document to the text bundled in
 * `src/content/legal.ts`. This endpoint used to project the admin config directly,
 * so a policy nobody had typed arrived at the client as `""` and the screen
 * rendered "Our privacy policy has not been published yet." — which is what
 * tophunt.in/legal/terms, /legal/privacy and /legal/refund were all serving. An
 * empty privacy policy is an app-store rejection reason, and an empty refund policy
 * is a Razorpay compliance gap for paid digital goods.
 */
readRoute.get("/legal", async (c) => {
  // 10 minutes rather than the 2 used for app-config. A legal document changes a
  // handful of times a year, and an admin edit already purges the KV settings
  // cache; the edge copy expiring is the only wait, and it is the right trade for
  // not re-serving 28 KB from the origin.
  return cachedResponse(c, 600, async () => {
    const cfg: any = (await getAppConfig(c.env)) || {};
    return {
      legalContent: resolveLegalContent(cfg),
      // Included so the legal screens can offer a contact link without a second
      // request to app-config.
      supportEmail: cfg.supportEmail || "",
    };
  });
});

// ================= WALLET (auth) =================
// (Coin-packages + transactions endpoints are defined once below — the
// server-authoritative, cursor-paginated versions.)

// The signed-in user's own manual deposit requests.
readRoute.get("/deposits", requireAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user").uid;
  const rows = await db
    .select()
    .from(schema.deposits)
    .where(eq(schema.deposits.userId, uid))
    .orderBy(desc(schema.deposits.createdAt))
    .limit(50)
    .all();
  return c.json({
    deposits: rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      payAmount: r.payAmount,
      method: r.method,
      utr: r.utr,
      status: r.status,
      adminNote: r.adminNote,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  });
});

// The signed-in user's own withdrawal requests.
readRoute.get("/withdrawals", requireAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user").uid;
  const rows = await db
    .select()
    .from(schema.withdrawals)
    .where(eq(schema.withdrawals.userId, uid))
    .orderBy(desc(schema.withdrawals.createdAt))
    .limit(50)
    .all();
  return c.json(
    rows.map((r) => ({
      id: r.id,
      amount: r.amount,
      cashAmount: r.cashAmount,
      method: r.method,
      status: r.status,
      adminNote: r.adminNote,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  );
});

// ================= NOTIFICATIONS (auth) =================
// Cursor-paginated on createdAt (index idx_notif_recipient covers recipient +
// order). Selects explicit columns (no SELECT *) and fetches limit+1 to detect
// a next page, exposed via X-Next-Cursor so the client can load older pages
// without re-scanning. Response stays a plain array (backward compatible).
readRoute.get("/notifications", requireAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user").uid;
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  const cursor = c.req.query("cursor"); // createdAt of the last row seen

  const where = cursor
    ? and(eq(schema.notifications.recipientId, uid), lt(schema.notifications.createdAt, Number(cursor)))
    : eq(schema.notifications.recipientId, uid);

  const rows = await db
    .select({
      id: schema.notifications.id,
      title: schema.notifications.title,
      body: schema.notifications.body,
      type: schema.notifications.type,
      targetId: schema.notifications.targetId,
      image: schema.notifications.image,
      data: schema.notifications.data,
      read: schema.notifications.read,
      actorId: schema.notifications.actorId,
      actors: schema.notifications.actors,
      actorCount: schema.notifications.actorCount,
      createdAt: schema.notifications.createdAt,
    })
    .from(schema.notifications)
    .where(where)
    .orderBy(desc(schema.notifications.createdAt))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const scanned: any[] = hasMore ? rows.slice(0, limit) : rows;
  // Derived from the last SCANNED row, not the last surviving one. Taking it
  // after the filter below would (a) crash on a page whose rows were all
  // filtered away, and (b) make the next page re-scan rows already discarded.
  // Same shape as connectionsHandler's `rows[limit - 1]?.since`.
  const nextCursor = hasMore ? scanned[scanned.length - 1]?.createdAt ?? null : null;
  let page: any[] = scanned;

  // createNotification suppresses new notifications from blocked/muted users,
  // but rows written BEFORE the block are already in the table and have to be
  // filtered at read time. Two passes, because a notification can be grouped:
  // drop rows whose (most recent) actor is hidden, then strip hidden actors out
  // of the surviving rows' actor lists so a grouped avatar strip can't reveal
  // them either.
  const hidden = await hiddenUidsFor(c.env, uid);
  if (hidden.size > 0) {
    page = excludeHiddenBy(page, hidden, (r: any) => r.actorId).map((r: any) => {
      const actors = Array.isArray(r.actors) ? r.actors : null;
      if (!actors?.some((a: any) => a?.uid && hidden.has(a.uid))) return r;
      const kept = actors.filter((a: any) => !(a?.uid && hidden.has(a.uid)));
      return {
        ...r,
        actors: kept,
        // Keep the count consistent with what was removed so the row does not
        // claim more actors than it can name.
        actorCount: Math.max(kept.length, (r.actorCount ?? 1) - (actors.length - kept.length)),
      };
    });
  }

  // Each grouped actor's avatarUrl — and, for a single-actor row, the `image`
  // that drives the row avatar — is a snapshot of the actor's photo at the time
  // the notification was written. Refresh them live so a follower/liker/commenter
  // who has since changed their photo shows their current face. Only actor-driven
  // rows carry an actorId, so an admin/broadcast row's own image is left alone.
  const actorUids = page.flatMap((r: any) => [
    r.actorId,
    ...(Array.isArray(r.actors) ? r.actors.map((a: any) => a?.uid) : []),
  ]);
  const liveActors = await liveUserFields(c.env, actorUids);
  if (liveActors.size) {
    page = page.map((r: any) => {
      const next: any = { ...r };
      if (Array.isArray(r.actors)) {
        next.actors = r.actors.map((a: any) => {
          if (!a?.uid) return a;
          const u = liveActors.get(a.uid);
          return u
            ? { ...a, avatarUrl: cdnUrl(c.env, u.avatar) ?? null, username: u.username || u.fullName || a.username }
            : a;
        });
      }
      // Refresh the row image ONLY when it is the actor's avatar (an actor-driven
      // row whose image was set). Never invent one where there wasn't, so a
      // like/comment row that has no image stays imageless and keeps deriving its
      // avatar from `actors`.
      if (r.actorId && r.image != null) {
        const u = liveActors.get(r.actorId);
        if (u) next.image = cdnUrl(c.env, u.avatar) ?? null;
      }
      return next;
    });
  }

  const res = c.json(page.map((r) => mapNotification(c.env, r))) as Response;
  // Per-user data — must never be shared-cached.
  res.headers.set("Cache-Control", "private, no-store");
  if (nextCursor != null) res.headers.set("X-Next-Cursor", String(nextCursor));
  return res;
});

/**
 * Badge count — the number of notifications the user has NOT yet looked at.
 *
 * Counts `seen = 0`, not `read = 0`. `read` means "tapped through to the
 * content", which is a different question and would leave the badge showing a
 * number for rows the user has already scrolled past.
 *
 * Backed by the partial index idx_notif_unseen (recipient_id) WHERE seen = 0
 * (migration 0019), so this is an index-only count over just the unseen rows —
 * it never scans the user's notification history.
 *
 * The response name stays `count` and the route stays `/unread-count` so
 * already-installed app builds keep working.
 */
readRoute.get("/notifications/unread-count", requireAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user").uid;
  // Excludes hidden actors so the badge agrees with the list it opens — counting
  // rows the list then filters away leaves a badge that cannot be cleared by
  // reading. Capped for the same bound-parameter reason as the other SQL filters.
  const hiddenActors = sqlExclusionList(await hiddenUidsFor(c.env, uid));
  const row = await db
    .select({ v: sql<number>`count(*)` })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.recipientId, uid),
        eq(schema.notifications.seen, false),
        ...(hiddenActors.length
          ? [
              or(
                isNull(schema.notifications.actorId),
                notInArray(schema.notifications.actorId, hiddenActors),
              ),
            ]
          : []),
      ),
    )
    .get();
  const res = c.json({ count: row?.v ?? 0 }) as Response;
  res.headers.set("Cache-Control", "private, no-store");
  return res;
});

// ================= WALLET / COIN LEDGER =================
// The signed coin transaction history for the authenticated user. Amounts are
// stored signed (entry fees negative, rewards/purchases positive), so the
// client can render income/expense directly. Cursor-paginated on createdAt.
readRoute.get("/transactions", requireAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user").uid;
  const limit = Math.min(parseInt(c.req.query("limit") || "30", 10), 100);
  const cursor = c.req.query("cursor"); // createdAt of the last row seen

  const where = cursor
    ? and(eq(schema.coinTransactions.uid, uid), lt(schema.coinTransactions.createdAt, Number(cursor)))
    : eq(schema.coinTransactions.uid, uid);

  const rows = await db
    .select()
    .from(schema.coinTransactions)
    .where(where)
    .orderBy(desc(schema.coinTransactions.createdAt))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? String(page[page.length - 1].createdAt) : null;

  return c.json({
    transactions: page.map((r: any) => ({
      id: r.id,
      amount: r.amount,
      type: r.type,
      description: r.description || r.type,
      contestId: r.contestId ?? null,
      matchId: r.matchId ?? null,
      createdAt: r.createdAt,
    })),
    nextCursor,
  });
});

// Public catalog of purchasable coin packages (used by the store to build a
// Razorpay order via the server-authoritative `createOrder` action). Only
// active packages are exposed; pricing lives server-side.
readRoute.get("/coin-packages", async (c) =>
  cachedResponse(c, 120, async () => {
    const db = getDb(c.env);
    const rows = await db
      .select()
      .from(schema.coinPackages)
      .where(eq(schema.coinPackages.active, true))
      .orderBy(asc(schema.coinPackages.sortOrder))
      .all();
    return rows.map((p: any) => ({
      id: p.id,
      name: p.name,
      coins: p.coins,
      bonusCoins: p.bonusCoins,
      priceInr: p.priceInr,
      totalCoins: (Number(p.coins) || 0) + (Number(p.bonusCoins) || 0),
    }));
  }),
);

// ================= USERS =================
/**
 * Degrade a stored lat/lng to roughly a 1 km grid before it leaves the server.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * `/read/users/suggested` hands the client a batch of accounts and the client sorts
 * them by distance (`fetchSuggestedUsers` in apps/expo/src/services/users.ts). To do
 * that it was given each account's EXACT stored coordinates — full precision, up to
 * 50 accounts per call, on an `optionalAuth` endpoint that needs no token at all.
 *
 * Exact coordinates plus a username is a home address. That is a more serious
 * disclosure than the email and phone this file's profile projection just removed,
 * and it was harder to notice because the field is explicitly selected rather than
 * spread, so it reads as intentional.
 *
 * Two decimal places is ~1.1 km at the equator and less further from it. Enough for
 * "who is nearest" to keep producing a sensible order within a city, not enough to
 * place anyone at a building.
 *
 * ---------------------------------------------------------------------------
 * What this does NOT fix
 * ---------------------------------------------------------------------------
 * A ~1 km cell still discloses a neighbourhood, and the honest fix is for the client
 * to send its OWN coordinate and the server to sort and return no coordinates at
 * all. That needs a client release to be useful, and old installs would silently
 * lose proximity ordering in the meantime, so it is deliberately not done here.
 * Coarsening is the part that can ship on the server alone, today, without changing
 * a single response field or breaking a build already in users' hands.
 *
 * Unparseable or absent input returns null, which the client already handles — it
 * sorts accounts with no coordinate to the end.
 */
function coarseCoordinates(value: unknown): { lat: number; lng: number } | null {
  if (!value || typeof value !== "object") return null;
  const { lat, lng } = value as { lat?: unknown; lng?: unknown };
  const nLat = Number(lat);
  const nLng = Number(lng);
  if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return null;
  // Round rather than truncate, so the cell a point falls into is the nearest one
  // rather than always the one to the south-west.
  return { lat: Math.round(nLat * 100) / 100, lng: Math.round(nLng * 100) / 100 };
}

readRoute.get("/users/suggested", optionalAuth, async (c) => {
  const uid = c.get("user")?.uid;
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);

  // Shared, viewer-AGNOSTIC candidate pool, edge-cached so the discovery screen
  // stops scanning `users` on every open (D1_R2_LOAD_AUDIT.md §7). Filled at the
  // documented max (100) so ONE entry serves every requested `limit`. The block/
  // mute filter deliberately does NOT run here — it is per-viewer, and baking one
  // viewer's exclusions into the shared entry is the exact mistake `cachedJson`
  // exists to prevent (see lib/edgeCache.ts). It runs below, after the cache.
  const pool = await cachedJson<any[]>(c, {
    key: "cache:users:suggested",
    edgeTtlSec: READ_CACHE_TTLS.usersSuggested.edge,
    kvTtlSec: READ_CACHE_TTLS.usersSuggested.kv,
    load: async () => {
      const db = getDb(c.env);
      const rows = await db
        .select({
          id: schema.users.uid,
          fullName: schema.users.fullName,
          username: schema.users.username,
          profileImageUrl: schema.users.profileImageUrl,
          verified: schema.users.verified,
          coordinates: schema.users.coordinates,
        })
        .from(schema.users)
        .where(publiclyVisibleUser)
        .limit(100)
        .all();
      return rows as any[];
    },
  });

  // Per-viewer pass: drop anyone the viewer blocked or muted, THEN trim to the page.
  // Filtering the whole pool in JS covers the full hidden set (no SQL_EXCLUSION_MAX
  // ceiling to work around), at the cost that a viewer with many blocks inside the
  // top 100 gets a shorter page than requested — an acceptable trade for a
  // suggestion list, and the same trade the cached feed at /matches already makes.
  const hidden = await hiddenUidsFor(c.env, uid);
  if (hidden.size) c.header("Cache-Control", "private, no-store");
  const filtered = hidden.size ? excludeHiddenBy(pool, hidden, (r: any) => r.id) : pool;
  const visible = filtered.slice(0, limit);
  return c.json(visible.map((r: any) => ({ ...r, coordinates: coarseCoordinates(r.coordinates) })));
});

readRoute.get("/users/search", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user")?.uid;
  const q = (c.req.query("q") || "").toLowerCase();
  if (q.length < 2) return c.json([]);
  // Blocks only: a muted user is still someone you can look up on purpose.
  const blocked = await blockedUidsFor(c.env, uid);
  const excluded = sqlExclusionList(blocked);
  const rows = await db
    .select({
      id: schema.users.uid,
      username: schema.users.username,
      avatarUrl: schema.users.profileImageUrl,
      verified: schema.users.verified,
    })
    .from(schema.users)
    .where(
      excluded.length
        ? and(
            like(schema.users.username, `${q}%`),
            publiclyVisibleUser,
            notInArray(schema.users.uid, excluded),
          )
        : and(like(schema.users.username, `${q}%`), publiclyVisibleUser),
    )
    .limit(10)
    .all();
  if (blocked.size) c.header("Cache-Control", "private, no-store");
  const visible = exclusionTruncated(blocked) ? excludeHiddenBy(rows as any[], blocked, (r: any) => r.id) : rows;
  return c.json(visible);
});

/**
 * Everything a profile shows to SOMEONE ELSE. An explicit allow-list.
 *
 * ---------------------------------------------------------------------------
 * Why an allow-list, and what was wrong before
 * ---------------------------------------------------------------------------
 * This endpoint used to answer with the whole `users` row minus `fcmTokens`. That
 * is one line of code and a large amount of personal data: `email`, `phone`,
 * `dob`, `gender`, `occupation`, `coordinates` (a location), `dpcoin` (a wallet
 * balance), `role`, `isBlocked`, `authProvider`, `referralCode`,
 * `notificationPrefs`, `streak`, `lastDailyClaim`. The endpoint is `optionalAuth`,
 * so no token was needed, and uids are enumerable through `/read/users/search` and
 * `/read/users/suggested`.
 *
 * The exact shape of the same mistake was already fixed once in this file, on
 * `/read/app-config`, which used to project the whole settings document: "It now
 * projects an explicit allow-list. New settings are private unless they are
 * deliberately added here." This is that lesson applied to the `users` row, and it
 * matters more here, because a new column lands in this table far more often than a
 * new key lands in `appConfig`.
 *
 * DENY-lists were rejected for that reason. A deny-list is only correct until the
 * next migration; an allow-list makes a new column private BY DEFAULT and forces
 * whoever adds it to decide. `test/userProfilePrivacy.test.ts` additionally fails if
 * a new `users` column appears that has not been classified either way, so the
 * decision cannot be skipped by simply not thinking about it.
 *
 * ---------------------------------------------------------------------------
 * How this list was chosen
 * ---------------------------------------------------------------------------
 * Every entry is a field the Expo client actually renders for another person —
 * audited against `ProfileHeader` (identity, badges, counters), `ProfileTabs`
 * (`isPrivate`) and `profile/connections` (`following`). Notably ABSENT is
 * `dpcoin`: the wallet card that reads it is wrapped in `{isOwnProfile && (...)}`
 * (apps/expo/app/profile/index.tsx), so no other viewer has ever displayed it.
 *
 * `status` is here only because the post-cache guard below reads it. The only values
 * it can carry out to a caller are "active" or absent — a hidden account answers
 * `null` — so it discloses nothing.
 */
export const PUBLIC_PROFILE_FIELDS = [
  // Identity.
  "uid",
  "username",
  "fullName",
  "profileImageUrl",
  "profileImageUrlThumb",
  "bio",
  // Badges and progression — the profile header renders all of these.
  "verified",
  "featured",
  "badges",
  "equippedBadge",
  "xp",
  "level",
  // Counters.
  "followersCount",
  "followingCount",
  "postsCount",
  // Contest record. Already public on `/read/leaderboard`, which serves the same
  // numbers for the top N without any viewer check at all.
  "wins",
  "monthlyWins",
  "totalVotesReceived",
  "contestsJoined",
  // The tab strip hides content for a private account.
  "isPrivate",
  // The target's OWN follow list. Filtered per viewer afterwards by `forViewer`.
  "following",
  // Social links. These live in `extra` and are merged to the top level, so they
  // have to be named individually — and naming them is also what stops any OTHER
  // key a client shoved into `extra` from reaching a stranger.
  "website",
  "facebook",
  "twitter",
  "instagram",
  // Joined-at, shown on the profile.
  "createdAt",
  // Internal: read by the hidden-account guard below. See the note above.
  "status",
] as const;

/**
 * Project a full profile row down to `PUBLIC_PROFILE_FIELDS`.
 *
 * Absent keys are skipped rather than emitted as `undefined`, so the response shape
 * for a field the row does not have is unchanged from before this projection
 * existed (`JSON.stringify` drops `undefined`, but skipping keeps object identity
 * checks on the client honest too).
 */
function publicProfile(full: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const field of PUBLIC_PROFILE_FIELDS) {
    if (full[field] !== undefined) out[field] = full[field];
  }
  return out;
}

/**
 * Serve one user's profile, by uid.
 *
 * Extracted from the route so that `/users/:id` and `/users/by-username/:username`
 * share ONE implementation. That is not tidiness: this function carries the block
 * asymmetry, the hidden-account rule and the public/private field split, and two
 * copies of those rules is exactly how a second entry point ends up leaking what the
 * first one learned not to.
 */
async function serveUserProfile(c: any, id: string): Promise<Response> {
  const viewer = c.get("user")?.uid;

  // Block handling here is deliberately ASYMMETRIC, and checked before the
  // shared cache so no viewer-specific data can ever be written into it.
  //
  //   - The viewer blocked this user  → return a minimal shell flagged
  //     `isBlockedByMe`. The client needs something to render the "You blocked
  //     @name — Unblock" state; returning nothing would leave the user unable to
  //     find the person again in order to undo it.
  //   - This user blocked the viewer  → return null, i.e. indistinguishable from
  //     an account that does not exist. Anything else (an error, an empty
  //     profile, a different status code) tells the blocked party that they were
  //     blocked and by whom, which turns the safety tool into a notification.
  if (viewer && viewer !== id) {
    const rel = await getRelations(c.env, viewer);
    if (rel.blockedByMe.includes(id)) {
      const shell = await describeUsers(c.env, [id]);
      if (!shell.length) return c.json(null);
      c.header("Cache-Control", "private, no-store");
      return c.json({
        uid: id,
        username: shell[0].username,
        fullName: shell[0].fullName,
        profileImageUrl: null,
        profileImageUrlThumb: null,
        bio: null,
        following: [],
        followersCount: 0,
        followingCount: 0,
        postsCount: 0,
        isBlockedByMe: true,
      });
    }
    if (rel.blocked.includes(id)) return c.json(null);
  }

  // Two paths from here, and the split is the privacy boundary:
  //
  //   viewer === id  → the full row, uncached, never shared.
  //   otherwise      → `PUBLIC_PROFILE_FIELDS` only, from one shared cache entry.
  //
  // The shared entry is purged when the user edits their profile, when an admin edits
  // it, on an identifier change and on deletion (see `purgeShared` /
  // `invalidateUserCaches`) — immediately in the colo that made the change, and within
  // the ttl elsewhere. Follower counts may lag by <=TTL.
  /**
   * Last per-viewer pass, applied to whichever payload the paths below produced.
   *
   * `following` is the target's own follow list and is part of the cached,
   * viewer-agnostic payload — so it can name accounts this particular viewer has
   * blocked. Filtered on a shallow copy: mutating the cached object would leak
   * one viewer's exclusions into every subsequent reader of that entry.
   */
  const forViewer = async (profile: any) => {
    if (!viewer || !profile) return profile;
    const rel = await getRelations(c.env, viewer);
    const blocked = new Set(rel.blocked);
    // Surfaced so the profile's action sheet can offer "Unmute" rather than
    // "Mute". Mute is one-way, so this is only ever true for the viewer asking.
    const isMutedByMe = rel.muted.includes(id);
    // Nothing viewer-specific to add → leave the response shared-cacheable.
    if (blocked.size === 0 && !isMutedByMe) return profile;
    c.header("Cache-Control", "private, no-store");
    return {
      ...profile,
      isMutedByMe,
      following: Array.isArray(profile.following)
        ? profile.following.filter((u: string) => !blocked.has(u))
        : profile.following,
    };
  };

  /**
   * The full profile row, as the account's owner is entitled to see it.
   *
   * Shared by both paths below so the two can never disagree about how a profile is
   * assembled — only about how much of it is handed out.
   */
  const loadFullProfile = async (): Promise<Record<string, any> | null> => {
    const db = getDb(c.env);
    const row = await db.select().from(schema.users).where(eq(schema.users.uid, id)).get();
    if (!row) return null;

    const { fcmTokens, ...columns } = row as any;
    /**
     * Merge `extra` UNDER the real columns, never over them.
     *
     * `extra` is a free-form JSON blob holding the fields with no column of their
     * own (facebook/twitter/instagram). It is written from whatever `updateProfile`
     * did not recognise — so this merge used to be `Object.assign(safe, safe.extra)`,
     * letting a key that happened to share a column's name OVERWRITE that column in
     * the response. A user could set `{verified: true}` and read back a verified
     * badge; the same trick covered `dpcoin`, `role`, `followersCount`, `status` and
     * `email`. The database was never wrong, which is why nobody noticed — the API
     * simply served the account's own claims about itself as fact, including into the
     * shared cache, where other viewers would read them too.
     *
     * `updateProfile` now refuses to put column names in `extra` at all, and the
     * public projection below names the `extra` keys it will pass on — so an
     * unrecognised one cannot reach a stranger even if it is stored.
     */
    const safe: any =
      columns.extra && typeof columns.extra === "object"
        ? { ...columns.extra, ...columns }
        : columns;
    // expose following[] (list of uids) for screens that expect it
    const following = await db.select({ id: schema.follows.followingId }).from(schema.follows).where(eq(schema.follows.followerId, row.uid)).all();
    safe.following = following.map((f) => f.id);
    safe.profileImageUrlThumb = avatarUrl(c.env, safe.profileImageUrl);
    return safe;
  };

  // ---------------------------------------------------------------------------
  // THE OWNER'S OWN PROFILE — full row, and never cached.
  // ---------------------------------------------------------------------------
  //
  // This is the request that legitimately needs `email`, `phone`, `dpcoin` and the
  // rest: the wallet screens read the balance from here, the edit screen reads the
  // contact details, and `role` is what the client turns into `isAdmin`.
  //
  // Uncached, which is a deliberate improvement rather than a cost. This payload
  // carries a WALLET BALANCE that none of the ~15 coin-mutating paths invalidate —
  // the match entry fee, the daily reward, the rewarded-ad credit, the task claim,
  // the Razorpay top-up, the withdrawal debit, admin wallet adjustments and deposit
  // approvals, settlement, payouts and the cron prize sweep. While it was served
  // from a shared cache, a user who had just paid an entry fee or bought coins could
  // see a stale balance for the whole TTL, which in a coin app reads as a lost
  // payment. Reading their own row directly removes that window entirely: one
  // indexed lookup by primary key, and the balance is always current.
  //
  // It also means the shared entry below can never contain anyone's private fields,
  // because the only request that produces them does not write to it.
  if (viewer === id) {
    const own = await loadFullProfile();
    if (!own) return c.json(null);
    c.header("Cache-Control", "private, no-store");
    return c.json(await forViewer(own));
  }

  // ---------------------------------------------------------------------------
  // SOMEONE ELSE'S PROFILE — public projection, shared cache.
  // ---------------------------------------------------------------------------
  //
  // Also the path an UNAUTHENTICATED caller takes, which is the one that mattered
  // most: `optionalAuth` means `viewer` can be undefined, so before this projection
  // existed a bare `GET /read/users/<uid>` with no token at all returned a stranger's
  // email, phone and location.
  //
  // WRAPPED in `{ profile }` because the loader must be able to say "no such user"
  // without that being read as a cache miss — a bare null is indistinguishable from
  // one (see `cachedJson`).
  //
  // Edge-only at 30s. That 30s is now real: `cachePutJson` clamps anything under 60s
  // up to 60s, so on KV this entry served twice the staleness its own comment argued
  // for, and it cost ~1,440 KV writes/day per hot profile against a 1,000/day budget
  // for the whole Worker.
  const { profile } = await cachedJson<{ profile: Record<string, any> | null }>(c, {
    key: userCacheKey(id),
    edgeTtlSec: READ_CACHE_TTLS.userProfile.edge,
    kvTtlSec: READ_CACHE_TTLS.userProfile.kv,
    load: async () => {
      const full = await loadFullProfile();
      return { profile: full ? publicProfile(full) : null };
    },
    /**
     * Two things must never enter the shared entry.
     *
     * A MISSING user, because `id` comes straight off the url on an endpoint any
     * caller can hit, so caching negatives hands out one entry per invented uid.
     *
     * A HIDDEN account (pending deletion / anonymised), so that a request arriving
     * between the deletion and its invalidation cannot re-publish the entry the
     * deletion just purged.
     */
    skipCache: ({ profile: p }) => p === null || isHiddenAccountStatus(p.status),
  });

  if (!profile) return c.json(null);

  /**
   * An account that is pending deletion, or already anonymised, reads as "does not
   * exist" to everyone but its owner — and the owner already returned above.
   *
   * Null rather than an error or an empty profile, matching how a block is handled
   * at the top of this handler: any other answer distinguishes "deleted" from "never
   * existed", and the owner is the only person entitled to know which.
   */
  if (isHiddenAccountStatus(profile.status)) {
    c.header("Cache-Control", "private, no-store");
    return c.json(null);
  }
  return c.json(await forViewer(profile));
}

/**
 * Resolve a `/@handle` to a profile — the public url's backing endpoint.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * The public profile url is `/@username`. It used to be `/profile?userId=<uid>`,
 * which put the internal Firebase uid — the same identifier used for realtime
 * channel names and Durable Object instances — into every shared link, browser
 * history and clipboard. The uid was never a secret (it is not a capability; the
 * socket path checks it against the verified token, and it was already readable from
 * the leaderboard), but an internal identifier does not belong in a url a user is
 * meant to share.
 *
 * ---------------------------------------------------------------------------
 * The `movedTo` case, which is the interesting one
 * ---------------------------------------------------------------------------
 * A username is mutable, so a readable url can rot. `resolveUsername` handles that:
 * CURRENT OWNER ALWAYS WINS, and a handle nobody holds today falls back to whoever
 * released it, so an old link still finds the person. When that happens this returns
 * `{ movedTo: "<their current handle>" }` and the caller redirects — the web Worker
 * with a 301, the app by replacing the url. That makes old links keep working, which
 * Instagram's equivalent scheme does not do.
 *
 * It answers `null` for an unknown handle, matching `/users/:id`, so a caller has one
 * not-found shape to handle rather than two.
 *
 * Registered BEFORE `/users/:id` so `by-username` cannot be read as a uid.
 */
readRoute.get("/users/by-username/:username", optionalAuth, async (c) => {
  const viewer = c.get("user")?.uid;
  const raw = c.req.param("username");
  // Tolerate a leading '@' so `/@alice` can be forwarded verbatim by any caller.
  const handle = String(raw ?? "").trim().replace(/^@+/, "");
  if (!handle) return c.json(null);

  const resolved = await resolveUsername(c.env, handle);
  if (!resolved) return c.json(null);

  if (resolved.moved && resolved.currentUsername) {
    /**
     * A pointer is still a DISCLOSURE, so it has to clear the same bar as the profile.
     *
     * This branch answers before `serveUserProfile`, which means none of that
     * function's guards run — and the one that matters is the block. `serveUserProfile`
     * returns `null` to a viewer the target has blocked, precisely so that a block
     * cannot be detected: "anything else tells the blocked party that they were blocked
     * and by whom, which turns the safety tool into a notification." A moved pointer
     * would hand that party their blocker's CURRENT handle — which is exactly what
     * someone renaming to get away from a harasser is trying to withhold, and the
     * rename is often the reason the block exists.
     *
     * The reverse direction needs no check: if the VIEWER blocked the target, they
     * already know who that is, and following the redirect lands them on the
     * "You blocked @name — Unblock" shell `serveUserProfile` builds.
     *
     * Hidden accounts are handled upstream in `resolveUsername`, which refuses to name
     * a pending-deletion or anonymised account as a redirect target at all.
     */
    if (viewer && viewer !== resolved.uid) {
      const rel = await getRelations(c.env, viewer);
      // `blocked` is the SYMMETRIC safety set (an edge in either direction), so
      // `blockedByMe` has to be consulted first — exactly the precedence
      // `serveUserProfile` uses. Without that ordering this would also hide the
      // pointer from a viewer who did the blocking, stranding them with no way back
      // to the profile they need in order to unblock.
      if (!rel.blockedByMe.includes(resolved.uid) && rel.blocked.includes(resolved.uid)) {
        return c.json(null);
      }
    }
    // Not shared-cacheable: it is a pointer that changes the moment the account
    // renames again, it is now viewer-dependent, and it is cheap to recompute.
    c.header("Cache-Control", "private, no-store");
    return c.json({ movedTo: resolved.currentUsername });
  }

  return serveUserProfile(c, resolved.uid);
});

readRoute.get("/users/:id", optionalAuth, (c) => serveUserProfile(c, c.req.param("id")));

/**
 * True when the viewer must not see anything belonging to `targetId`.
 *
 * Blocks only. A mute hides someone's content from the feed but leaves their
 * profile browsable on purpose, so the profile sub-resources below use this
 * rather than the wider `hiddenUidsFor`.
 */
async function profileHiddenFrom(c: any, targetId: string): Promise<boolean> {
  const viewer = c.get("user")?.uid;
  if (!viewer || viewer === targetId) return false;
  // Uses the CACHED set, not a direct D1 lookup. This is a read path, and rule 2
  // in lib/blocks.ts applies: a direct query would turn a transient D1 blip into
  // a 500 on seven endpoints instead of degrading, and would add a round-trip in
  // front of the KV-cached connections page that exists to avoid one.
  return (await blockedUidsFor(c.env, viewer)).has(targetId);
}

readRoute.get("/users/:id/posts", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const userId = c.req.param("id");
  // Each sub-resource is reachable directly, so each needs its own check — the
  // guard on GET /users/:id does not protect them.
  if (await profileHiddenFrom(c, userId)) return c.json({ posts: [], nextCursor: null });
  const limit = Math.min(parseInt(c.req.query("limit") || "12", 10), 50);
  const cursor = c.req.query("cursor") ? parseInt(c.req.query("cursor")!, 10) : null;
  const conds = [eq(schema.posts.userId, userId), eq(schema.posts.isHidden, false)];
  if (cursor) conds.push(lt(schema.posts.createdAt, cursor));
  const rows = await db
    .select()
    .from(schema.posts)
    .where(and(...conds))
    .orderBy(desc(schema.posts.createdAt))
    .limit(limit)
    .all();
  const nextCursor = rows.length === limit ? rows[rows.length - 1].createdAt : null;
  return c.json({ posts: rows, nextCursor });
});

// A user's own battles (as either participant). Because participants are stored
// in the userA/userB JSON snapshots, we match on json_extract(...uid) so the
// same battle shows on BOTH creators' profiles. Optional ?type=photo|video.
readRoute.get("/users/:id/matches", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const userId = c.req.param("id");
  const type = c.req.query("type");
  const limit = Math.min(parseInt(c.req.query("limit") || "12", 10), 50);
  const viewer = c.get("user")?.uid;
  if (await profileHiddenFrom(c, userId)) return c.json([]);

  // No KV cache here: migration 0014 makes this an indexed lookup (only the
  // user's own battles are read), so it's cheap enough to always serve fresh —
  // a newly-created battle shows on the profile immediately, no 60s lag.
  const wonOnly = c.req.query("won") === "1" || c.req.query("won") === "true";
  const conds: any[] = [
    sql`(json_extract(${schema.contestMatches.userA}, '$.uid') = ${userId} OR json_extract(${schema.contestMatches.userB}, '$.uid') = ${userId})`,
  ];
  if (wonOnly) {
    // The "Wins" list: only battles this user actually won.
    conds.push(eq(schema.contestMatches.status, "completed"));
    conds.push(eq(schema.contestMatches.winnerUid, userId));
  } else {
    // Only battles that have both participants render as a VS card. Excludes
    // waiting_for_opponent (no userB -> would crash the card) and cancelled.
    conds.push(inArray(schema.contestMatches.status, ["active", "completed"]));
  }
  if (type === "photo" || type === "video") conds.push(eq(schema.contestMatches.type, type));
  const rows = await db
    .select()
    .from(schema.contestMatches)
    .where(and(...conds))
    .orderBy(desc(schema.contestMatches.createdAt))
    .limit(limit)
    .all();
  let base = (rows as any[]).map((r) => enrichMatchMedia(c.env, mapMatch(r)));
  await enrichParticipants(c.env, base);

  if (viewer) {
    c.header("Cache-Control", "private, no-store");
    // A battle has TWO participants, so the owner check above is not enough: a
    // third party's grid (and the Wins list, which is this same handler with
    // ?won=1) would otherwise render a blocked user in full as the opponent.
    // Worse, the write guards check both participants, so the card would be shown
    // and then refuse the like or vote it offers.
    base = excludeHiddenMatches(base, await hiddenUidsFor(c.env, viewer));
    return c.json(await hydrateViewerState(db, base, viewer));
  }
  c.header("Cache-Control", "public, max-age=15");
  return c.json(base);
});

readRoute.get("/users/:id/bookmarks", requireAuth, async (c) => {
  const db = getDb(c.env);
  // Bookmarks are private. Derive the owner from the verified token and treat
  // the :id param as an assertion to check, never as the lookup key — using the
  // param directly made this an IDOR (any user could read anyone's saved posts).
  // Same pattern as /read/deposits, /read/withdrawals and /read/transactions.
  const uid = c.get("user").uid;
  const userId = c.req.param("id");
  if (userId !== uid) throw httpsError("permission-denied", "Not allowed.");
  const rows = await db
    .select({ matchId: schema.bookmarks.matchId })
    .from(schema.bookmarks)
    .where(eq(schema.bookmarks.userId, userId))
    .all();
  const ids = rows.map((r) => r.matchId);
  if (!ids.length) return c.json([]);
  const matches = await db.select().from(schema.contestMatches).where(inArray(schema.contestMatches.id, ids)).all();
  // Saved battles are the viewer's own list, but the battles in it involve other
  // people — a bookmark taken before a block still points at their content.
  const visible = excludeHiddenMatches(matches.map(mapMatch), await hiddenUidsFor(c.env, uid));
  return c.json(visible);
});

// ================= BLOCKED / MUTED (auth) =================
/**
 * The viewer's own block and mute lists, for the management screen.
 *
 * Returns only the OUTGOING relations (`blockedByMe`), never the incoming ones —
 * who has blocked *you* is deliberately not knowable, which is the same reason
 * GET /users/:id reports a blocked-by profile as nonexistent.
 */
readRoute.get("/blocked", requireAuth, async (c) => {
  const uid = c.get("user").uid;
  const rel = await getRelations(c.env, uid);
  const [blocked, muted] = await Promise.all([
    describeUsers(c.env, rel.blockedByMe),
    describeUsers(c.env, rel.muted),
  ]);
  const withThumbs = (rows: Awaited<ReturnType<typeof describeUsers>>) =>
    rows.map((r) => ({ ...r, profileImageUrlThumb: avatarUrl(c.env, r.profileImageUrl) }));
  const res = c.json({ blocked: withThumbs(blocked), muted: withThumbs(muted) }) as Response;
  res.headers.set("Cache-Control", "private, no-store");
  return res;
});

// ================= FOLLOWERS / FOLLOWING (connections) =================
// Default page size for connection lists; clamped so a caller can't ask D1 for
// an unbounded scan. First page (no cursor) is served from KV for hot profiles.
const CONNECTIONS_PAGE_SIZE = 30;
const CONNECTIONS_MAX_PAGE_SIZE = 100;

/**
 * Load one page of a user's connections in a SINGLE indexed D1 query.
 *
 * Previously this was two round-trips (fetch follow ids → fetch user rows) with
 * NO limit — every follower row plus every user row loaded on each call. Now:
 *   - one `leftJoin` (follows → users) = one D1 round-trip, index-backed;
 *   - keyset pagination on `follows.created_at` (cursor) so large lists never
 *     scan the whole edge set;
 *   - `avatarUrl()` adds a lightweight R2/CDN thumbnail variant (smaller image
 *     bytes on the wire) without breaking the original `profileImageUrl` field.
 *
 * `direction` picks which side of the edge is the "other" user:
 *   followers → rows where following_id = :id, other user = follower_id
 *   following → rows where follower_id  = :id, other user = following_id
 */
async function listConnections(
  c: any,
  targetId: string,
  direction: "followers" | "following",
  cursor: number | null,
  limit: number,
) {
  const db = getDb(c.env);
  const edgeMatch =
    direction === "followers"
      ? eq(schema.follows.followingId, targetId)
      : eq(schema.follows.followerId, targetId);
  const otherUid =
    direction === "followers" ? schema.follows.followerId : schema.follows.followingId;

  const where = cursor
    ? and(edgeMatch, lt(schema.follows.createdAt, cursor))
    : edgeMatch;

  const rows = await db
    .select({
      id: schema.users.uid,
      username: schema.users.username,
      fullName: schema.users.fullName,
      profileImageUrl: schema.users.profileImageUrl,
      verified: schema.users.verified,
      status: schema.users.status,
      since: schema.follows.createdAt,
    })
    .from(schema.follows)
    .leftJoin(schema.users, eq(schema.users.uid, otherUid))
    .where(where)
    .orderBy(desc(schema.follows.createdAt))
    .limit(limit + 1) // fetch one extra to detect whether a next page exists
    .all();

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows)
    // A leftJoin can yield a null user if the follow edge outlived the account.
    .filter((r) => r.id)
    // Accounts pending deletion or already anonymised are out of service. Their
    // follow edges are only removed by the purge itself, so between the request
    // and the purge this list is the one place a "Deleted user" would still be
    // rendered — and be tappable through to a profile that returns null.
    //
    // Filtered in JS rather than added to the WHERE clause on purpose: the query
    // is keyset-paginated on `follows.created_at`, and `nextCursor` below must
    // keep naming the real edge that ended the page or pagination breaks. Same
    // trade-off the block filter above makes — a slightly short page, a correct
    // cursor.
    .filter((r) => !isHiddenAccountStatus(r.status))
    .map((r) => ({
      id: r.id,
      username: r.username,
      fullName: r.fullName,
      profileImageUrl: r.profileImageUrl,
      profileImageUrlThumb: avatarUrl(c.env, r.profileImageUrl),
      verified: !!r.verified,
    }));
  const nextCursor = hasMore ? rows[limit - 1]?.since ?? null : null;
  return { items: page, nextCursor };
}

/** Shared handler for both /followers and /following. */
async function connectionsHandler(c: any, direction: "followers" | "following") {
  const targetId = c.req.param("id");
  const limit = Math.min(
    CONNECTIONS_MAX_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query("limit") || String(CONNECTIONS_PAGE_SIZE), 10) || CONNECTIONS_PAGE_SIZE),
  );
  const cursorRaw = c.req.query("cursor");
  const cursor = cursorRaw ? parseInt(cursorRaw, 10) || null : null;

  // Only the default first page (no cursor, default size) is cacheable — that's
  // what the connections screen loads on open, i.e. the hot path.
  const isFirstPage = !cursor && limit === CONNECTIONS_PAGE_SIZE;
  const cacheKey =
    direction === "followers" ? followersCacheKey(targetId) : followingCacheKey(targetId);

  // The list belongs to `targetId`, so if the viewer and the target have blocked
  // each other the whole list is off limits, not just entries within it.
  if (await profileHiddenFrom(c, targetId)) return c.json([]);

  /**
   * Remove blocked accounts from a page of connections, AFTER the shared cache.
   *
   * Like the leaderboard, this can return a short page: `nextCursor` is a keyset
   * on `follows.created_at` and must keep describing the real edge that ended the
   * page, or pagination breaks. Over-fetching to refill would mean an unbounded
   * number of extra round-trips for a viewer with many blocks, so a slightly
   * short page is the better trade — the cursor stays correct and the client's
   * "load more" continues from the right place.
   */
  const viewerUid = c.get("user")?.uid;
  // `filtered` records whether anything was actually removed, so a viewer with no
  // blocks keeps the edge-cacheable public response.
  let filtered = false;
  const visible = async (items: any[]) => {
    if (!viewerUid) return items;
    const blocked = await blockedUidsFor(c.env, viewerUid);
    if (blocked.size === 0) return items;
    filtered = true;
    return excludeHiddenBy(items, blocked, (r) => r.id);
  };
  const cacheHeader = () => (filtered ? "private, no-store" : "public, max-age=30");

  /**
   * Only the default first page is cached — that is what the connections screen
   * loads on open, and bounding it to one key per direction keeps invalidation
   * exact instead of spanning every cursor and page size.
   *
   * Edge-only at 30s, down from 180s in KV. `toggleFollow` and the block paths
   * purge, so the TTL is a backstop rather than the primary freshness mechanism —
   * but it is the ONLY bound on the changes nothing purges, such as a member of the
   * list renaming themselves or changing their avatar. So the shorter TTL is
   * strictly fresher than what it replaces, while costing no KV write.
   */
  const { items, nextCursor } = isFirstPage
    ? await cachedJson<{ items: any[]; nextCursor: number | null }>(c, {
        key: cacheKey,
        edgeTtlSec: READ_CACHE_TTLS.connections.edge,
        kvTtlSec: READ_CACHE_TTLS.connections.kv,
        load: () => listConnections(c, targetId, direction, cursor, limit),
      })
    : await listConnections(c, targetId, direction, cursor, limit);

  const body = await visible(items);
  const res = c.json(body) as Response;
  // Public list — safe to cache briefly at the edge/browser, but only when the
  // response was not filtered for a particular viewer.
  res.headers.set("Cache-Control", cacheHeader());
  if (nextCursor != null) res.headers.set("X-Next-Cursor", String(nextCursor));
  return res;
}

readRoute.get("/users/:id/followers", optionalAuth, (c) => connectionsHandler(c, "followers"));
readRoute.get("/users/:id/following", optionalAuth, (c) => connectionsHandler(c, "following"));

// ================= CHATS (auth) =================
readRoute.get("/chats", requireAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user").uid;
  // users is a JSON array column; use json_each to filter membership.
  const rows = await c.env.DB.prepare(
    `SELECT * FROM chats WHERE EXISTS (
        SELECT 1 FROM json_each(chats.users) WHERE json_each.value = ?
     ) ORDER BY updated_at DESC`,
  )
    .bind(uid)
    .all();
  const chats = (rows.results || []).map((r: any) => ({
    id: r.id,
    users: JSON.parse(r.users || "[]"),
    usersData: JSON.parse(r.users_data || "[]"),
    lastMessage: r.last_message ? JSON.parse(r.last_message) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
  // Members live in a JSON array column, so this is filtered in JS rather than
  // in the query. Blocks only: a muted person can still DM you, because mute is
  // about the feed — silencing a conversation is what leaving the chat is for.
  const blocked = await blockedUidsFor(c.env, uid);
  const visible =
    blocked.size === 0
      ? chats
      : chats.filter((chat: any) => !(chat.users as string[]).some((u) => u !== uid && blocked.has(u)));

  // `users_data` is a snapshot captured when the chat was created, so it carries
  // a stale verified flag, photo AND name. Stamp all three live off the members'
  // current rows, so the conversation list stays correct even for a chat opened
  // months ago — a member who changed their photo, renamed themselves, or was
  // verified/un-verified shows their current values, not the ones frozen at chat
  // creation.
  const memberUids = visible.flatMap((chat: any) => (chat.users as string[]) || []);
  const liveMembers = await liveUserFields(c.env, memberUids);
  if (liveMembers.size) {
    for (const chat of visible) {
      if (Array.isArray(chat.usersData)) {
        chat.usersData = chat.usersData.map((m: any) => {
          if (!m?.uid) return m;
          const u = liveMembers.get(m.uid);
          if (!u) return m;
          return {
            ...m,
            verified: u.verified,
            photoURL: cdnUrl(c.env, u.avatar) ?? null,
            displayName: u.username || u.fullName || m.displayName,
          };
        });
      }
    }
  }
  return c.json(visible);
});

readRoute.get("/chats/:id/messages", requireAuth, async (c) => {
  const db = getDb(c.env);
  const chatId = c.req.param("id");
  // requireAuth only proves *someone* is signed in. Without this, any
  // authenticated caller holding a chat id could read the whole conversation.
  await assertChatMember(c.env, chatId, c.get("user").uid);
  // Deliberately NOT filtered by block, unlike GET /read/chats, which hides the
  // thread from the inbox. The thread becomes unreachable in the UI, but the
  // history stays readable to a member who still has the id: these are the
  // viewer's own past conversations, and `sendMessage` refuses new messages in
  // both directions, so nothing can be added to what is already there.
  const since = parseInt(c.req.query("since") || "0", 10);
  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.chatId, chatId), gt(schema.messages.createdAt, since)))
    .orderBy(asc(schema.messages.createdAt))
    .limit(200)
    .all();
  return c.json(rows.map((m) => ({ id: m.id, chatId: m.chatId, senderId: m.senderId, text: m.text, createdAt: m.createdAt })));
});


// ================= MUSIC (story soundtracks) =================
/**
 * Catalogue search for the story editor's music picker.
 *
 * This endpoint exists because the editor could not search at all on the web: it
 * called `itunes.apple.com` directly and the site's CSP `connect-src` does not
 * list that host, so the browser blocked every request. The client caught the
 * failure with a `console.error` and left the picker empty, which is what "music
 * not working" was. `api.tophunt.in` is already an allowed origin, so proxying is
 * what makes the feature reachable — and it adds a shared cache and one place to
 * change provider (see lib/music.ts).
 *
 * `requireAuth` and a rate limit, because an unauthenticated proxy to a third
 * party on our own domain is an open relay someone else can spend our request
 * budget on. Only signed-in users can post a story, so only they need to search.
 *
 * Never fails: an unreachable provider returns an empty list, because a broken
 * search must degrade the picker rather than break the editor.
 */
readRoute.get("/music/search", requireAuth, async (c) => {
  const uid = c.get("user")!.uid;
  await rateLimit(c.env, `music:${uid}`, 60, 60);
  // Normalised with the provider client's OWN helpers, so the cache key below cannot
  // disagree with what the outbound call is clamped to — `limit=999` keys as the 25 it
  // actually requests, and surrounding whitespace does not mint a second entry.
  //
  // Precisely: `musicSearchCacheKey` additionally lowercases, while the outbound term
  // keeps its original casing. So `"Song"` and `"song"` share ONE entry — whichever
  // casing arrived first is the term that was actually searched. That is intended (the
  // provider is case-insensitive) but it is not the same claim as "identical requests",
  // and the difference is worth stating rather than implying.
  const q = normaliseSearchQuery(c.req.query("q") || "");
  const limit = cappedSearchLimit(parseInt(c.req.query("limit") || "20", 10) || 20);

  // Our own catalogue first. It is authoritative, instant, and cannot be
  // throttled by other traffic sharing our egress IP.
  const curated = await searchCatalog(c.env, q, limit);
  if (curated.length > 0) {
    c.header("Cache-Control", "public, max-age=600");
    return c.json({ items: curated, source: "catalog" });
  }

  /**
   * Nothing curated matched, so widen to the provider. `providerFailed`
   * distinguishes "we asked and got nothing back" from "there is genuinely no such
   * song" — collapsing those into an empty array is exactly why a throttled provider
   * looked like an empty search box for so long.
   *
   * Cached at the EDGE, not in KV, and this one is a security fix as much as a cost
   * one. The cache key contains the user's search text, so the key space is
   * unbounded and caller-controlled: on KV, at one write per novel query, a single
   * signed-in user working within the 60/minute rate limit above could mint ~3,600
   * KV writes an hour and exhaust the whole Worker's 1,000/day write budget —
   * silently disabling every other cache in the app. The provider result is pure
   * external data that a miss simply refetches, so it has no business on the quota
   * that matters.
   *
   * Empty results are still not cached (`skipCache`), for the original reason: a
   * transient provider outage must not be pinned for hours.
   */
  const provider = await cachedJson<MusicTrack[]>(c, {
    key: musicSearchCacheKey(q, limit),
    edgeTtlSec: READ_CACHE_TTLS.musicSearch.edge,
    kvTtlSec: READ_CACHE_TTLS.musicSearch.kv,
    load: () => searchTracks(c.env, q, limit),
    skipCache: (tracks) => tracks.length === 0,
  });
  c.header("Cache-Control", "public, max-age=600");
  return c.json({
    items: provider,
    source: provider.length > 0 ? "provider" : "none",
    ...(provider.length === 0 && q.trim() ? { providerFailed: true } : {}),
  });
});

/**
 * The curated catalogue, grouped for browsing.
 *
 * This is what the picker loads when it opens, and it is the reason music shows
 * up at all: the previous design asked the provider for "Top Hits" on every open,
 * which is IP-throttled and answered "200 OK, zero results" from the Worker.
 */
readRoute.get("/music/catalog", requireAuth, async (c) => {
  const categories = await getCatalog(c.env);
  // Identical for every user and only changes when a migration ships.
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({ categories });
});

// ================= COMMENTS (posts, matches or blog articles) =================
readRoute.get("/comments", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user")?.uid;
  const targetType = c.req.query("targetType") || "posts";
  const targetId = c.req.query("targetId");
  if (!targetId) return c.json({ items: [], nextCursor: null });

  const isMatch = targetType === "matches" || targetType === "contestMatches";
  // Blog threads are public UGC on an indexed page and read by signed-out
  // visitors; `optionalAuth` already allows that, so the only extra this branch
  // needs is a `total` for the "Comments (N)" heading (there is no denormalised
  // counter on blog_posts — see migrations/0034_blog_comments.sql).
  const isBlog = targetType === "blog";
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "20", 10) || 20, 1), 50);

  // Keyset (cursor) pagination — Instagram-style "load older on scroll". The
  // cursor is an opaque `${createdAt}_${id}` string; the id tie-break keeps
  // paging stable even when two comments share the same millisecond.
  const cursorRaw = c.req.query("cursor");
  let cursorAt: number | null = null;
  let cursorId = "";
  if (cursorRaw) {
    const sep = cursorRaw.indexOf("_");
    if (sep > 0) {
      cursorAt = Number(cursorRaw.slice(0, sep));
      cursorId = cursorRaw.slice(sep + 1);
    }
  }
  const isFirstPage = !cursorRaw;

  const cacheKey = commentsCacheKey(targetType, targetId);
  type CommentsPayload = { items: any[]; nextCursor: string | null; total?: number };

  const loadThread = async (): Promise<CommentsPayload> => {
    const keyset =
      cursorAt != null && Number.isFinite(cursorAt)
        ? isMatch
          ? or(lt(schema.matchComments.createdAt, cursorAt), and(eq(schema.matchComments.createdAt, cursorAt), lt(schema.matchComments.id, cursorId)))
          : isBlog
            ? or(lt(schema.blogComments.createdAt, cursorAt), and(eq(schema.blogComments.createdAt, cursorAt), lt(schema.blogComments.id, cursorId)))
            : or(lt(schema.postComments.createdAt, cursorAt), and(eq(schema.postComments.createdAt, cursorAt), lt(schema.postComments.id, cursorId)))
        : undefined;

    const rows = isMatch
      ? await db
          .select({
            id: schema.matchComments.id, userId: schema.matchComments.userId, text: schema.matchComments.text,
            likes: schema.matchComments.likeCount, createdAt: schema.matchComments.createdAt,
            username: schema.users.username, userAvatar: schema.users.profileImageUrl, verified: schema.users.verified,
          })
          .from(schema.matchComments)
          .leftJoin(schema.users, eq(schema.matchComments.userId, schema.users.uid))
          .where(and(eq(schema.matchComments.matchId, targetId), keyset))
          .orderBy(desc(schema.matchComments.createdAt), desc(schema.matchComments.id))
          .limit(limit + 1)
          .all()
      : isBlog
        ? await db
            .select({
              id: schema.blogComments.id, userId: schema.blogComments.userId, text: schema.blogComments.text,
              likes: schema.blogComments.likeCount, createdAt: schema.blogComments.createdAt,
              username: schema.users.username, userAvatar: schema.users.profileImageUrl, verified: schema.users.verified,
            })
            .from(schema.blogComments)
            .leftJoin(schema.users, eq(schema.blogComments.userId, schema.users.uid))
            .where(and(eq(schema.blogComments.postId, targetId), keyset))
            .orderBy(desc(schema.blogComments.createdAt), desc(schema.blogComments.id))
            .limit(limit + 1)
            .all()
        : await db
            .select({
              id: schema.postComments.id, userId: schema.postComments.userId, text: schema.postComments.text,
              likes: schema.postComments.likeCount, createdAt: schema.postComments.createdAt,
              username: schema.users.username, userAvatar: schema.users.profileImageUrl, verified: schema.users.verified,
            })
            .from(schema.postComments)
            .leftJoin(schema.users, eq(schema.postComments.userId, schema.users.uid))
            .where(and(eq(schema.postComments.postId, targetId), keyset))
            .orderBy(desc(schema.postComments.createdAt), desc(schema.postComments.id))
            .limit(limit + 1)
            .all();

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last: any = pageRows[pageRows.length - 1];
    const nextCursor = hasMore && last ? `${last.createdAt}_${last.id}` : null;
    const items = pageRows.map((r: any) => ({ ...r, postId: targetId, likes: r.likes ?? 0, likedByMe: false }));
    const payload: CommentsPayload = { items, nextCursor };
    // One extra COUNT, blog only, and only on a cache miss. It is a thread total
    // rather than `items.length` because the heading has to be right on page one
    // of a long thread — and it is deliberately NOT recomputed after the blocked
    // -author filter below, since the number must not tell a signed-in viewer how
    // many comments the people they blocked have written.
    if (isBlog) {
      const countRow = await db
        .select({ n: sql<number>`COUNT(*)` })
        .from(schema.blogComments)
        .where(eq(schema.blogComments.postId, targetId))
        .get();
      payload.total = Number(countRow?.n ?? 0);
    }
    return payload;
  };

  /**
   * Only the first page is cached — by far the most requested, and the one the
   * add/delete purge in routes/api.ts keeps fresh. Deeper pages are rare and go
   * straight to D1. The per-viewer `likedByMe` flag and the blocked-author filter
   * are layered on AFTER this and never baked into the shared entry.
   *
   * STAYS AT 30s, and not for want of attention: `toggleCommentLike` mutates
   * `likeCount` on these rows and does NOT purge — it only returns the new count to
   * the caller for its own optimistic update. So the TTL is the ONLY thing bounding
   * how long every other viewer sees a stale like count. Add a purge to
   * `toggleCommentLike` before raising it.
   *
   * Edge-only, which is what finally makes that 30s true: on KV the value was
   * clamped to a 60s floor, so the bound this comment argues for was never the one
   * in force. It also removes ~1,440 KV writes/day per active thread.
   */
  const payload = isFirstPage
    ? await cachedJson<CommentsPayload>(c, {
        key: cacheKey,
        edgeTtlSec: READ_CACHE_TTLS.comments.edge,
        kvTtlSec: READ_CACHE_TTLS.comments.kv,
        load: loadThread,
        /**
         * An EMPTY thread is not cached, for the same reason `/users/:id` does not cache
         * a missing user: `targetId` comes straight off the query string, so caching
         * negatives mints one entry per invented id. Cheap at the edge rather than
         * dangerous — it was one KV WRITE per invented id before, which is the bug this
         * whole change exists to fix — but the two endpoints guard an identical key-space
         * shape and there is no reason for them to disagree about it.
         */
        skipCache: (p) => p.items.length === 0,
      })
    : await loadThread();

  // Layer the signed-in viewer's per-comment like state so hearts stay filled.
  let items = payload.items;
  // Blocked authors are dropped here — the same place `likedByMe` is layered on,
  // i.e. strictly after the shared first-page cache and never baked into it.
  // Blocks only: a mute does not hide someone's replies inside a thread the
  // viewer chose to open.
  if (uid && items.length > 0) {
    const blockedAuthors = await blockedUidsFor(c.env, uid);
    if (blockedAuthors.size > 0) items = excludeHiddenBy(items, blockedAuthors, (r: any) => r.userId);
  }
  if (uid && items.length > 0) {
    const commentIds = items.map((r: any) => r.id);
    const likedRows = await db
      .select({ commentId: schema.commentLikes.commentId })
      .from(schema.commentLikes)
      .where(and(eq(schema.commentLikes.userId, uid), inArray(schema.commentLikes.commentId, commentIds)))
      .all();
    const likedSet = new Set<string>((likedRows as Array<{ commentId: string }>).map((r) => r.commentId));
    items = items.map((r: any) => ({ ...r, likedByMe: likedSet.has(r.id) }));
    c.header("Cache-Control", "private, no-store");
    return c.json({ items, nextCursor: payload.nextCursor, ...(payload.total != null ? { total: payload.total } : {}) });
  }

  c.header("Cache-Control", "public, max-age=10");
  return c.json({ items, nextCursor: payload.nextCursor, ...(payload.total != null ? { total: payload.total } : {}) });
});

// ================= STORIES =================
type AttachedUser = { username: string; avatarUrl: string | null; avatarUrlThumb: string | null; verified: boolean };

async function attachUsers(c: any, userIds: string[]) {
  const db = getDb(c.env);
  if (!userIds.length) return {} as Record<string, AttachedUser>;
  const rows = await db
    .select({ uid: schema.users.uid, username: schema.users.username, fullName: schema.users.fullName, avatar: schema.users.profileImageUrl, verified: schema.users.verified })
    .from(schema.users)
    .where(inArray(schema.users.uid, userIds))
    .all();
  // avatarUrl is null when the user has no photo. Do NOT synthesize a
  // ui-avatars.com URL here: it embeds the username, so every avatar render
  // would leak it to a third party, and the fallback breaks offline. Clients
  // render initials locally (see apps/expo/src/components/ui/Avatar.tsx).
  const map: Record<string, AttachedUser> = {};
  for (const u of rows) {
    map[u.uid] = {
      username: u.username || u.fullName || "User",
      // Canonicalised onto the current media base so a pre-cutover row is served
      // by the CDN rather than a Worker invocation. Third-party sign-in avatars
      // pass through untouched.
      avatarUrl: cdnUrl(c.env, u.avatar) || null,
      // Small variant for avatar rows. Identical to avatarUrl until
      // Transformations is enabled — see lib/media.ts transformationsAvailable().
      avatarUrlThumb: avatarUrl(c.env, u.avatar) || null,
      verified: !!u.verified,
    };
  }
  return map;
}

readRoute.get("/stories/feed", requireAuth, async (c) => {
  const uid = c.get("user").uid;

  // Shared base: every live story, newest first. Edge-cached (edge-only) so the
  // stories bar stops scanning `stories` on every feed open (D1_R2_LOAD_AUDIT.md
  // §7). The per-viewer block/mute filter is applied AFTER the cache rather than in
  // the SQL, so no viewer's exclusions are ever baked into the shared entry — the
  // rule lib/edgeCache.ts states for `cachedJson`. `expiresAt > now` is evaluated
  // once per fill, so a story can linger in the bar up to the edge TTL past expiry;
  // that is the same staleness the feed list already tolerates and is harmless here.
  const baseRows = await cachedJson<any[]>(c, {
    key: "cache:stories:feed",
    edgeTtlSec: READ_CACHE_TTLS.storiesFeed.edge,
    kvTtlSec: READ_CACHE_TTLS.storiesFeed.kv,
    load: async () => {
      const db = getDb(c.env);
      const rows = await db
        .select()
        .from(schema.stories)
        .where(gt(schema.stories.expiresAt, Date.now()))
        .orderBy(desc(schema.stories.createdAt))
        .limit(100)
        .all();
      return rows as any[];
    },
  });

  // The stories bar uses the wider `hiddenUidsFor` (blocks AND mutes) — "stop
  // showing me this person" has to cover both or the feature looks broken. The full
  // hidden set is filtered in JS (no SQL_EXCLUSION_MAX ceiling to work around now).
  const hiddenAuthors = await hiddenUidsFor(c.env, uid);
  const rows = hiddenAuthors.size
    ? excludeHiddenBy(baseRows as any[], hiddenAuthors, (r: any) => r.userId)
    : baseRows;

  const userIds = [...new Set(rows.map((r) => r.userId))];
  const userMap = await attachUsers(c, userIds);

  const grouped: Record<string, any[]> = {};
  for (const s of rows) {
    (grouped[s.userId] ||= []).push({
      ...s,
      seen: false,
      // Canonicalised, not just varianted. Story VIDEO never gets a variant, and
      // video on the proxy path is the most expensive media in the system: players
      // always send Range, and `index.ts` bypasses the edge cache for ranged
      // responses, so every seek is an uncached R2 GET plus an invocation.
      mediaUrl: cdnUrl(c.env, (s as any).mediaUrl),
      avatarUrl: cdnUrl(c.env, (s as any).avatarUrl),
      mediaUrlThumb: thumbUrl(c.env, (s as any).mediaUrl),
      mediaUrlOptimized: optimizedUrl(c.env, (s as any).mediaUrl),
    });
  }
  const list = Object.keys(grouped).map((userId) => ({
    userId,
    username: userMap[userId]?.username || "User",
    avatarUrl: userMap[userId]?.avatarUrl ?? null,
    avatarUrlThumb: userMap[userId]?.avatarUrlThumb ?? null,
    verified: userMap[userId]?.verified ?? false,
    stories: grouped[userId].sort((a, b) => a.createdAt - b.createdAt),
    hasUnseen: true,
  }));
  // current user first
  const idx = list.findIndex((u) => u.userId === uid);
  if (idx > 0) list.unshift(list.splice(idx, 1)[0]);
  return c.json(list);
});

readRoute.get("/users/:id/stories", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const userId = c.req.param("id");
  if (await profileHiddenFrom(c, userId)) return c.json(null);
  const nowMs = Date.now();
  const rows = await db
    .select()
    .from(schema.stories)
    .where(and(eq(schema.stories.userId, userId), gt(schema.stories.expiresAt, nowMs)))
    .orderBy(asc(schema.stories.createdAt))
    .limit(50)
    .all();
  if (!rows.length) return c.json(null);
  const userMap = await attachUsers(c, [userId]);
  return c.json({
    userId,
    username: userMap[userId]?.username || "User",
    avatarUrl: userMap[userId]?.avatarUrl ?? null,
    avatarUrlThumb: userMap[userId]?.avatarUrlThumb ?? null,
    verified: userMap[userId]?.verified ?? false,
    stories: rows.map((s) => ({ ...s, seen: false })),
    hasUnseen: true,
  });
});

readRoute.get("/stories/:id/viewers", requireAuth, async (c) => {
  const db = getDb(c.env);
  const storyId = c.req.param("id");
  // Only the story's author may see who viewed it (and with what reaction).
  const story = await db
    .select({ userId: schema.stories.userId })
    .from(schema.stories)
    .where(eq(schema.stories.id, storyId))
    .get();
  if (!story) throw httpsError("not-found", "Story not found.");
  if (story.userId !== c.get("user").uid)
    throw httpsError("permission-denied", "Not allowed.");
  const rows = await db
    .select({
      uid: schema.storyViews.viewerId, viewedAt: schema.storyViews.createdAt, reaction: schema.storyViews.reaction,
      username: schema.users.username, avatarUrl: schema.users.profileImageUrl, verified: schema.users.verified,
    })
    .from(schema.storyViews)
    .leftJoin(schema.users, eq(schema.storyViews.viewerId, schema.users.uid))
    .where(eq(schema.storyViews.storyId, storyId))
    .all();
  // Views recorded before a block are still in the table; drop them so the
  // author's viewer list cannot surface someone they have since blocked.
  const hiddenViewers = await blockedUidsFor(c.env, c.get("user").uid);
  const visibleViews = excludeHiddenBy(rows as any[], hiddenViewers, (r: any) => r.uid);
  return c.json(visibleViews.map((r: any) => ({
    uid: r.uid,
    username: r.username || "Unknown",
    avatarUrl: r.avatarUrl || null,
    verified: !!r.verified,
    viewedAt: r.viewedAt,
    reaction: r.reaction || null,
  })));
});

// ================= HIGHLIGHTS =================
readRoute.get("/users/:id/highlights", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const userId = c.req.param("id");
  if (await profileHiddenFrom(c, userId)) return c.json([]);
  const rows = await db
    .select()
    .from(schema.highlights)
    .where(eq(schema.highlights.userId, userId))
    .orderBy(desc(schema.highlights.createdAt))
    .all();
  return c.json(rows);
});

readRoute.get("/highlights/:id/stories", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const h = await db.select().from(schema.highlights).where(eq(schema.highlights.id, c.req.param("id"))).get();
  if (!h) return c.json(null);
  // Highlights outlive the 24h story window, so this is the one story surface
  // reachable indefinitely by direct link — and therefore the easiest to forget.
  if (await profileHiddenFrom(c, h.userId)) return c.json(null);
  const storyIds = ((h.storyIds as string[]) || []).slice(0, 30);
  if (!storyIds.length) return c.json(null);
  const rows = await db.select().from(schema.stories).where(inArray(schema.stories.id, storyIds)).all();
  const userMap = await attachUsers(c, [h.userId]);
  return c.json({
    userId: h.userId,
    username: userMap[h.userId]?.username || h.name,
    avatarUrl: userMap[h.userId]?.avatarUrl || h.coverImageUrl,
    stories: rows.map((s) => ({ ...s, seen: true })).sort((a, b) => a.createdAt - b.createdAt),
    hasUnseen: false,
  });
});


// ================= BLOG =================
// Public list of published posts. Cursor-paginated by publishedAt (epoch ms),
// with optional ?category= and ?q= (title search). Cached briefly in KV.
readRoute.get("/blog", async (c) => {
  const db = getDb(c.env);
  const limit = Math.min(parseInt(c.req.query("limit") || "12", 10), 50);
  const cursor = c.req.query("cursor") ? parseInt(c.req.query("cursor")!, 10) : null;
  const category = c.req.query("category") || null;
  const q = (c.req.query("q") || "").trim().toLowerCase();

  const conds = [eq(schema.blogPosts.status, "published")];
  if (cursor) conds.push(lt(schema.blogPosts.publishedAt, cursor));
  if (category) conds.push(eq(schema.blogPosts.category, category));
  if (q.length >= 2) conds.push(like(sql`lower(${schema.blogPosts.title})`, `%${q}%`));

  // Cache only the canonical default first page. This keeps write-side
  // invalidation bounded to one known key instead of up to 50 limit variants.
  const cacheable = !cursor && !category && !q && limit === 12;
  const cacheKey = blogListCacheKey(limit);

  const load = async () => {
    const rows = await db
      .select()
      .from(schema.blogPosts)
      .where(and(...conds))
      .orderBy(desc(schema.blogPosts.publishedAt))
      .limit(limit)
      .all();
    const nextCursor = rows.length === limit ? rows[rows.length - 1].publishedAt : null;
    return { posts: rows.map((r) => mapBlogPost(c.env, r)), nextCursor };
  };

  // Filtered, paginated or non-default-limit requests are never cached — see the
  // note above: keeping only the canonical page cacheable is what bounds
  // invalidation to one known key instead of up to 50 limit variants.
  if (!cacheable) return c.json(await load());

  // `invalidateBlogReadCache` purges this key on every editorial write, so publishing
  // is immediate in the colo that published. The ttl is short because the Cache API
  // cannot be purged across colos, and that invalidator also fires for DELETE and
  // UNPUBLISH: it bounds the window in which a just-published post is still missing —
  // or a just-deleted one still present — elsewhere.
  const payload = await cachedJson<{ posts: any[]; nextCursor: number | null }>(c, {
    key: cacheKey,
    edgeTtlSec: READ_CACHE_TTLS.blogList.edge,
    kvTtlSec: READ_CACHE_TTLS.blogList.kv,
    load,
  });
  c.header("Cache-Control", "public, max-age=60");
  return c.json(payload);
});

// Distinct categories with post counts — for the blog filter UI. Public and
// slow-changing, so edge-cache 5min to skip D1's GROUP BY on repeat loads.
readRoute.get("/blog/categories", async (c) =>
  cachedResponse(c, 300, async () => {
    const db = getDb(c.env);
    const rows = await db
      .select({ category: schema.blogPosts.category, count: sql<number>`count(*)` })
      .from(schema.blogPosts)
      .where(and(eq(schema.blogPosts.status, "published"), sql`${schema.blogPosts.category} IS NOT NULL`))
      .groupBy(schema.blogPosts.category)
      .orderBy(desc(sql`count(*)`))
      .all();
    return rows.filter((r) => r.category);
  }),
);

/**
 * Every published post's slug + lastmod, and nothing else — for the SEO Worker's
 * sitemap. MUST stay registered above `/blog/:slug`, or "sitemap" is matched as a
 * post slug.
 *
 * Why this exists instead of reusing `/read/blog`: that endpoint returns whole
 * post rows, so it caps `limit` at 50 — sensibly, since 50 full articles is
 * already a large response. But a sitemap needs EVERY post, and at 50 per page
 * ~4,300 posts meant ~87 sequential subrequests from the sitemap Worker. A Worker
 * has a subrequest ceiling, so the walk was silently cut short: the live sitemap
 * carried 2,452 of 4,338 urls and simply stopped. Nothing errored — Google was
 * just never told about ~1,880 posts.
 *
 * Two columns per row instead of ~20 makes a much larger page safe, so the whole
 * catalogue is one subrequest and one indexed D1 query
 * (`idx_blog_status_published` covers `status` + `published_at` exactly). Kept
 * paginated anyway so growth past `MAX_LIMIT` degrades into a second request
 * rather than silent truncation again.
 *
 * `lastmod` prefers `updated_at` so an edited post is re-crawled.
 */
readRoute.get("/blog/sitemap", async (c) => {
  // Parsed OUT here rather than inside the producer so the same normalised values
  // form the edge cache key. Keying on the raw query text would give `?limit=abc`,
  // `?limit=0` and `?limit=999999` three entries for one identical payload — an
  // unbounded key supply on an unauthenticated endpoint. A malformed cursor
  // normalises to null, which is also how the query treats it.
  const MAX_LIMIT = 10000;
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || String(MAX_LIMIT), 10) || MAX_LIMIT, 1), MAX_LIMIT);
  // KNOWN RESIDUAL, recorded rather than fixed: `limit` is a free integer in [1, 10000]
  // on an unauthenticated endpoint, so it is a caller-controlled supply of distinct
  // colo entries — the same shape `urlEdgeKey`'s allow-list narrows, narrowed only to
  // the parameters that matter rather than to their value space. Not a regression:
  // keying on the raw url (what this replaced) was strictly worse, since EVERY query
  // string minted an entry.
  //
  // Deliberately not "fixed" by bucketing the limit, which was tried: rounding up to a
  // power of two bounds the keys but returns MORE rows than the caller asked for, i.e.
  // it changes the response to solve a cache-shape problem. The right tier for this is
  // a Cloudflare WAF rate-limiting rule on these two blog paths — the same second tier
  // lib/rateLimit.ts already names for traffic the in-Worker limiter should not be
  // asked to absorb. The Cache API is per-colo and LRU-evicted, so the blast radius is
  // one colo's cache pressure, not a quota that stops the application working.
  const cursorRaw = c.req.query("cursor") ? parseInt(c.req.query("cursor")!, 10) : null;
  const cursor = cursorRaw != null && Number.isFinite(cursorRaw) ? cursorRaw : null;

  return cachedResponse(
    c,
    900,
    async () => {
      const db = getDb(c.env);
      const conds = [eq(schema.blogPosts.status, "published")];
      if (cursor) conds.push(lt(schema.blogPosts.publishedAt, cursor));

      const rows = await db
        .select({
          slug: schema.blogPosts.slug,
          publishedAt: schema.blogPosts.publishedAt,
          updatedAt: schema.blogPosts.updatedAt,
        })
        .from(schema.blogPosts)
        .where(and(...conds))
        .orderBy(desc(schema.blogPosts.publishedAt))
        .limit(limit)
        .all();

      return {
        posts: rows.map((r) => ({ slug: r.slug, lastmod: r.updatedAt || r.publishedAt || null })),
        nextCursor: rows.length === limit ? rows[rows.length - 1].publishedAt : null,
      };
    },
    { varyParams: { limit, cursor } },
  );
});

/**
 * A page of the blog archive: slug + title only, addressed by PAGE NUMBER.
 *
 * This is the feed behind the crawlable archive pages the SEO Worker renders at
 * `/blog/archive/page/<n>`, and it exists because of a specific indexing failure:
 * the blog list screen is a React Native `FlatList`, so it renders
 * `TouchableOpacity`, not `<a href>`. A crawler fetching `/blog` found ZERO links
 * to any post. With ~4,400 posts and no internal links, the sitemap was the only
 * discovery path and there was no way for link equity to reach an article at all —
 * which is what "Crawled – currently not indexed" looks like at this scale.
 *
 * Why offset pagination when everything else here is cursor-paginated: a crawlable
 * archive needs STABLE, GUESSABLE, LINKABLE urls. `?cursor=1739383` is neither —
 * it cannot be put in a sitemap, `rel=next` cannot be computed without fetching
 * the previous page, and the url changes meaning as the catalogue grows. Page
 * numbers are addressable, so page 7 is a real url with a real canonical.
 *
 * The usual objection to OFFSET — that deep offsets scan — is bounded here:
 * `idx_blog_status_published` covers `status` + `published_at`, the row is two
 * columns wide, and the deepest page is ~4,500 rows in. Correctness needs a total
 * order, so `id` breaks ties: `published_at` is nullable (the importer writes NULL
 * when the archived date is unknown) and duplicate values are common, and without
 * a tiebreak SQLite may order ties differently between two queries — which for
 * OFFSET pagination means a post silently appearing on two pages, or on none.
 */
readRoute.get("/blog/archive", async (c) => {
  // Normalised before the cache key is built — see the note on /blog/sitemap.
  const perPage = Math.min(Math.max(parseInt(c.req.query("per") || "100", 10) || 100, 1), 500);
  const page = Math.max(parseInt(c.req.query("page") || "1", 10) || 1, 1);
  const category = c.req.query("category") || null;

  return cachedResponse(
    c,
    900,
    async () => {
      const db = getDb(c.env);
      const conds = [eq(schema.blogPosts.status, "published")];
      if (category) conds.push(eq(schema.blogPosts.category, category));

      const counted = await db
        .select({ total: sql<number>`count(*)` })
        .from(schema.blogPosts)
        .where(and(...conds))
        .get();
      const total = Number(counted?.total || 0);
      const totalPages = Math.max(Math.ceil(total / perPage), 1);

      const rows = await db
        .select({
          slug: schema.blogPosts.slug,
          title: schema.blogPosts.title,
          category: schema.blogPosts.category,
          publishedAt: schema.blogPosts.publishedAt,
          updatedAt: schema.blogPosts.updatedAt,
        })
        .from(schema.blogPosts)
        .where(and(...conds))
        .orderBy(desc(schema.blogPosts.publishedAt), asc(schema.blogPosts.id))
        .limit(perPage)
        .offset((page - 1) * perPage)
        .all();

      return {
        page,
        perPage,
        total,
        totalPages,
        category,
        posts: rows.map((r) => ({
          slug: r.slug,
          title: r.title,
          category: r.category || null,
          publishedAt: r.publishedAt || null,
          lastmod: r.updatedAt || r.publishedAt || null,
        })),
      };
    },
    { varyParams: { per: perPage, page, category } },
  );
});

// Single post by slug (falls back to id). Increments view count fire-and-forget.
readRoute.get("/blog/:slug", async (c) => {
  const db = getDb(c.env);
  const key = c.req.param("slug");
  const cacheKey = blogPostCacheKey(key);

  // Serve the (expensive-to-serialize) full post body from the colo cache. The view
  // counter still increments on every request — only the payload is cached — so
  // analytics stay live while D1 content reads drop. The displayed viewCount itself may
  // lag by up to the ttl, which is fine for a blog.
  //
  // The stored value is WRAPPED as `{ post }` so the loader never returns a bare
  // null, which `cachedJson` would read as a cache miss.
  //
  // A not-found is deliberately NOT cached, via `skipCache`. `key` here comes
  // straight off the url on an unauthenticated, unthrottled endpoint, so caching
  // misses would mint one KV write per novel slug — and the free plan allows 1,000
  // KV writes a day for the entire Worker, after which every cache in the app stops
  // writing (lib/cache.ts). A script walking made-up slugs would take the whole
  // application's caching down for the day. There is also no way to clear such an
  // entry: `invalidateBlogReadCache` only knows the exact slug and id of the post
  // being edited, so a negative entry under any other spelling would simply sit
  // there, and the negative EDGE entry could not be purged at all.
  //
  // `unwrapPost` also accepts the PREVIOUS shape, where the value WAS the payload.
  // Those entries have a 600s ttl and so keep arriving for ten minutes after this
  // deploys; reading one as "no `post` field, therefore not found" would 404 every
  // hot article in the blog for that window.
  const unwrapPost = (v: any): { post: Record<string, any> | null } =>
    v && typeof v === "object" && "post" in v ? { post: v.post } : { post: v ?? null };

  const { post } = unwrapPost(
    await cachedJson<{ post: Record<string, any> | null }>(c, {
      key: cacheKey,
      // Every editorial write purges this key in the colo that performed it. The ttl is
      // deliberately one of the shortest in the table because the Cache API cannot be
      // purged elsewhere and that invalidator also fires for DELETE and UNPUBLISH — a
      // post pulled for legal reasons must not keep being served for long.
      edgeTtlSec: READ_CACHE_TTLS.blogPost.edge,
      kvTtlSec: READ_CACHE_TTLS.blogPost.kv,
      skipCache: (v) => v.post === null,
      load: async () => {
        let row = await db.select().from(schema.blogPosts).where(eq(schema.blogPosts.slug, key)).get();
        if (!row) row = await db.select().from(schema.blogPosts).where(eq(schema.blogPosts.id, key)).get();
        if (!row || row.status !== "published") return { post: null };
        return { post: mapBlogPost(c.env, row, { withContent: true }) };
      },
    }),
  );

  // 404, not `200 null`.
  //
  // This endpoint answered "no such post" with HTTP 200 and a `null` body, and the
  // SEO Worker in front of it turned that into a 200 HTML page reading "Not found".
  // Every dead or misspelled slug was therefore a SOFT 404: Google has to guess
  // from the content that the page does not exist, files it under "Soft 404", and
  // keeps re-crawling it. With ~4,400 imported permalinks and a catch-all route
  // that claims every one-segment path, that was an unbounded space of 200s.
  //
  // Safe for the app: `blogService.getPost` catches the thrown `ApiCallError` and
  // returns null, which is the same not-found state the 200 produced. The Worker's
  // `fetchPost` already treats a non-ok response as no post.
  //
  // The body stays `null` so any caller that reads the body before the status sees
  // an unchanged shape.
  if (!post) return c.json(null, 404);
  // Best-effort view counter — the payload is cached, the analytics deliberately are
  // not, so this fires on cache hits too. Handed to `waitUntil` rather than left
  // floating: on an edge hit nothing else in this handler registers any pending
  // work, so the isolate could be torn down before an unawaited write lands.
  c.executionCtx.waitUntil(
    db
      .update(schema.blogPosts)
      .set({ viewCount: sql`${schema.blogPosts.viewCount} + 1` })
      .where(eq(schema.blogPosts.id, post.id as string))
      .run()
      .catch(() => {}),
  );
  return c.json(post);
});


/**
 * The caller's own physical prizes, and where each one is up to.
 *
 * `requireAuth` plus a `uid` filter is the whole authorisation model — there is no
 * id in the path, so there is nothing to enumerate. Not cached in either tier: a
 * winner who has just submitted an address reloads this screen immediately to check
 * it took, and a stale "unclaimed" there reads as the form having failed.
 *
 * The address is echoed back deliberately. It lets the app show what was submitted
 * and pre-fill a correction, and it is the caller's own data — the same reasoning
 * that puts it in the data export. Admin-only fields (`adminNote` beyond a
 * cancellation reason) are not projected.
 */
readRoute.get("/prizes", requireAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user").uid;
  const rows = await db
    .select()
    .from(schema.prizeClaims)
    .where(eq(schema.prizeClaims.uid, uid))
    .orderBy(desc(schema.prizeClaims.createdAt))
    .limit(100)
    .all();

  c.header("Cache-Control", "private, no-store");
  return c.json(
    rows.map((r) => ({
      id: r.id,
      matchId: r.matchId,
      contestId: r.contestId,
      status: r.status,
      productTitle: r.productTitle,
      productImageUrl: r.productImageUrl,
      productValue: r.productValue ?? 0,
      /** True once the winner has supplied an address. Drives the CTA. */
      hasAddress: !!r.recipientName,
      /**
       * Whether the address can still be corrected. Mirrors exactly the statuses
       * `submitBoxPrizeClaim` accepts, so the app never offers an edit the server
       * will refuse — an operator has already addressed the parcel past this point.
       */
      canEditAddress: r.status === "unclaimed" || r.status === "submitted",
      delivery: r.recipientName
        ? {
            recipientName: r.recipientName,
            phone: r.phone,
            addressLine1: r.addressLine1,
            addressLine2: r.addressLine2,
            landmark: r.landmark,
            city: r.city,
            state: r.state,
            postalCode: r.postalCode,
            country: r.country,
            notes: r.notes,
          }
        : null,
      courier: r.courier,
      trackingNumber: r.trackingNumber,
      // Only meaningful on a cancellation, which is the one case the winner is owed
      // an explanation for.
      adminNote: r.status === "cancelled" ? r.adminNote : null,
      createdAt: r.createdAt,
      submittedAt: r.submittedAt,
      shippedAt: r.shippedAt,
      deliveredAt: r.deliveredAt,
    })),
  );
});
