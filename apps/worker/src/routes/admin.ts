/**
 * /admin — admin CRUD that used to live in the admin panel's Next.js API routes
 * (which talked directly to Firestore via the Firebase Admin SDK). Now backed
 * by D1.
 *
 * Auth: either a valid Firebase admin ID token OR the shared server-to-server
 * secret (X-Admin-Secret) used by the Next.js routes when proxying. This lets
 * the admin panel keep its existing route URLs while the data moves to D1.
 */
import { Hono } from "hono";
import { and, eq, desc, sql, count, ne, like } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "../lib/http";
import { verifyIdToken, bearerToken } from "../lib/firebaseAuth";
import { isAdmin } from "../middleware/auth";
import { getAppConfig, getGamificationSettings, invalidateSetting } from "../lib/settings";
import { deleteAuthUser, updateAuthUser, setCustomClaims, getUserByEmail } from "../lib/firebaseAdmin";
import { createNotification } from "../lib/notify";
import { newId, now } from "../lib/ids";

export const adminRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

// Gate: shared secret (server-to-server) OR admin Firebase token.
adminRoute.use("*", async (c, next) => {
  const secret = c.req.header("X-Admin-Secret");
  if (secret && c.env.ADMIN_PROXY_SECRET && secret === c.env.ADMIN_PROXY_SECRET) {
    return next();
  }
  const token = bearerToken(c.req.header("Authorization"));
  if (token) {
    try {
      c.set("user", await verifyIdToken(token, c.env));
      if (await isAdmin(c as any)) return next();
    } catch {
      /* fall through */
    }
  }
  throw httpsError("permission-denied", "Admin access required.");
});

// ---- app settings (settings/appConfig) ----
adminRoute.get("/app-settings", async (c) => c.json((await getAppConfig(c.env)) || {}));
adminRoute.post("/app-settings", async (c) => {
  const db = getDb(c.env);
  const body = await c.req.json<any>();
  const existing = (await getAppConfig(c.env)) || {};
  const merged = { ...existing, ...body };
  await db
    .insert(schema.settings)
    .values({ id: "appConfig", data: merged, updatedAt: now() })
    .onConflictDoUpdate({ target: schema.settings.id, set: { data: merged, updatedAt: now() } });
  await invalidateSetting(c.env, "appConfig");
  return c.json({ message: "Settings updated successfully" });
});

// ---- rewards (settings/gamification) ----
adminRoute.get("/rewards", async (c) => c.json((await getGamificationSettings(c.env)) || {}));
adminRoute.post("/rewards", async (c) => {
  const db = getDb(c.env);
  const body = await c.req.json<any>();
  const existing = (await getGamificationSettings(c.env)) || {};
  const merged = { ...existing, ...body };
  await db
    .insert(schema.settings)
    .values({ id: "gamification", data: merged, updatedAt: now() })
    .onConflictDoUpdate({ target: schema.settings.id, set: { data: merged, updatedAt: now() } });
  await invalidateSetting(c.env, "gamification");
  return c.json({ success: true });
});

// ---- contests ----
adminRoute.delete("/contests/:id", async (c) => {
  const db = getDb(c.env);
  await db.delete(schema.contests).where(eq(schema.contests.id, c.req.param("id")));
  return c.json({ message: "Contest deleted successfully" });
});

// ---- posts ----
adminRoute.delete("/posts/:id", async (c) => {
  const db = getDb(c.env);
  await db.delete(schema.posts).where(eq(schema.posts.id, c.req.param("id")));
  return c.json({ message: "Post deleted" });
});
adminRoute.patch("/posts/:id", async (c) => {
  const db = getDb(c.env);
  const { isHidden } = await c.req.json<any>();
  await db.update(schema.posts).set({ isHidden: !!isHidden }).where(eq(schema.posts.id, c.req.param("id")));
  return c.json({ message: `Post ${isHidden ? "hidden" : "shown"}` });
});

// ---- stories ----
adminRoute.delete("/stories/:id", async (c) => {
  const db = getDb(c.env);
  await db.delete(schema.stories).where(eq(schema.stories.id, c.req.param("id")));
  return c.json({ message: "Story deleted" });
});
adminRoute.patch("/stories/:id", async (c) => {
  // stories table has no isHidden column; deletion is the moderation action.
  return c.json({ message: "Stories support delete only" });
});

// ---- reports ----
adminRoute.get("/reports", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.reports).orderBy(desc(schema.reports.createdAt)).limit(100).all();
  return c.json(rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() })));
});
adminRoute.delete("/reports", async (c) => {
  const db = getDb(c.env);
  const id = c.req.query("id");
  if (id) await db.delete(schema.reports).where(eq(schema.reports.id, id));
  return c.json({ message: "Report deleted" });
});

// ---- support tickets ----
adminRoute.get("/support", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.supportTickets).orderBy(desc(schema.supportTickets.createdAt)).limit(100).all();
  return c.json(rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString(), updatedAt: new Date(r.updatedAt).toISOString() })));
});
adminRoute.patch("/support", async (c) => {
  const db = getDb(c.env);
  const { id, status, adminReply } = await c.req.json<any>();
  if (!id) throw httpsError("invalid-argument", "ID required");
  await db.update(schema.supportTickets).set({ status: status || "resolved", adminReply: adminReply || "", updatedAt: now() }).where(eq(schema.supportTickets.id, id));
  return c.json({ message: "Ticket updated" });
});
adminRoute.delete("/support", async (c) => {
  const db = getDb(c.env);
  const id = c.req.query("id");
  if (id) await db.delete(schema.supportTickets).where(eq(schema.supportTickets.id, id));
  return c.json({ message: "Ticket deleted" });
});

// ---- users ----
adminRoute.delete("/users/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  await db.delete(schema.users).where(eq(schema.users.uid, id));
  await deleteAuthUser(c.env, id).catch((e) => console.error("Auth delete failed", e));
  return c.json({ message: "User deleted successfully" });
});
adminRoute.patch("/users/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const { isBlocked } = await c.req.json<any>();
  await db.update(schema.users).set({ isBlocked: !!isBlocked, status: isBlocked ? "blocked" : "active", updatedAt: now() }).where(eq(schema.users.uid, id));
  await updateAuthUser(c.env, id, { disabled: !!isBlocked }).catch((e) => console.warn("Auth update failed", e));
  return c.json({ message: `User ${isBlocked ? "blocked" : "unblocked"} successfully`, status: isBlocked });
});

// ---- wallet (was adminManageWallet Cloud Function) ----
adminRoute.post("/users/:id/wallet", async (c) => {
  const db = getDb(c.env);
  const userId = c.req.param("id");
  const { amount, type } = await c.req.json<any>();
  if (typeof amount !== "number" || !["add", "subtract"].includes(type)) {
    throw httpsError("invalid-argument", "Invalid request parameters.");
  }
  const delta = type === "add" ? amount : -amount;
  const upd = await db
    .update(schema.users)
    .set({ dpcoin: sql`MAX(${schema.users.dpcoin} + ${delta}, 0)`, updatedAt: now() })
    .where(eq(schema.users.uid, userId))
    .run();
  if (upd.meta.changes === 0) throw httpsError("not-found", "User not found.");
  await db.insert(schema.coinTransactions).values({
    id: crypto.randomUUID(),
    uid: userId,
    amount: delta,
    type: "admin_adjustment",
    description: `Admin ${type} ${amount} Dpcoin`,
    createdAt: now(),
  });
  const user = await db.select({ balance: schema.users.dpcoin }).from(schema.users).where(eq(schema.users.uid, userId)).get();
  return c.json({ message: "Wallet updated successfully", newBalance: user?.balance ?? 0 });
});


// ======================= BLOG =======================
/** URL-safe slug from a title (keeps unicode letters, e.g. Hindi). */
function slugify(input: string): string {
  return (input || "")
    .toString()
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-") // non letters/numbers -> hyphen
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "post";
}

/** Ensure the slug is unique in blog_posts (ignoring an optional current id). */
async function uniqueBlogSlug(db: any, base: string, ignoreId?: string): Promise<string> {
  let slug = base;
  for (let i = 2; i < 500; i++) {
    const existing = await db
      .select({ id: schema.blogPosts.id })
      .from(schema.blogPosts)
      .where(eq(schema.blogPosts.slug, slug))
      .get();
    if (!existing || existing.id === ignoreId) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now()}`;
}

// List posts (any status) for the admin table. Optional ?q= title search.
adminRoute.get("/blog", async (c) => {
  const db = getDb(c.env);
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 200);
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const conds: any[] = [];
  if (q.length >= 2) conds.push(like(sql`lower(${schema.blogPosts.title})`, `%${q}%`));
  const rows = await db
    .select({
      id: schema.blogPosts.id,
      slug: schema.blogPosts.slug,
      title: schema.blogPosts.title,
      excerpt: schema.blogPosts.excerpt,
      coverImageUrl: schema.blogPosts.coverImageUrl,
      category: schema.blogPosts.category,
      author: schema.blogPosts.author,
      status: schema.blogPosts.status,
      source: schema.blogPosts.source,
      viewCount: schema.blogPosts.viewCount,
      publishedAt: schema.blogPosts.publishedAt,
      createdAt: schema.blogPosts.createdAt,
    })
    .from(schema.blogPosts)
    .where(conds.length ? and(...conds) : (undefined as any))
    .orderBy(desc(schema.blogPosts.publishedAt))
    .limit(limit)
    .all();
  return c.json(rows);
});

// Blog stats for dashboards / list header.
adminRoute.get("/blog/stats", async (c) => {
  const db = getDb(c.env);
  const total = (await db.select({ v: count() }).from(schema.blogPosts).get())?.v ?? 0;
  const published =
    (await db.select({ v: count() }).from(schema.blogPosts).where(eq(schema.blogPosts.status, "published")).get())?.v ?? 0;
  const imported =
    (await db.select({ v: count() }).from(schema.blogPosts).where(eq(schema.blogPosts.source, "archive")).get())?.v ?? 0;
  return c.json({ total, published, drafts: total - published, imported });
});

// Bulk upsert used by the Wayback archive importer. Body: { posts: [...] }.
// Dedups by originalUrl (preferred) or slug so re-running the import is safe.
adminRoute.post("/blog/import", async (c) => {
  const db = getDb(c.env);
  const body = await c.req.json<any>();
  const posts: any[] = Array.isArray(body) ? body : body.posts || [];
  if (!Array.isArray(posts) || posts.length === 0) {
    throw httpsError("invalid-argument", "Body must be { posts: [...] } with at least one post.");
  }
  let created = 0,
    updated = 0,
    skipped = 0;
  for (const p of posts) {
    if (!p || !p.title) {
      skipped++;
      continue;
    }
    // Find an existing row by originalUrl first, then by slug.
    let existing: any = null;
    if (p.originalUrl) {
      existing = await db
        .select({ id: schema.blogPosts.id })
        .from(schema.blogPosts)
        .where(eq(schema.blogPosts.originalUrl, p.originalUrl))
        .get();
    }
    const baseSlug = slugify(p.slug || p.title);
    if (!existing) {
      existing = await db
        .select({ id: schema.blogPosts.id })
        .from(schema.blogPosts)
        .where(eq(schema.blogPosts.slug, baseSlug))
        .get();
    }

    const ts = now();
    const values = {
      title: String(p.title).slice(0, 500),
      excerpt: p.excerpt ? String(p.excerpt).slice(0, 500) : null,
      content: p.content || null,
      coverImageUrl: p.coverImageUrl || null,
      category: p.category || null,
      tags: Array.isArray(p.tags) ? p.tags : [],
      author: p.author || "TopHunt",
      status: p.status || "published",
      source: "archive",
      originalUrl: p.originalUrl || null,
      publishedAt: typeof p.publishedAt === "number" ? p.publishedAt : ts,
      updatedAt: ts,
    };

    if (existing) {
      await db.update(schema.blogPosts).set(values).where(eq(schema.blogPosts.id, existing.id));
      updated++;
    } else {
      const slug = await uniqueBlogSlug(db, baseSlug);
      await db.insert(schema.blogPosts).values({ id: newId(), slug, createdAt: ts, viewCount: 0, ...values });
      created++;
    }
  }
  return c.json({ success: true, created, updated, skipped, received: posts.length });
});

// Create a single post (admin panel form).
adminRoute.post("/blog", async (c) => {
  const db = getDb(c.env);
  const b = await c.req.json<any>();
  if (!b.title) throw httpsError("invalid-argument", "Title is required.");
  const ts = now();
  const slug = await uniqueBlogSlug(db, slugify(b.slug || b.title));
  const id = newId();
  await db.insert(schema.blogPosts).values({
    id,
    slug,
    title: String(b.title).slice(0, 500),
    excerpt: b.excerpt || null,
    content: b.content || null,
    coverImageUrl: b.coverImageUrl || null,
    category: b.category || null,
    tags: Array.isArray(b.tags) ? b.tags : [],
    author: b.author || "TopHunt",
    status: b.status || "published",
    source: "admin",
    originalUrl: null,
    viewCount: 0,
    publishedAt: typeof b.publishedAt === "number" ? b.publishedAt : ts,
    createdAt: ts,
    updatedAt: ts,
  });
  return c.json({ success: true, id, slug });
});

// Read a single post (with content) for the edit form.
adminRoute.get("/blog/:id", async (c) => {
  const db = getDb(c.env);
  const row = await db.select().from(schema.blogPosts).where(eq(schema.blogPosts.id, c.req.param("id"))).get();
  return c.json(row || null);
});

// Update a post.
adminRoute.patch("/blog/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const b = await c.req.json<any>();
  const current = await db.select().from(schema.blogPosts).where(eq(schema.blogPosts.id, id)).get();
  if (!current) throw httpsError("not-found", "Post not found.");
  const set: any = { updatedAt: now() };
  if (b.title !== undefined) set.title = String(b.title).slice(0, 500);
  if (b.excerpt !== undefined) set.excerpt = b.excerpt;
  if (b.content !== undefined) set.content = b.content;
  if (b.coverImageUrl !== undefined) set.coverImageUrl = b.coverImageUrl;
  if (b.category !== undefined) set.category = b.category;
  if (b.tags !== undefined) set.tags = Array.isArray(b.tags) ? b.tags : [];
  if (b.author !== undefined) set.author = b.author;
  if (b.status !== undefined) set.status = b.status;
  if (typeof b.publishedAt === "number") set.publishedAt = b.publishedAt;
  // Regenerate slug only when explicitly requested.
  if (b.slug !== undefined && b.slug) set.slug = await uniqueBlogSlug(db, slugify(b.slug), id);
  await db.update(schema.blogPosts).set(set).where(eq(schema.blogPosts.id, id));
  return c.json({ message: "Post updated", id });
});

// Delete a post.
adminRoute.delete("/blog/:id", async (c) => {
  const db = getDb(c.env);
  await db.delete(schema.blogPosts).where(eq(schema.blogPosts.id, c.req.param("id")));
  return c.json({ message: "Post deleted" });
});

// ======================= DASHBOARD =======================
adminRoute.get("/overview", async (c) => {
  const db = getDb(c.env);
  const users = (await db.select({ v: count() }).from(schema.users).get())?.v ?? 0;
  const posts = (await db.select({ v: count() }).from(schema.posts).get())?.v ?? 0;
  const reports = (await db.select({ v: count() }).from(schema.reports).get())?.v ?? 0;
  const support =
    (await db.select({ v: count() }).from(schema.supportTickets).where(ne(schema.supportTickets.status, "resolved")).get())?.v ?? 0;
  return c.json({ users, posts, reports, support });
});

adminRoute.get("/device-stats", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select({ platform: schema.users.platform }).from(schema.users).limit(1000).all();
  let web = 0, mobile = 0, other = 0;
  for (const r of rows) {
    const p = (r.platform || "").toLowerCase();
    if (p === "web") web++;
    else if (p === "android" || p === "ios") mobile++;
    else other++;
  }
  return c.json({ web, mobile, other });
});

adminRoute.get("/user-growth", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select({ createdAt: schema.users.createdAt }).from(schema.users).orderBy(desc(schema.users.createdAt)).limit(1000).all();
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const currentMonth = new Date().getMonth();
  const order: string[] = [];
  const map: Record<string, number> = {};
  for (let i = 6; i >= 0; i--) {
    const m = (currentMonth - i + 12) % 12;
    order.push(months[m]);
    map[months[m]] = 0;
  }
  for (const r of rows) {
    if (!r.createdAt) continue;
    const name = months[new Date(r.createdAt).getMonth()];
    if (map[name] !== undefined) map[name]++;
  }
  return c.json({ categories: order, data: order.map((m) => map[m]) });
});

adminRoute.get("/recent-tickets", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.supportTickets).orderBy(desc(schema.supportTickets.createdAt)).limit(5).all();
  return c.json(rows.map((t) => ({ ...t, createdAt: new Date(t.createdAt).toISOString() })));
});

// ======================= TABLES =======================
function adminUser(u: any) {
  return {
    id: u.uid,
    ...u,
    Dpcoin: u.dpcoin ?? 0,
    level: u.level ?? 0,
    createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : null,
    stats: {
      postsCount: u.postsCount ?? 0,
      followersCount: u.followersCount ?? 0,
      followingCount: u.followingCount ?? 0,
      contestsJoined: u.contestsJoined ?? 0,
      wins: u.wins ?? 0,
      totalVotesReceived: u.totalVotesReceived ?? 0,
    },
  };
}
const iso = (r: any) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null });

adminRoute.get("/users", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.users).limit(100).all();
  return c.json(rows.map(adminUser));
});

adminRoute.get("/users/:id/posts", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.posts).where(eq(schema.posts.userId, c.req.param("id"))).all();
  return c.json(rows.map(iso));
});

adminRoute.get("/users/:id/stories", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.stories).where(eq(schema.stories.userId, c.req.param("id"))).all();
  return c.json(rows.map(iso));
});

adminRoute.get("/users/:id", async (c) => {
  const db = getDb(c.env);
  const u = await db.select().from(schema.users).where(eq(schema.users.uid, c.req.param("id"))).get();
  return c.json(u ? adminUser(u) : null);
});

adminRoute.get("/posts", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.posts).orderBy(desc(schema.posts.createdAt)).limit(100).all();
  return c.json(rows.map(iso));
});

adminRoute.get("/stories", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.stories).orderBy(desc(schema.stories.createdAt)).limit(100).all();
  return c.json(rows.map(iso));
});

adminRoute.get("/contests", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.contests).orderBy(desc(schema.contests.createdAt)).all();
  return c.json(
    rows.map((r) => ({
      id: r.id,
      ...(r.extra as any || {}),
      name: r.title,
      type: r.type,
      status: r.status,
      entryFishCoins: r.totalEntryFee,
      prizePool: r.rewardCoins,
      minVotes: r.minVotes,
      createdAt: r.createdAt,
      // voteDurationDays used to derive an end date for the list UI
      endDate: r.createdAt ? r.createdAt + (r.voteDurationDays || 1) * 86400000 : null,
    })),
  );
});

// ======================= ADMIN NOTIFICATIONS =======================
adminRoute.get("/notifications", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.adminNotifications).orderBy(desc(schema.adminNotifications.createdAt)).limit(10).all();
  return c.json(rows.map((n) => ({ ...n, isRead: !!n.isRead })));
});

adminRoute.post("/notifications/read", async (c) => {
  const db = getDb(c.env);
  await db.update(schema.adminNotifications).set({ isRead: true }).where(eq(schema.adminNotifications.isRead, false));
  return c.json({ success: true });
});


// ======================= OPS (used by admin CLI scripts) =======================
// Make/unmake a user admin: sets the Firebase custom claim (Identity Toolkit)
// AND the D1 users.role, keyed by email or uid.
adminRoute.post("/set-role", async (c) => {
  const db = getDb(c.env);
  const { email, userId, makeAdmin } = await c.req.json<any>();
  let uid = userId as string | undefined;
  if (!uid && email) {
    uid = (await getUserByEmail(c.env, email)) || undefined;
  }
  if (!uid) throw httpsError("not-found", "User not found (provide a valid email or userId).");
  const role = makeAdmin === false ? "user" : "admin";
  await setCustomClaims(c.env, uid, { role });
  await db.update(schema.users).set({ role, updatedAt: now() }).where(eq(schema.users.uid, uid));
  return c.json({ success: true, uid, role });
});

// Create a contest template (used by seed-contests).
adminRoute.post("/contests", async (c) => {
  const db = getDb(c.env);
  const b = await c.req.json<any>();
  const id = newId();
  await db.insert(schema.contests).values({
    id,
    title: b.title || b.name || null,
    type: b.type || "photo",
    status: b.status || "live",
    totalEntryFee: Number(b.totalEntryFee ?? b.entryFishCoins ?? 0),
    rewardCoins: Number(b.rewardCoins ?? b.prizePool ?? 0),
    voteDurationDays: Number(b.voteDurationDays ?? (b.durationHours ? Math.ceil(b.durationHours / 24) : 1)),
    autoCancelHours: Number(b.autoCancelHours ?? 24),
    minVotes: Number(b.minVotes ?? 0),
    extra: b,
    createdBy: "admin-script",
    createdAt: now(),
  });
  return c.json({ success: true, contestId: id });
});

// Send a notification to a user (used by test-notification).
adminRoute.post("/notify", async (c) => {
  const { userId, title, body, type } = await c.req.json<any>();
  if (!userId) throw httpsError("invalid-argument", "userId is required.");
  await createNotification(c.env, userId, {
    title: title || "Test Notification",
    body: body || "Hello from the Worker.",
    type: type || "system",
    targetId: "admin-test",
  });
  return c.json({ success: true });
});
