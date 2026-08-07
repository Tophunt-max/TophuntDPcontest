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
import { and, eq, desc, sql, count, ne } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "../lib/http";
import { verifyIdToken, bearerToken } from "../lib/firebaseAuth";
import { isAdmin } from "../middleware/auth";
import { getAppConfig, getGamificationSettings, invalidateSetting } from "../lib/settings";
import { deleteAuthUser, updateAuthUser } from "../lib/firebaseAdmin";
import { now } from "../lib/ids";

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
