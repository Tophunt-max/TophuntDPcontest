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
  cacheGetJson,
  cachePutJson,
} from "../lib/cache";
import { getLiveTally, getViewerVote } from "../lib/voteCounter";
import { rateLimit } from "../lib/rateLimit";
import { searchTracks, searchCatalog, getCatalog } from "../lib/music";
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
import { DELETED_STATUS, PENDING_DELETION_STATUS } from "../lib/accountStatus";

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
const PUBLICLY_HIDDEN_STATUSES = [PENDING_DELETION_STATUS, DELETED_STATUS] as const;
const publiclyVisibleUser = sql`(${schema.users.status} IS NULL OR ${schema.users.status} NOT IN (${sql.join(
  PUBLICLY_HIDDEN_STATUSES.map((s) => sql`${s}`),
  sql`, `,
)}))`;

/** True when this account is out of service and must not be shown to others. */
const isHiddenAccountStatus = (status: string | null | undefined): boolean =>
  !!status && (PUBLICLY_HIDDEN_STATUSES as readonly string[]).includes(status);

/**
 * Which of these uids carry the admin verified badge.
 *
 * The blue check lives on the live `users` row, but most surfaces render a name
 * from a SNAPSHOT captured at write time — a battle's userA/userB blob, a comment
 * row, a chat member list, a story, a notification actor. Embedding `verified`
 * into each snapshot would make it go stale the moment an admin verifies or
 * un-verifies someone (the same trap denormalised usernames have). So instead
 * every read that shows a name looks the flag up live, in ONE batched query, and
 * injects it — the badge is therefore always current no matter how old the
 * snapshot is.
 */
async function verifiedUidSet(
  env: Env,
  uids: (string | null | undefined)[],
): Promise<Set<string>> {
  const unique = [...new Set(uids.filter((u): u is string => !!u))];
  if (!unique.length) return new Set();
  try {
    const rows = await getDb(env)
      .select({ uid: schema.users.uid })
      .from(schema.users)
      .where(and(inArray(schema.users.uid, unique), eq(schema.users.verified, true)))
      .all();
    return new Set(rows.map((r) => r.uid));
  } catch (e) {
    // The badge is cosmetic; a lookup failure must degrade to "no badge", never
    // break the read it decorates.
    console.error("[read] verified lookup failed", e);
    return new Set();
  }
}

/**
 * Stamp `verified` onto both participants of each battle, from a single lookup.
 *
 * Mutates the mapped match objects in place (their userA/userB are fresh copies
 * from mapMatch, not the cached row), so it is safe to run before the page is
 * cached — the flag then travels with the cached copy.
 */
async function enrichParticipantsVerified(env: Env, matches: any[]): Promise<void> {
  const verified = await verifiedUidSet(
    env,
    matches.flatMap((m) => [m?.userA?.uid, m?.userB?.uid]),
  );
  if (!verified.size) return;
  for (const m of matches) {
    if (m?.userA?.uid) m.userA = { ...m.userA, verified: verified.has(m.userA.uid) };
    if (m?.userB?.uid) m.userB = { ...m.userB, verified: verified.has(m.userB.uid) };
  }
}

// --- short-lived KV cache for hot read endpoints (fail-open) ---------------
async function cacheGet(env: Env, key: string): Promise<any | null> {
  try {
    return await env.CACHE_KV.get(key, "json");
  } catch {
    return null;
  }
}
async function cachePut(env: Env, key: string, data: any, ttlSec: number): Promise<void> {
  try {
    // Cloudflare KV enforces a 60s minimum TTL — a smaller value throws and the
    // put silently fails (i.e. no cache at all). Clamp so short-lived caches
    // actually take effect (matches lib/cache.ts cachePutJson).
    await env.CACHE_KV.put(key, JSON.stringify(data), { expirationTtl: Math.max(60, ttlSec) });
  } catch {
    /* ignore KV blips */
  }
}

/**
 * Edge-cache a fully-public (user-agnostic) JSON GET at the Cloudflare colo via
 * the Cache API. On a hit the Worker returns immediately WITHOUT touching D1/KV
 * — cutting D1 rows-read and Worker CPU (and therefore billing) for hot public
 * endpoints. Only use for responses that are identical for every caller.
 */
async function edgeCached<T>(c: any, ttlSec: number, producer: () => Promise<T>): Promise<Response> {
  // `caches` is a runtime-provided global. Reading `.default` from OUTSIDE the
  // try meant any runtime without the Cache API threw a ReferenceError and 500'd
  // the endpoint — the exact opposite of the fail-open the catch below claims.
  // The access belongs inside.
  let cache: Cache | null = null;
  try {
    cache = ((caches as any)?.default as Cache) ?? null;
  } catch {
    cache = null;
  }
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: "GET" });
  try {
    const hit = cache ? await cache.match(cacheKey) : null;
    if (hit) return hit;
  } catch {
    /* cache unavailable — fall through */
  }
  const data = await producer();
  const res = c.json(data) as Response;
  res.headers.set("Cache-Control", `public, max-age=${ttlSec}`);
  try {
    if (cache) c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  } catch {
    /* best-effort */
  }
  return res;
}

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
 * Write-behind impression tracking (KV, fail-open). Increments the times each
 * served battle was shown to this viewer, prunes to the most-penalising keys,
 * and never throws — so a KV blip can't break the feed and it never touches D1.
 */
async function bumpSeen(env: Env, uid: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const key = feedSeenKey(uid);
    const map = (await cacheGetJson<Record<string, number>>(env, key)) || {};
    for (const id of ids) map[id] = Math.min((map[id] || 0) + 1, 99);
    const keys = Object.keys(map);
    if (keys.length > FEED_SEEN_MAX_KEYS) {
      // Drop the least-seen entries first — they need the least fatigue.
      keys.sort((a, b) => (map[a] || 0) - (map[b] || 0));
      for (const k of keys.slice(0, keys.length - FEED_SEEN_MAX_KEYS)) delete map[k];
    }
    await cachePutJson(env, key, map, FEED_SEEN_TTL);
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

  const candKey = `cache:matches:cand:${status}:${type || "all"}`;
  let candidates: any[] | null = await cacheGet(c.env, candKey);
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
    await enrichParticipantsVerified(c.env, candidates);
    await cachePut(c.env, candKey, candidates, 45);
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
  const cachedOrder = uid && candidates.length > 0 ? await cacheGet(c.env, orderKey) : null;

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
    const [followRows, voteRows, visitRows, seenMap] = await Promise.all([
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
      cacheGetJson<Record<string, number>>(c.env, feedSeenKey(uid)),
    ]);
    const followSet = new Set((followRows as Array<{ following: string }>).map((r) => r.following));
    // Same scan gives both the affinity set (creators backed) and the novelty
    // set (this exact battle already voted on).
    const votedForSet = new Set((voteRows as Array<{ votedForUid: string }>).map((r) => r.votedForUid));
    const votedMatchSet = new Set((voteRows as Array<{ matchId: string }>).map((r) => r.matchId));
    const visitedSet = new Set((visitRows as Array<{ userId: string }>).map((r) => r.userId));
    const seen = seenMap || {};

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
    // Cache the id order for stable, cheap pagination within the TTL.
    await cachePut(c.env, orderKey, ranked.map((m) => m.id), 60);
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
  const cached = await cacheGetJson<any[]>(c.env, key);
  if (cached !== null) {
    c.header("Cache-Control", "public, max-age=60");
    return c.json(cached);
  }

  const db = getDb(c.env);
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
  const contests = rows.map(mapContest);
  // 60s, as before — but the window is evaluated per cache MISS, so a contest
  // can appear or disappear up to a minute late. That is why the app also
  // counts down locally and disables an entry whose endsAt has passed: the
  // last-minute case is handled client-side rather than by shortening the TTL
  // for every request.
  await cachePutJson(c.env, key, contests, 60);
  c.header("Cache-Control", "public, max-age=60");
  return c.json(contests);
});

readRoute.get("/contests/:id", optionalAuth, async (c) => {
  const id = c.req.param("id");
  const key = contestDetailCacheKey(id);
  // Wrap the value so a cached not-found (null) is distinguishable from a miss.
  const cached = await cacheGetJson<{ contest: ReturnType<typeof mapContest> | null }>(c.env, key);
  if (cached !== null) {
    c.header("Cache-Control", "public, max-age=60");
    return c.json(cached.contest);
  }

  const db = getDb(c.env);
  const row = await db.select().from(schema.contests).where(eq(schema.contests.id, id)).get();
  const contest = row ? mapContest(row) : null;
  await cachePutJson(c.env, key, { contest }, 60);
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

  // Cache each page for 15s. nextCursor is returned via the X-Next-Cursor
  // header (response body stays a plain array — non-breaking).
  const cacheKey = `cache:matches:${status}:${type || "all"}:${sort}:${limit}:${cursorRaw || "0"}`;
  const cached = await cacheGet(c.env, cacheKey);
  if (cached) {
    if (cached.nextCursor != null) c.header("X-Next-Cursor", String(cached.nextCursor));
    if (uid) {
      // Per-user data — must never be stored by a shared/edge cache.
      c.header("Cache-Control", "private, no-store");
      // Filtered on the way out of the shared page cache, never on the way in.
      const visible = excludeHiddenMatches(cached.matches, await hiddenUidsFor(c.env, uid));
      return c.json(await hydrateViewerState(db, visible, uid));
    }
    c.header("Cache-Control", "public, max-age=15");
    return c.json(cached.matches);
  }

  const conds = [eq(schema.contestMatches.status, status)];
  if (type) conds.push(eq(schema.contestMatches.type, type));

  let matches: any[];
  let nextCursor: number | null = null;

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
    matches = rows.map(mapMatch).map((m) => enrichMatchMedia(c.env, m));
    await enrichParticipantsVerified(c.env, matches);
    nextCursor = rows.length === limit ? offset + limit : null;
  } else {
    // Keyset pagination by createdAt — stable and index-friendly.
    if (cursorRaw) conds.push(lt(schema.contestMatches.createdAt, parseInt(cursorRaw, 10)));
    const rows = await db
      .select()
      .from(schema.contestMatches)
      .where(and(...conds))
      .orderBy(desc(schema.contestMatches.createdAt))
      .limit(limit)
      .all();
    matches = rows.map(mapMatch).map((m) => enrichMatchMedia(c.env, m));
    await enrichParticipantsVerified(c.env, matches);
    nextCursor = rows.length === limit ? rows[rows.length - 1].createdAt : null;
  }

  if (nextCursor != null) c.header("X-Next-Cursor", String(nextCursor));
  // Cache the user-agnostic base list, then layer this viewer's vote state on
  // top of a fresh copy so the cached page stays shareable.
  await cachePut(c.env, cacheKey, { matches, nextCursor }, 30);
  if (uid) {
    c.header("Cache-Control", "private, no-store");
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
  await enrichParticipantsVerified(c.env, [out]);
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

  const cacheKey = `cache:leaderboard:${by}:${limit}`;
  const cached = await cacheGet(c.env, cacheKey);
  if (cached) return c.json(await visibleRanks(cached));
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
  const enriched = rows.map((r: any) => ({ ...r, profileImageUrlThumb: avatarUrl(c.env, r.profileImageUrl) }));
  await cachePut(c.env, cacheKey, enriched, 60);
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
  return edgeCached(c, 120, async () => {
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
  return edgeCached(c, 600, async () => {
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
  edgeCached(c, 120, async () => {
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
readRoute.get("/users/suggested", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user")?.uid;
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  // Suggesting someone the viewer blocked or muted is the single most jarring
  // place for one to appear, so this is filtered in SQL rather than after the
  // fact — it keeps the requested page size intact instead of returning short.
  const hidden = await hiddenUidsFor(c.env, uid);
  const excluded = sqlExclusionList(hidden);
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
    .where(
      excluded.length
        ? and(publiclyVisibleUser, notInArray(schema.users.uid, excluded))
        : publiclyVisibleUser,
    )
    .limit(limit)
    .all();
  if (hidden.size) c.header("Cache-Control", "private, no-store");
  // Safety net for a viewer past SQL_EXCLUSION_MAX, where the clause above only
  // covers part of the set.
  const visible = exclusionTruncated(hidden) ? excludeHiddenBy(rows as any[], hidden, (r: any) => r.id) : rows;
  return c.json(visible);
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

readRoute.get("/users/:id", optionalAuth, async (c) => {
  const id = c.req.param("id");
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

  // The public profile is viewer-agnostic (target user's own data + their
  // following list), so it's safe to share one cached copy across all callers.
  // The app polls this heavily, so a short KV cache saves a lot of D1 reads.
  // Invalidated immediately when the user edits their profile (see api.ts
  // updateProfile → delCache(userCacheKey)). Follower counts may lag by <=TTL.
  /**
   * Last per-viewer pass over the SHARED cached copy.
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
   * An account that is pending deletion, or already anonymised, reads as "does
   * not exist" to everyone but its owner.
   *
   * Null rather than an error or an empty profile, matching how a block is
   * handled above: any other answer distinguishes "deleted" from "never existed",
   * and the owner is the only person entitled to know which.
   *
   * The owner still gets the real row, because the app needs it to render the
   * "scheduled for deletion — cancel?" screen, and that screen is the only way
   * back from a deletion the user did not mean to start.
   *
   * Checked on the CACHED copy too, and used to suppress the cache WRITE. The
   * shared entry is keyed only by uid, so without the write guard the owner's own
   * fetch would publish a hidden account's profile for every other viewer to
   * read — the request path invalidates this key, but re-populating it here would
   * undo that immediately.
   */
  const hiddenAccount = (profile: any): boolean =>
    viewer !== id && isHiddenAccountStatus(profile?.status);

  const key = userCacheKey(id);
  const cached = await cacheGetJson<any>(c.env, key);
  if (cached !== null) {
    if (hiddenAccount(cached)) {
      c.header("Cache-Control", "private, no-store");
      return c.json(null);
    }
    return c.json(await forViewer(cached));
  }

  const db = getDb(c.env);
  const row = await db.select().from(schema.users).where(eq(schema.users.uid, id)).get();
  if (!row) return c.json(null);
  if (hiddenAccount(row)) {
    c.header("Cache-Control", "private, no-store");
    return c.json(null);
  }

  const { fcmTokens, ...columns } = row as any;
  /**
   * Merge `extra` UNDER the real columns, never over them.
   *
   * `extra` is a free-form JSON blob holding the fields with no column of their
   * own (facebook/twitter/instagram). It is written from whatever
   * `updateProfile` did not recognise — so this merge used to be
   * `Object.assign(safe, safe.extra)`, letting a key that happened to share a
   * column's name OVERWRITE that column in the response. A user could set
   * `{verified: true}` and read back a verified badge; the same trick covered
   * `dpcoin`, `role`, `followersCount`, `status` and `email`. The database was
   * never wrong, which is why nobody noticed — the API simply served the
   * account's own claims about itself as fact, including into the shared KV
   * cache below, where other viewers would read them too.
   *
   * `updateProfile` now refuses to put column names in `extra` at all. This is
   * the second half of that fix, and the half that also neutralises every row
   * already carrying a poisoned blob.
   */
  const safe: any =
    columns.extra && typeof columns.extra === "object"
      ? { ...columns.extra, ...columns }
      : columns;
  // expose following[] (list of uids) for screens that expect it
  const following = await db.select({ id: schema.follows.followingId }).from(schema.follows).where(eq(schema.follows.followerId, row.uid)).all();
  safe.following = following.map((f) => f.id);
  safe.profileImageUrlThumb = avatarUrl(c.env, safe.profileImageUrl);
  if (!isHiddenAccountStatus(row.status)) {
    await cachePutJson(c.env, key, safe, 30);
  } else {
    c.header("Cache-Control", "private, no-store");
  }
  return c.json(await forViewer(safe));
});

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
  await enrichParticipantsVerified(c.env, base);

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

  if (isFirstPage) {
    const cached = await cacheGetJson<{ items: any[]; nextCursor: number | null }>(c.env, cacheKey);
    if (cached) {
      const body = await visible(cached.items);
      const res = c.json(body) as Response;
      res.headers.set("Cache-Control", cacheHeader());
      if (cached.nextCursor != null) res.headers.set("X-Next-Cursor", String(cached.nextCursor));
      return res;
    }
  }

  const { items, nextCursor } = await listConnections(c, targetId, direction, cursor, limit);

  if (isFirstPage) {
    c.executionCtx.waitUntil(cachePutJson(c.env, cacheKey, { items, nextCursor }, 30));
  }

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
  // no verified flag. Stamp it live off the members' current rows, so a blue
  // check in the conversation list stays correct even for a chat opened months
  // ago (and disappears if the user is un-verified).
  const memberUids = visible.flatMap((chat: any) => (chat.users as string[]) || []);
  const verifiedMembers = await verifiedUidSet(c.env, memberUids);
  if (verifiedMembers.size) {
    for (const chat of visible) {
      if (Array.isArray(chat.usersData)) {
        chat.usersData = chat.usersData.map((m: any) =>
          m?.uid ? { ...m, verified: verifiedMembers.has(m.uid) } : m,
        );
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
  const q = c.req.query("q") || "";
  const limit = parseInt(c.req.query("limit") || "20", 10) || 20;

  // Our own catalogue first. It is authoritative, instant, and cannot be
  // throttled by other traffic sharing our egress IP.
  const curated = await searchCatalog(c.env, q, limit);
  if (curated.length > 0) {
    c.header("Cache-Control", "public, max-age=600");
    return c.json({ items: curated, source: "catalog" });
  }

  // Nothing curated matched, so widen to the provider. `providerFailed`
  // distinguishes "we asked and got nothing back" from "there is genuinely no
  // such song" — collapsing those into an empty array is exactly why a throttled
  // provider looked like an empty search box for so long.
  const provider = await searchTracks(c.env, q, limit);
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

  // Only the first page is cached (by far the most requested + kept fresh by
  // the add/delete cache bust in routes/api.ts). Deeper pages are rare, so they
  // hit D1 directly. The per-viewer `likedByMe` flag is layered on per request
  // and never baked into the shared cache. Comment like COUNTS are eventually
  // consistent within the TTL — the same trade-off the feed makes for votes.
  const cacheKey = commentsCacheKey(targetType, targetId);
  let payload: { items: any[]; nextCursor: string | null; total?: number } | null = isFirstPage
    ? await cacheGet(c.env, cacheKey)
    : null;

  if (!payload) {
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
    payload = { items, nextCursor };
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
    if (isFirstPage) await cachePut(c.env, cacheKey, payload, 30);
  }

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
  const db = getDb(c.env);
  const uid = c.get("user").uid;
  const nowMs = Date.now();
  // The stories bar sits directly above the feed, so it uses the same wider
  // `hiddenUidsFor` (blocks AND mutes) — "stop showing me this person" has to
  // cover both or the feature looks broken. Filtered in SQL because this
  // endpoint has no shared cache to poison.
  const hiddenAuthors = await hiddenUidsFor(c.env, uid);
  const excludedAuthors = sqlExclusionList(hiddenAuthors);
  const allRows = await db
    .select()
    .from(schema.stories)
    .where(
      excludedAuthors.length
        ? and(gt(schema.stories.expiresAt, nowMs), notInArray(schema.stories.userId, excludedAuthors))
        : gt(schema.stories.expiresAt, nowMs),
    )
    .orderBy(desc(schema.stories.createdAt))
    .limit(100)
    .all();
  const rows = exclusionTruncated(hiddenAuthors)
    ? excludeHiddenBy(allRows as any[], hiddenAuthors, (r: any) => r.userId)
    : allRows;

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
  if (cacheable) {
    const cached = await cacheGet(c.env, cacheKey);
    if (cached) return c.json(cached);
  }

  const rows = await db
    .select()
    .from(schema.blogPosts)
    .where(and(...conds))
    .orderBy(desc(schema.blogPosts.publishedAt))
    .limit(limit)
    .all();

  const nextCursor = rows.length === limit ? rows[rows.length - 1].publishedAt : null;
  const payload = { posts: rows.map((r) => mapBlogPost(c.env, r)), nextCursor };
  if (cacheable) {
    await cachePut(c.env, cacheKey, payload, 120);
    c.header("Cache-Control", "public, max-age=60");
  }
  return c.json(payload);
});

// Distinct categories with post counts — for the blog filter UI. Public and
// slow-changing, so edge-cache 5min to skip D1's GROUP BY on repeat loads.
readRoute.get("/blog/categories", async (c) =>
  edgeCached(c, 300, async () => {
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
readRoute.get("/blog/sitemap", async (c) =>
  edgeCached(c, 900, async () => {
    const db = getDb(c.env);
    const MAX_LIMIT = 10000;
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") || String(MAX_LIMIT), 10) || MAX_LIMIT, 1), MAX_LIMIT);
    const cursor = c.req.query("cursor") ? parseInt(c.req.query("cursor")!, 10) : null;

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
  }),
);

// Single post by slug (falls back to id). Increments view count fire-and-forget.
readRoute.get("/blog/:slug", async (c) => {
  const db = getDb(c.env);
  const key = c.req.param("slug");
  const cacheKey = blogPostCacheKey(key);

  // Serve the (expensive-to-serialize) full post body from KV when hot. The
  // view counter still increments on every request — only the payload is
  // cached — so analytics stay live while D1 content reads drop. The displayed
  // viewCount itself may lag by up to the TTL, which is fine for a blog.
  const cached = await cacheGetJson<{ id: string } & Record<string, any>>(c.env, cacheKey);
  if (cached) {
    db.update(schema.blogPosts)
      .set({ viewCount: sql`${schema.blogPosts.viewCount} + 1` })
      .where(eq(schema.blogPosts.id, cached.id))
      .run()
      .catch(() => {});
    return c.json(cached);
  }

  let row = await db.select().from(schema.blogPosts).where(eq(schema.blogPosts.slug, key)).get();
  if (!row) row = await db.select().from(schema.blogPosts).where(eq(schema.blogPosts.id, key)).get();
  if (!row || row.status !== "published") return c.json(null);
  // Best-effort view counter (don't block the response on it).
  db.update(schema.blogPosts)
    .set({ viewCount: sql`${schema.blogPosts.viewCount} + 1` })
    .where(eq(schema.blogPosts.id, row.id))
    .run()
    .catch(() => {});
  const payload = mapBlogPost(c.env, row, { withContent: true });
  await cachePutJson(c.env, cacheKey, payload, 120);
  return c.json(payload);
});
