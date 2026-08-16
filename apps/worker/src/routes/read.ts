/**
 * /read — GET endpoints that replace the client's direct Firestore reads and
 * onSnapshot listeners. Realtime is achieved by polling these endpoints
 * (see the client `subscribe*` helpers). Responses use the camelCase shapes
 * the existing screens already consume, so UI code stays unchanged.
 */
import { Hono } from "hono";
import { and, or, eq, desc, asc, gt, lt, sql, inArray, like } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "../lib/http";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { getAppConfig } from "../lib/settings";
import { enrichMatchMedia, avatarUrl, thumbUrl, optimizedUrl } from "../lib/media";
import {
  userCacheKey,
  blogPostCacheKey,
  blogListCacheKey,
  contestListCacheKey,
  contestDetailCacheKey,
  commentsCacheKey,
  cacheGetJson,
  cachePutJson,
} from "../lib/cache";
import { getLiveTally, getViewerVote } from "../lib/voteCounter";

export const readRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

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
    await env.CACHE_KV.put(key, JSON.stringify(data), { expirationTtl: ttlSec });
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
  const cache = (caches as any).default as Cache;
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: "GET" });
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch {
    /* cache unavailable — fall through */
  }
  const data = await producer();
  const res = c.json(data) as Response;
  res.headers.set("Cache-Control", `public, max-age=${ttlSec}`);
  try {
    c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
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
const FEED_FOLLOW_BOOST = 3.0; // relationship is the strongest personal signal
const FEED_VOTED_PENALTY = 1.5; // you already engaged → make room for fresh battles

/** User-agnostic content score for one match (higher = show sooner). */
function rankBaseScore(r: any, now: number): number {
  const start = Number(r.activatedAt || r.createdAt || now);
  const ageHours = Math.max(0, (now - start) / 3_600_000);

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

  // Velocity (engagement per hour) lets a brand-new battle out-rank an old one
  // that only accumulated its counts slowly. +2 smooths the first minutes.
  const velocity = engagement / (ageHours + 2);
  // Freshness decays over ~a day so the feed keeps turning over.
  const freshness = Math.exp(-ageHours / 24);
  // Closing-soon urgency: nudge battles into view in their final hours so people
  // can still vote before they end.
  let urgency = 0;
  const exp = Number(r.expiresAt);
  if (Number.isFinite(exp)) {
    const hoursLeft = (exp - now) / 3_600_000;
    if (hoursLeft > 0 && hoursLeft <= 6) urgency = 1 - hoursLeft / 6;
  }
  const prize = Math.log1p(Number(r.entryFee) || 0);

  return 2.2 * freshness + 1.6 * Math.log1p(velocity) + 1.2 * urgency + 0.3 * prize;
}

/**
 * Serve the personalized "For You" feed. Candidate pool is cached user-agnostic;
 * the per-viewer re-rank + engagement hydration run per request (never cached).
 * Pagination is offset-based over the ranked pool (stable within a cache window).
 */
async function servePersonalizedFeed(
  c: any,
  db: any,
  opts: { status: string; type?: string; limit: number; cursorRaw?: string; uid?: string },
) {
  const { status, type, limit, cursorRaw, uid } = opts;
  const now = Date.now();

  const candKey = `cache:matches:cand:${status}:${type || "all"}`;
  let candidates: any[] | null = await cacheGet(c.env, candKey);
  if (!candidates) {
    const conds = [eq(schema.contestMatches.status, status)];
    if (type) conds.push(eq(schema.contestMatches.type, type));
    const rows = await db
      .select()
      .from(schema.contestMatches)
      .where(and(...conds))
      .orderBy(desc(schema.contestMatches.createdAt))
      .limit(FEED_CANDIDATE_POOL)
      .all();
    candidates = (rows as any[])
      .map((r) => ({ ...enrichMatchMedia(c.env, mapMatch(r)), _base: rankBaseScore(r, now) }))
      .sort((a, b) => b._base - a._base);
    await cachePut(c.env, candKey, candidates, 45);
  }

  let ranked = candidates;
  if (uid && candidates.length > 0) {
    const ids = candidates.map((m) => m.id);
    const participantUids = Array.from(
      new Set(candidates.flatMap((m) => [m.userA?.uid, m.userB?.uid]).filter(Boolean) as string[]),
    );
    const [followRows, votedRows] = await Promise.all([
      participantUids.length
        ? db
            .select({ following: schema.follows.followingId })
            .from(schema.follows)
            .where(and(eq(schema.follows.followerId, uid), inArray(schema.follows.followingId, participantUids)))
            .all()
        : Promise.resolve([] as Array<{ following: string }>),
      db
        .select({ matchId: schema.votes.matchId })
        .from(schema.votes)
        .where(and(eq(schema.votes.voterUid, uid), inArray(schema.votes.matchId, ids)))
        .all(),
    ]);
    const followSet = new Set((followRows as Array<{ following: string }>).map((r) => r.following));
    const votedSet = new Set((votedRows as Array<{ matchId: string }>).map((r) => r.matchId));
    ranked = candidates
      .map((m) => {
        let s = m._base as number;
        if (followSet.has(m.userA?.uid) || followSet.has(m.userB?.uid)) s += FEED_FOLLOW_BOOST;
        if (votedSet.has(m.id)) s -= FEED_VOTED_PENALTY;
        return { m, s };
      })
      .sort((a, b) => b.s - a.s)
      .map((x) => x.m);
  }

  const offset = cursorRaw ? Math.max(parseInt(cursorRaw, 10) || 0, 0) : 0;
  const pageItems = ranked.slice(offset, offset + limit).map((m) => {
    const { _base, ...rest } = m; // strip the internal score from the response
    return rest;
  });
  const nextCursor = offset + limit < ranked.length ? offset + limit : null;
  if (nextCursor != null) c.header("X-Next-Cursor", String(nextCursor));

  if (uid) {
    c.header("Cache-Control", "private, no-store");
    return c.json(await hydrateViewerState(db, pageItems, uid));
  }
  c.header("Cache-Control", "public, max-age=15");
  return c.json(pageItems);
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
  rewardCoins: r.rewardCoins,
  winningCoins: r.rewardCoins,
  voteDurationDays: r.voteDurationDays,
  autoCancelHours: r.autoCancelHours,
  minVotes: r.minVotes,
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
  minVotesRequired: r.minVotesRequired,
  endingSoonNotified: r.endingSoonNotified,
  createdAt: r.createdAt,
  activatedAt: r.activatedAt,
  completedAt: r.completedAt,
  expiresAt: r.expiresAt,
});

const mapNotification = (r: any) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  type: r.type,
  read: !!r.read,
  targetId: r.targetId,
  image: r.image,
  createdAt: r.createdAt, // epoch ms
});

const mapBlogPost = (r: any, opts: { withContent?: boolean } = {}) => ({
  id: r.id,
  slug: r.slug,
  title: r.title,
  excerpt: r.excerpt,
  coverImageUrl: r.coverImageUrl,
  category: r.category,
  tags: r.tags || [],
  author: r.author,
  viewCount: r.viewCount ?? 0,
  publishedAt: r.publishedAt ?? r.createdAt,
  createdAt: r.createdAt,
  ...(opts.withContent
    ? {
        content: r.content,
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
  const conds = [eq(schema.contests.status, "live")];
  if (type) conds.push(eq(schema.contests.type, type));
  const rows = await db.select().from(schema.contests).where(and(...conds)).all();
  const contests = rows.map(mapContest);
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
  // sort=foryou (personalized ranking) | hot (engagement-ranked) | recent
  // (default, keyset by createdAt).
  const sortParam = c.req.query("sort");
  const sort = sortParam === "hot" ? "hot" : sortParam === "foryou" ? "foryou" : "recent";
  const limit = Math.min(parseInt(c.req.query("limit") || "30", 10), 100);
  const cursorRaw = c.req.query("cursor");
  // Signed-in viewer (optionalAuth). Only the base list is cached publicly; the
  // viewer's vote state is layered on per-request so refresh keeps "Voted".
  const uid = c.get("user")?.uid;

  // Personalized "For You" ranking has its own caching model (shared candidate
  // pool + per-viewer re-rank), so it returns before the per-page cache below.
  if (sort === "foryou") {
    return servePersonalizedFeed(c, db, { status, type, limit, cursorRaw, uid });
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
      return c.json(await hydrateViewerState(db, cached.matches, uid));
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
    nextCursor = rows.length === limit ? rows[rows.length - 1].createdAt : null;
  }

  if (nextCursor != null) c.header("X-Next-Cursor", String(nextCursor));
  // Cache the user-agnostic base list, then layer this viewer's vote state on
  // top of a fresh copy so the cached page stays shareable.
  await cachePut(c.env, cacheKey, { matches, nextCursor }, 30);
  if (uid) {
    c.header("Cache-Control", "private, no-store");
    return c.json(await hydrateViewerState(db, matches, uid));
  }
  c.header("Cache-Control", "public, max-age=15");
  return c.json(matches);
});

readRoute.get("/matches/:id", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const row = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, id)).get();
  if (!row) return c.json(null);
  const out: any = mapMatch(row);
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
  const cacheKey = `cache:leaderboard:${by}:${limit}`;
  const cached = await cacheGet(c.env, cacheKey);
  if (cached) return c.json(cached);
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
    })
    .from(schema.users)
    .orderBy(desc(orderCol))
    .limit(limit)
    .all();
  const enriched = rows.map((r: any) => ({ ...r, profileImageUrlThumb: avatarUrl(c.env, r.profileImageUrl) }));
  await cachePut(c.env, cacheKey, enriched, 60);
  c.header("Cache-Control", "public, max-age=30");
  return c.json(enriched);
});

// ================= APP CONFIG =================
readRoute.get("/app-config", async (c) => {
  return edgeCached(c, 120, async () => (await getAppConfig(c.env)) || {});
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
readRoute.get("/notifications", requireAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user").uid;
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  const rows = await db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.recipientId, uid))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(limit)
    .all();
  return c.json(rows.map(mapNotification));
});

readRoute.get("/notifications/unread-count", requireAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user").uid;
  const row = await db
    .select({ v: sql<number>`count(*)` })
    .from(schema.notifications)
    .where(and(eq(schema.notifications.recipientId, uid), eq(schema.notifications.read, false)))
    .get();
  return c.json({ count: row?.v ?? 0 });
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
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  const rows = await db
    .select({
      id: schema.users.uid,
      fullName: schema.users.fullName,
      username: schema.users.username,
      profileImageUrl: schema.users.profileImageUrl,
      coordinates: schema.users.coordinates,
    })
    .from(schema.users)
    .limit(limit)
    .all();
  return c.json(rows);
});

readRoute.get("/users/search", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const q = (c.req.query("q") || "").toLowerCase();
  if (q.length < 2) return c.json([]);
  const rows = await db
    .select({ id: schema.users.uid, username: schema.users.username, avatarUrl: schema.users.profileImageUrl })
    .from(schema.users)
    .where(like(schema.users.username, `${q}%`))
    .limit(10)
    .all();
  return c.json(rows);
});

readRoute.get("/users/:id", optionalAuth, async (c) => {
  const id = c.req.param("id");
  // The public profile is viewer-agnostic (target user's own data + their
  // following list), so it's safe to share one cached copy across all callers.
  // The app polls this heavily, so a short KV cache saves a lot of D1 reads.
  // Invalidated immediately when the user edits their profile (see api.ts
  // updateProfile → delCache(userCacheKey)). Follower counts may lag by <=TTL.
  const key = userCacheKey(id);
  const cached = await cacheGetJson(c.env, key);
  if (cached !== null) return c.json(cached);

  const db = getDb(c.env);
  const row = await db.select().from(schema.users).where(eq(schema.users.uid, id)).get();
  if (!row) return c.json(null);
  const { fcmTokens, ...safe } = row as any;
  // expose following[] (list of uids) for screens that expect it
  const following = await db.select({ id: schema.follows.followingId }).from(schema.follows).where(eq(schema.follows.followerId, row.uid)).all();
  safe.following = following.map((f) => f.id);
  // merge extra json fields (facebook/twitter/instagram, etc.) to top level
  if (safe.extra && typeof safe.extra === "object") {
    Object.assign(safe, safe.extra);
  }
  safe.profileImageUrlThumb = avatarUrl(c.env, safe.profileImageUrl);
  await cachePutJson(c.env, key, safe, 30);
  return c.json(safe);
});

readRoute.get("/users/:id/posts", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const userId = c.req.param("id");
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

readRoute.get("/users/:id/bookmarks", requireAuth, async (c) => {
  const db = getDb(c.env);
  const userId = c.req.param("id");
  const rows = await db
    .select({ matchId: schema.bookmarks.matchId })
    .from(schema.bookmarks)
    .where(eq(schema.bookmarks.userId, userId))
    .all();
  const ids = rows.map((r) => r.matchId);
  if (!ids.length) return c.json([]);
  const matches = await db.select().from(schema.contestMatches).where(inArray(schema.contestMatches.id, ids)).all();
  return c.json(matches.map(mapMatch));
});

async function connectionUsers(c: any, uids: string[]) {
  const db = getDb(c.env);
  if (!uids.length) return [];
  const rows = await db
    .select({ id: schema.users.uid, username: schema.users.username, fullName: schema.users.fullName, profileImageUrl: schema.users.profileImageUrl })
    .from(schema.users)
    .where(inArray(schema.users.uid, uids))
    .all();
  return rows;
}

readRoute.get("/users/:id/followers", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const rows = await db.select({ id: schema.follows.followerId }).from(schema.follows).where(eq(schema.follows.followingId, c.req.param("id"))).all();
  return c.json(await connectionUsers(c, rows.map((r) => r.id)));
});

readRoute.get("/users/:id/following", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const rows = await db.select({ id: schema.follows.followingId }).from(schema.follows).where(eq(schema.follows.followerId, c.req.param("id"))).all();
  return c.json(await connectionUsers(c, rows.map((r) => r.id)));
});

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
  return c.json(chats);
});

readRoute.get("/chats/:id/messages", requireAuth, async (c) => {
  const db = getDb(c.env);
  const chatId = c.req.param("id");
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


// ================= COMMENTS (posts or matches) =================
readRoute.get("/comments", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user")?.uid;
  const targetType = c.req.query("targetType") || "posts";
  const targetId = c.req.query("targetId");
  if (!targetId) return c.json({ items: [], nextCursor: null });

  const isMatch = targetType === "matches" || targetType === "contestMatches";
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
  let payload: { items: any[]; nextCursor: string | null } | null = isFirstPage
    ? await cacheGet(c.env, cacheKey)
    : null;

  if (!payload) {
    const keyset =
      cursorAt != null && Number.isFinite(cursorAt)
        ? isMatch
          ? or(lt(schema.matchComments.createdAt, cursorAt), and(eq(schema.matchComments.createdAt, cursorAt), lt(schema.matchComments.id, cursorId)))
          : or(lt(schema.postComments.createdAt, cursorAt), and(eq(schema.postComments.createdAt, cursorAt), lt(schema.postComments.id, cursorId)))
        : undefined;

    const rows = isMatch
      ? await db
          .select({
            id: schema.matchComments.id, userId: schema.matchComments.userId, text: schema.matchComments.text,
            likes: schema.matchComments.likeCount, createdAt: schema.matchComments.createdAt,
            username: schema.users.username, userAvatar: schema.users.profileImageUrl,
          })
          .from(schema.matchComments)
          .leftJoin(schema.users, eq(schema.matchComments.userId, schema.users.uid))
          .where(and(eq(schema.matchComments.matchId, targetId), keyset))
          .orderBy(desc(schema.matchComments.createdAt), desc(schema.matchComments.id))
          .limit(limit + 1)
          .all()
      : await db
          .select({
            id: schema.postComments.id, userId: schema.postComments.userId, text: schema.postComments.text,
            likes: schema.postComments.likeCount, createdAt: schema.postComments.createdAt,
            username: schema.users.username, userAvatar: schema.users.profileImageUrl,
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
    if (isFirstPage) await cachePut(c.env, cacheKey, payload, 30);
  }

  // Layer the signed-in viewer's per-comment like state so hearts stay filled.
  let items = payload.items;
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
    return c.json({ items, nextCursor: payload.nextCursor });
  }

  c.header("Cache-Control", "public, max-age=10");
  return c.json({ items, nextCursor: payload.nextCursor });
});

// ================= STORIES =================
async function attachUsers(c: any, userIds: string[]) {
  const db = getDb(c.env);
  if (!userIds.length) return {} as Record<string, { username: string; avatarUrl: string }>;
  const rows = await db
    .select({ uid: schema.users.uid, username: schema.users.username, fullName: schema.users.fullName, avatar: schema.users.profileImageUrl })
    .from(schema.users)
    .where(inArray(schema.users.uid, userIds))
    .all();
  const map: Record<string, { username: string; avatarUrl: string }> = {};
  for (const u of rows) {
    map[u.uid] = {
      username: u.username || u.fullName || "User",
      avatarUrl: u.avatar || `https://ui-avatars.com/api/?name=${u.username || "U"}`,
    };
  }
  return map;
}

readRoute.get("/stories/feed", requireAuth, async (c) => {
  const db = getDb(c.env);
  const uid = c.get("user").uid;
  const nowMs = Date.now();
  const rows = await db
    .select()
    .from(schema.stories)
    .where(gt(schema.stories.expiresAt, nowMs))
    .orderBy(desc(schema.stories.createdAt))
    .limit(100)
    .all();

  const userIds = [...new Set(rows.map((r) => r.userId))];
  const userMap = await attachUsers(c, userIds);

  const grouped: Record<string, any[]> = {};
  for (const s of rows) {
    (grouped[s.userId] ||= []).push({
      ...s,
      seen: false,
      mediaUrlThumb: thumbUrl(c.env, (s as any).mediaUrl),
      mediaUrlOptimized: optimizedUrl(c.env, (s as any).mediaUrl),
    });
  }
  const list = Object.keys(grouped).map((userId) => ({
    userId,
    username: userMap[userId]?.username || "User",
    avatarUrl: userMap[userId]?.avatarUrl || `https://ui-avatars.com/api/?name=U`,
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
    avatarUrl: userMap[userId]?.avatarUrl,
    stories: rows.map((s) => ({ ...s, seen: false })),
    hasUnseen: true,
  });
});

readRoute.get("/stories/:id/viewers", requireAuth, async (c) => {
  const db = getDb(c.env);
  const storyId = c.req.param("id");
  const rows = await db
    .select({
      uid: schema.storyViews.viewerId, viewedAt: schema.storyViews.createdAt, reaction: schema.storyViews.reaction,
      username: schema.users.username, avatarUrl: schema.users.profileImageUrl,
    })
    .from(schema.storyViews)
    .leftJoin(schema.users, eq(schema.storyViews.viewerId, schema.users.uid))
    .where(eq(schema.storyViews.storyId, storyId))
    .all();
  return c.json(rows.map((r: any) => ({
    uid: r.uid,
    username: r.username || "Unknown",
    avatarUrl: r.avatarUrl || `https://ui-avatars.com/api/?name=${r.username || "U"}`,
    viewedAt: r.viewedAt,
    reaction: r.reaction || null,
  })));
});

// ================= HIGHLIGHTS =================
readRoute.get("/users/:id/highlights", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select()
    .from(schema.highlights)
    .where(eq(schema.highlights.userId, c.req.param("id")))
    .orderBy(desc(schema.highlights.createdAt))
    .all();
  return c.json(rows);
});

readRoute.get("/highlights/:id/stories", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const h = await db.select().from(schema.highlights).where(eq(schema.highlights.id, c.req.param("id"))).get();
  if (!h) return c.json(null);
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
  const payload = { posts: rows.map((r) => mapBlogPost(r)), nextCursor };
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
  const payload = mapBlogPost(row, { withContent: true });
  await cachePutJson(c.env, cacheKey, payload, 120);
  return c.json(payload);
});
