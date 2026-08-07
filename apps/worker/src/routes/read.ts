/**
 * /read — GET endpoints that replace the client's direct Firestore reads and
 * onSnapshot listeners. Realtime is achieved by polling these endpoints
 * (see the client `subscribe*` helpers). Responses use the camelCase shapes
 * the existing screens already consume, so UI code stays unchanged.
 */
import { Hono } from "hono";
import { and, eq, desc, asc, gt, lt, sql, inArray, like } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "../lib/http";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { getAppConfig } from "../lib/settings";
import { enrichMatchMedia, avatarUrl, thumbUrl, optimizedUrl } from "../lib/media";

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

// --- mappers ---------------------------------------------------------------
const mapContest = (r: any) => ({
  id: r.id,
  ...(r.extra || {}),
  title: r.title,
  name: r.title,
  type: r.type,
  status: r.status,
  totalEntryFee: r.totalEntryFee,
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
  ...(opts.withContent ? { content: r.content } : {}),
});

// ================= CONTESTS =================
readRoute.get("/contests", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const type = c.req.query("type");
  const conds = [eq(schema.contests.status, "live")];
  if (type) conds.push(eq(schema.contests.type, type));
  const rows = await db.select().from(schema.contests).where(and(...conds)).all();
  return c.json(rows.map(mapContest));
});

readRoute.get("/contests/:id", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const row = await db.select().from(schema.contests).where(eq(schema.contests.id, c.req.param("id"))).get();
  return c.json(row ? mapContest(row) : null);
});

// ================= MATCHES =================
readRoute.get("/matches", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status") || "active";
  const type = c.req.query("type");
  // sort=recent (default, keyset by createdAt) | hot (engagement-ranked, offset)
  const sort = c.req.query("sort") === "hot" ? "hot" : "recent";
  const limit = Math.min(parseInt(c.req.query("limit") || "30", 10), 100);
  const cursorRaw = c.req.query("cursor");

  // Cache each page for 15s. nextCursor is returned via the X-Next-Cursor
  // header (response body stays a plain array — non-breaking).
  const cacheKey = `cache:matches:${status}:${type || "all"}:${sort}:${limit}:${cursorRaw || "0"}`;
  const cached = await cacheGet(c.env, cacheKey);
  if (cached) {
    if (cached.nextCursor != null) c.header("X-Next-Cursor", String(cached.nextCursor));
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
  await cachePut(c.env, cacheKey, { matches, nextCursor }, 15);
  return c.json(matches);
});

readRoute.get("/matches/:id", optionalAuth, async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const row = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, id)).get();
  if (!row) return c.json(null);
  const out: any = mapMatch(row);
  const uid = c.get("user")?.uid;
  if (uid) {
    const liked = await db.select().from(schema.matchLikes).where(and(eq(schema.matchLikes.matchId, id), eq(schema.matchLikes.userId, uid))).get();
    const bookmarked = await db.select().from(schema.bookmarks).where(and(eq(schema.bookmarks.userId, uid), eq(schema.bookmarks.matchId, id))).get();
    out.isLiked = !!liked;
    out.isBookmarked = !!bookmarked;
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
  await cachePut(c.env, cacheKey, enriched, 30);
  return c.json(enriched);
});

// ================= APP CONFIG =================
readRoute.get("/app-config", async (c) => {
  const cfg = await getAppConfig(c.env);
  return c.json(cfg || {});
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
  const db = getDb(c.env);
  const row = await db.select().from(schema.users).where(eq(schema.users.uid, c.req.param("id"))).get();
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
  const targetType = c.req.query("targetType") || "posts";
  const targetId = c.req.query("targetId");
  if (!targetId) return c.json([]);

  const isMatch = targetType === "matches" || targetType === "contestMatches";
  const rows = isMatch
    ? await db
        .select({
          id: schema.matchComments.id, userId: schema.matchComments.userId, text: schema.matchComments.text,
          likes: schema.matchComments.likeCount, createdAt: schema.matchComments.createdAt,
          username: schema.users.username, userAvatar: schema.users.profileImageUrl,
        })
        .from(schema.matchComments)
        .leftJoin(schema.users, eq(schema.matchComments.userId, schema.users.uid))
        .where(eq(schema.matchComments.matchId, targetId))
        .orderBy(desc(schema.matchComments.createdAt))
        .all()
    : await db
        .select({
          id: schema.postComments.id, userId: schema.postComments.userId, text: schema.postComments.text,
          likes: schema.postComments.likeCount, createdAt: schema.postComments.createdAt,
          username: schema.users.username, userAvatar: schema.users.profileImageUrl,
        })
        .from(schema.postComments)
        .leftJoin(schema.users, eq(schema.postComments.userId, schema.users.uid))
        .where(eq(schema.postComments.postId, targetId))
        .orderBy(desc(schema.postComments.createdAt))
        .all();

  return c.json(rows.map((r: any) => ({ ...r, postId: targetId, likes: r.likes ?? 0 })));
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

  // Only cache the default first page (no cursor/filters) — it's the hot path.
  const cacheable = !cursor && !category && !q;
  const cacheKey = `cache:blog:list:${limit}`;
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
  if (cacheable) await cachePut(c.env, cacheKey, payload, 30);
  return c.json(payload);
});

// Distinct categories with post counts — for the blog filter UI.
readRoute.get("/blog/categories", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ category: schema.blogPosts.category, count: sql<number>`count(*)` })
    .from(schema.blogPosts)
    .where(and(eq(schema.blogPosts.status, "published"), sql`${schema.blogPosts.category} IS NOT NULL`))
    .groupBy(schema.blogPosts.category)
    .orderBy(desc(sql`count(*)`))
    .all();
  return c.json(rows.filter((r) => r.category));
});

// Single post by slug (falls back to id). Increments view count fire-and-forget.
readRoute.get("/blog/:slug", async (c) => {
  const db = getDb(c.env);
  const key = c.req.param("slug");
  let row = await db.select().from(schema.blogPosts).where(eq(schema.blogPosts.slug, key)).get();
  if (!row) row = await db.select().from(schema.blogPosts).where(eq(schema.blogPosts.id, key)).get();
  if (!row || row.status !== "published") return c.json(null);
  // Best-effort view counter (don't block the response on it).
  db.update(schema.blogPosts)
    .set({ viewCount: sql`${schema.blogPosts.viewCount} + 1` })
    .where(eq(schema.blogPosts.id, row.id))
    .run()
    .catch(() => {});
  return c.json(mapBlogPost(row, { withContent: true }));
});
