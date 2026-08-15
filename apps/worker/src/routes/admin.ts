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
import { and, eq, desc, sql, count, ne, like, gte, inArray } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "../lib/http";
import { verifyIdToken, bearerToken } from "../lib/firebaseAuth";
import { getAppConfig, getGamificationSettings, invalidateSetting } from "../lib/settings";
import { deleteAuthUser, updateAuthUser, setCustomClaims, getUserByEmail } from "../lib/firebaseAdmin";
import { createNotification, sendBroadcastToAllUsers, sendSegmentedBroadcast } from "../lib/notify";
import { finalizeVotes } from "../lib/voteCounter";
import { resolveContests, monthlyHallOfFame } from "../cron";
import { newId, now } from "../lib/ids";
import { discoverUrls, processBatch } from "../lib/importerTask";

/**
 * Record a sensitive admin action in the audit trail. Best-effort — never
 * throws (a failed audit write must not break the action itself). The acting
 * admin identity comes from the verified Firebase token when present; requests
 * that use the shared server secret are recorded as "server".
 */
async function logAudit(
  c: any,
  action: string,
  targetType: string,
  targetId: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    const db = getDb(c.env);
    const user = c.get("user");
    await db.insert(schema.adminAuditLog).values({
      id: newId(),
      adminUid: user?.uid ?? null,
      adminEmail: user?.email ?? (user ? null : "server"),
      action,
      targetType,
      targetId: targetId ?? null,
      detail: detail ?? null,
      createdAt: now(),
    });
  } catch (e) {
    console.error("[audit] failed to record", action, e);
  }
}

export const adminRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

// Roles allowed through the /admin gate. "moderator" is limited (content
// moderation only) and is blocked from money/user-lifecycle actions by
// requireFullAdmin below.
const ADMIN_ROLES = ["superadmin", "admin", "moderator"];

/** Resolve the caller's effective admin role from claim or the D1 users row. */
async function resolveAdminRole(c: any): Promise<string | null> {
  const user = c.get("user");
  if (!user?.uid) return null;
  if (user.role && ADMIN_ROLES.includes(user.role)) return user.role;
  const db = getDb(c.env);
  const row = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.uid, user.uid)).get();
  return row?.role && ADMIN_ROLES.includes(row.role) ? row.role : null;
}

// Gate: shared secret (server-to-server, treated as superadmin) OR an admin/
// moderator Firebase token.
adminRoute.use("*", async (c, next) => {
  const secret = c.req.header("X-Admin-Secret");
  if (secret && c.env.ADMIN_PROXY_SECRET && secret === c.env.ADMIN_PROXY_SECRET) {
    c.set("adminRole", "superadmin");
    return next();
  }
  const token = bearerToken(c.req.header("Authorization"));
  if (token) {
    try {
      c.set("user", await verifyIdToken(token, c.env));
      const role = await resolveAdminRole(c);
      if (role) {
        c.set("adminRole", role);
        return next();
      }
    } catch {
      /* fall through */
    }
  }
  throw httpsError("permission-denied", "Admin access required.");
});

/** Block moderators from privileged (money / user-lifecycle / config) actions. */
function requireFullAdmin(c: any): void {
  if (c.get("adminRole") === "moderator") {
    throw httpsError("permission-denied", "This action requires full admin access.");
  }
}

// ---- app settings (settings/appConfig) ----
adminRoute.get("/app-settings", async (c) => c.json((await getAppConfig(c.env)) || {}));
adminRoute.post("/app-settings", async (c) => {
  requireFullAdmin(c);
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
  requireFullAdmin(c);
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
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  await db.delete(schema.contests).where(eq(schema.contests.id, id));
  await logAudit(c, "contest.delete", "contest", id);
  return c.json({ message: "Contest deleted successfully" });
});

// Update a contest template.
adminRoute.patch("/contests/:id", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const b = await c.req.json<any>();
  const current = await db.select().from(schema.contests).where(eq(schema.contests.id, id)).get();
  if (!current) throw httpsError("not-found", "Contest not found.");
  const set: any = {};
  if (b.title !== undefined || b.name !== undefined) set.title = b.title ?? b.name;
  if (b.type !== undefined) set.type = b.type;
  if (b.status !== undefined) set.status = b.status;
  if (b.totalEntryFee !== undefined || b.entryFishCoins !== undefined)
    set.totalEntryFee = Number(b.totalEntryFee ?? b.entryFishCoins);
  if (b.rewardCoins !== undefined || b.prizePool !== undefined)
    set.rewardCoins = Number(b.rewardCoins ?? b.prizePool);
  if (b.voteDurationDays !== undefined) set.voteDurationDays = Number(b.voteDurationDays);
  if (b.autoCancelHours !== undefined) set.autoCancelHours = Number(b.autoCancelHours);
  if (b.minVotes !== undefined) set.minVotes = Number(b.minVotes);
  await db.update(schema.contests).set(set).where(eq(schema.contests.id, id));
  await logAudit(c, "contest.update", "contest", id, set);
  return c.json({ message: "Contest updated", id });
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
  requireFullAdmin(c);
  const id = c.req.param("id");
  await db.delete(schema.users).where(eq(schema.users.uid, id));
  await deleteAuthUser(c.env, id).catch((e) => console.error("Auth delete failed", e));
  await logAudit(c, "user.delete", "user", id);
  return c.json({ message: "User deleted successfully" });
});
adminRoute.patch("/users/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const { isBlocked } = await c.req.json<any>();
  await db.update(schema.users).set({ isBlocked: !!isBlocked, status: isBlocked ? "blocked" : "active", updatedAt: now() }).where(eq(schema.users.uid, id));
  await updateAuthUser(c.env, id, { disabled: !!isBlocked }).catch((e) => console.warn("Auth update failed", e));
  await logAudit(c, isBlocked ? "user.block" : "user.unblock", "user", id);
  return c.json({ message: `User ${isBlocked ? "blocked" : "unblocked"} successfully`, status: isBlocked });
});

// ---- wallet (was adminManageWallet Cloud Function) ----
adminRoute.post("/users/:id/wallet", async (c) => {
  requireFullAdmin(c);
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
  await logAudit(c, "wallet.adjust", "user", userId, { amount: delta, type });
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

const PROGRESS_KEY = "blog:import:progress";

/** sha256 hex of a string (used for content-hash dedup + image keys). */
async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const IMG_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};

/**
 * Fetch a single (Wayback-hosted) TopHunt image and store the ORIGINAL bytes in
 * R2, returning the permanent public R2 URL. De-duplicated by content hash so
 * the same image is never uploaded twice. Only image content-types are stored.
 */
adminRoute.post("/media/fetch-to-r2", async (c) => {
  const { url, folder } = await c.req.json<any>();
  if (!url || typeof url !== "string") throw httpsError("invalid-argument", "url is required.");
  const baseFolder = (folder || "blog/imported").replace(/[^a-z0-9/_-]/gi, "");

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "TopHuntArchiveImporter/1.0 (+https://tophunt.in)" },
      redirect: "follow",
    });
  } catch (e: any) {
    throw httpsError("internal", `Failed to fetch image: ${e.message}`);
  }
  if (!res.ok) throw httpsError("not-found", `Image fetch returned ${res.status}`);

  const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ct.startsWith("image/")) throw httpsError("invalid-argument", `Not an image (content-type: ${ct || "unknown"}).`);

  const buf = await res.arrayBuffer();
  if (buf.byteLength < 100) throw httpsError("invalid-argument", "Image too small / empty.");

  const hash = await sha256Hex(buf);
  const ext = IMG_EXT[ct] || ".img";
  const key = `${baseFolder}/${hash}${ext}`;
  const publicUrl = `${c.env.R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`;

  // Skip re-upload if we already have this exact image.
  const existing = await c.env.MEDIA.head(key);
  if (!existing) {
    await c.env.MEDIA.put(key, buf, { httpMetadata: { contentType: ct } });
  }
  return c.json({ url: publicUrl, hash, key, cached: !!existing, bytes: buf.byteLength });
});

/**
 * Bulk upsert used by the Wayback archive importer. Body: { posts: [...] }.
 * Each write (post + its import-log row) is committed atomically via db.batch.
 * De-duplicates by canonical originalUrl first, then by content hash (a
 * different URL with identical content is recorded as a duplicate and skipped).
 * publishedAt is stored ONLY when the importer determined it confidently.
 */
adminRoute.post("/blog/import", async (c) => {
  const db = getDb(c.env);
  const body = await c.req.json<any>();
  const posts: any[] = Array.isArray(body) ? body : body.posts || [];
  if (!Array.isArray(posts) || posts.length === 0) {
    throw httpsError("invalid-argument", "Body must be { posts: [...] } with at least one post.");
  }
  let created = 0,
    updated = 0,
    skipped = 0,
    duplicates = 0;

  const logRow = (url: string, status: string, extra: any = {}) => {
    const ts = now();
    return db
      .insert(schema.blogImportLog)
      .values({
        id: newId(),
        url,
        status,
        error: extra.error || null,
        postId: extra.postId || null,
        imagesTotal: extra.imagesTotal ?? 0,
        imagesMissing: extra.imagesMissing ?? 0,
        attempts: 1,
        createdAt: ts,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: schema.blogImportLog.url,
        set: {
          status,
          error: extra.error || null,
          postId: extra.postId || null,
          imagesTotal: extra.imagesTotal ?? 0,
          imagesMissing: extra.imagesMissing ?? 0,
          attempts: sql`${schema.blogImportLog.attempts} + 1`,
          updatedAt: ts,
        },
      });
  };

  for (const p of posts) {
    const canonical = (p?.originalUrl || p?.canonicalUrl || "").trim();
    // Validate: must have title + non-trivial content.
    if (!p || !p.title || !p.content || String(p.content).trim().length < 40) {
      skipped++;
      if (canonical) await logRow(canonical, "skipped", { error: "empty or invalid page" }).run();
      continue;
    }

    // Dedup by canonical URL.
    let existing: any = null;
    if (canonical) {
      existing = await db
        .select({ id: schema.blogPosts.id })
        .from(schema.blogPosts)
        .where(eq(schema.blogPosts.originalUrl, canonical))
        .get();
    }
    // Dedup by content hash (a different URL with identical content).
    if (!existing && p.contentHash) {
      const dup = await db
        .select({ id: schema.blogPosts.id, originalUrl: schema.blogPosts.originalUrl })
        .from(schema.blogPosts)
        .where(eq(schema.blogPosts.contentHash, p.contentHash))
        .get();
      if (dup && dup.originalUrl !== canonical) {
        duplicates++;
        if (canonical) await logRow(canonical, "duplicate", { postId: dup.id }).run();
        continue;
      }
    }

    const ts = now();
    const title = String(p.title).slice(0, 500);
    const excerpt = p.excerpt ? String(p.excerpt).slice(0, 500) : null;
    // SEO must never be missing.
    const metaTitle = (p.metaTitle || title).slice(0, 160);
    const metaDescription = (p.metaDescription || excerpt || String(p.content).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 155)).slice(0, 300);
    const values = {
      title,
      excerpt,
      content: p.content,
      coverImageUrl: p.coverImageUrl || null,
      category: p.category || null,
      tags: Array.isArray(p.tags) ? p.tags : [],
      author: p.author || "TopHunt",
      status: p.status || "published",
      metaTitle,
      metaDescription,
      canonicalUrl: canonical || null,
      source: "archive",
      originalUrl: canonical || null,
      contentHash: p.contentHash || null,
      publishedAt: typeof p.publishedAt === "number" ? p.publishedAt : null,
      updatedAt: ts,
    };
    const logExtra = { imagesTotal: p.imagesTotal ?? 0, imagesMissing: p.imagesMissing ?? 0 };

    if (existing) {
      await db.batch([
        db.update(schema.blogPosts).set(values).where(eq(schema.blogPosts.id, existing.id)),
        logRow(canonical, "updated", { postId: existing.id, ...logExtra }),
      ]);
      updated++;
    } else {
      const id = newId();
      const slug = await uniqueBlogSlug(db, slugify(p.slug || title));
      await db.batch([
        db.insert(schema.blogPosts).values({ id, slug, createdAt: ts, viewCount: 0, ...values }),
        logRow(canonical, "imported", { postId: id, ...logExtra }),
      ]);
      created++;
    }
  }
  return c.json({ success: true, created, updated, skipped, duplicates, received: posts.length });
});

// ---- Import job progress (fed by the importer, read by the dashboard) ----
adminRoute.post("/blog/import/progress", async (c) => {
  const body = await c.req.json<any>();
  await c.env.CACHE_KV.put(PROGRESS_KEY, JSON.stringify({ ...body, updatedAt: now() }), {
    expirationTtl: 86400,
  });
  return c.json({ ok: true });
});

adminRoute.get("/blog/import/progress", async (c) => {
  const raw = await c.env.CACHE_KV.get(PROGRESS_KEY, "json");
  return c.json(raw || null);
});

// URLs already handled (so the importer can resume and skip them).
adminRoute.get("/blog/import/done-urls", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ url: schema.blogImportLog.url })
    .from(schema.blogImportLog)
    .where(sql`${schema.blogImportLog.status} IN ('imported','updated','duplicate','skipped')`)
    .all();
  return c.json({ urls: rows.map((r) => r.url) });
});

// Import log rows (optionally filtered by ?status=).
adminRoute.get("/blog/import/log", async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status");
  const limit = Math.min(parseInt(c.req.query("limit") || "200", 10), 1000);
  const conds: any[] = [];
  if (status) conds.push(eq(schema.blogImportLog.status, status));
  const rows = await db
    .select()
    .from(schema.blogImportLog)
    .where(conds.length ? and(...conds) : (undefined as any))
    .orderBy(desc(schema.blogImportLog.updatedAt))
    .limit(limit)
    .all();
  return c.json(rows);
});

// Import-log breakdown by status (dashboard counters).
adminRoute.get("/blog/import/summary", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ status: schema.blogImportLog.status, n: count() })
    .from(schema.blogImportLog)
    .groupBy(schema.blogImportLog.status)
    .all();
  const byStatus: Record<string, number> = {};
  let missingImages = 0;
  for (const r of rows) byStatus[r.status] = r.n;
  const mi = await db.select({ v: sql<number>`COALESCE(SUM(${schema.blogImportLog.imagesMissing}),0)` }).from(schema.blogImportLog).get();
  missingImages = mi?.v ?? 0;
  return c.json({ byStatus, missingImages });
});

// Mark rows of a certain status as pending so the next importer run retries them.
adminRoute.post("/blog/import/retry", async (c) => {
  const db = getDb(c.env);
  const { status } = await c.req.json<{status: string}>();
  if (!status) {
    throw httpsError("invalid-argument", "Status is required");
  }
  const res = await db
    .update(schema.blogImportLog)
    .set({ status: "pending", updatedAt: now() })
    .where(eq(schema.blogImportLog.status, status))
    .run();
  return c.json({ ok: true, requeued: (res as any)?.meta?.changes ?? undefined });
});

adminRoute.post("/blog/import/discover", async (c) => {
  const { type } = await c.req.json<any>();
  if (type !== "fresh" && type !== "resume" && !["failed", "skipped", "duplicate", "updated"].includes(type)) {
    throw httpsError("invalid-argument", "Invalid mode");
  }
  const urls = await discoverUrls(c.env, type);
  return c.json({ urls });
});

adminRoute.post("/blog/import/process-batch", async (c) => {
  const { urls, state } = await c.req.json<any>();
  if (!Array.isArray(urls)) throw httpsError("invalid-argument", "urls must be an array");
  const newState = await processBatch(c.env, urls, state);
  return c.json({ state: newState });
});

adminRoute.post("/blog/import/finish", async (c) => {
  const { state } = await c.req.json<any>();
  if (state) {
    state.done = true;
    await c.env.CACHE_KV.put(PROGRESS_KEY, JSON.stringify({ ...state, updatedAt: now() }), { expirationTtl: 86400 });
  }
  return c.json({ ok: true });
});

// Record a failed URL (importer reports parse/network failures here).
adminRoute.post("/blog/import/fail", async (c) => {
  const db = getDb(c.env);
  const { url, error } = await c.req.json<any>();
  if (!url) throw httpsError("invalid-argument", "url is required.");
  const ts = now();
  await db
    .insert(schema.blogImportLog)
    .values({ id: newId(), url, status: "failed", error: (error || "").slice(0, 500), attempts: 1, createdAt: ts, updatedAt: ts })
    .onConflictDoUpdate({
      target: schema.blogImportLog.url,
      set: { status: "failed", error: (error || "").slice(0, 500), attempts: sql`${schema.blogImportLog.attempts} + 1`, updatedAt: ts },
    });
  return c.json({ ok: true });
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
  // Money + engagement metrics.
  const revenue =
    (await db.select({ v: sql<number>`COALESCE(SUM(${schema.payments.amount}),0)` }).from(schema.payments).where(eq(schema.payments.status, "success")).get())?.v ?? 0;
  const activeMatches =
    (await db.select({ v: count() }).from(schema.contestMatches).where(eq(schema.contestMatches.status, "active")).get())?.v ?? 0;
  const liveContests =
    (await db.select({ v: count() }).from(schema.contests).where(eq(schema.contests.status, "live")).get())?.v ?? 0;
  const pendingWithdrawals =
    (await db.select({ v: count() }).from(schema.withdrawals).where(eq(schema.withdrawals.status, "pending")).get())?.v ?? 0;
  return c.json({ users, posts, reports, support, revenue, activeMatches, liveContests, pendingWithdrawals });
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
  requireFullAdmin(c);
  const db = getDb(c.env);
  const { email, userId, makeAdmin, role: roleArg } = await c.req.json<any>();
  let uid = userId as string | undefined;
  if (!uid && email) {
    uid = (await getUserByEmail(c.env, email)) || undefined;
  }
  if (!uid) throw httpsError("not-found", "User not found (provide a valid email or userId).");
  // Prefer an explicit role ("admin" | "moderator" | "user"); fall back to the
  // legacy makeAdmin boolean.
  const role = ["admin", "moderator", "user"].includes(roleArg) ? roleArg : makeAdmin === false ? "user" : "admin";
  await setCustomClaims(c.env, uid, { role });
  await db.update(schema.users).set({ role, updatedAt: now() }).where(eq(schema.users.uid, uid));
  await logAudit(c, "user.set-role", "user", uid, { role });
  return c.json({ success: true, uid, role });
});

// Create a contest template (used by seed-contests).
adminRoute.post("/contests", async (c) => {
  requireFullAdmin(c);
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


// ======================= TRANSACTIONS / REVENUE =======================
/**
 * Coin transaction ledger. Optional filters: ?uid= , ?type= , ?limit= .
 * Joins the user's display name/username for a readable admin table.
 */
adminRoute.get("/transactions", async (c) => {
  const db = getDb(c.env);
  const uid = c.req.query("uid");
  const type = c.req.query("type");
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
  const conds: any[] = [];
  if (uid) conds.push(eq(schema.coinTransactions.uid, uid));
  if (type) conds.push(eq(schema.coinTransactions.type, type));
  const rows = await db
    .select({
      id: schema.coinTransactions.id,
      uid: schema.coinTransactions.uid,
      amount: schema.coinTransactions.amount,
      type: schema.coinTransactions.type,
      contestId: schema.coinTransactions.contestId,
      matchId: schema.coinTransactions.matchId,
      description: schema.coinTransactions.description,
      createdAt: schema.coinTransactions.createdAt,
      username: schema.users.username,
      fullName: schema.users.fullName,
    })
    .from(schema.coinTransactions)
    .leftJoin(schema.users, eq(schema.users.uid, schema.coinTransactions.uid))
    .where(conds.length ? and(...conds) : (undefined as any))
    .orderBy(desc(schema.coinTransactions.createdAt))
    .limit(limit)
    .all();
  return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null })));
});

// Distinct transaction types (for the filter dropdown).
adminRoute.get("/transactions/types", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select({ type: schema.coinTransactions.type }).from(schema.coinTransactions).groupBy(schema.coinTransactions.type).all();
  return c.json(rows.map((r) => r.type).filter(Boolean));
});

/**
 * Revenue analytics: total top-up revenue, count, coins-in-circulation, a
 * per-type breakdown of the coin ledger, the last-14-day payment trend and the
 * top spenders.
 */
adminRoute.get("/revenue", async (c) => {
  const db = getDb(c.env);
  const totalRevenue =
    (await db.select({ v: sql<number>`COALESCE(SUM(${schema.payments.amount}),0)` }).from(schema.payments).where(eq(schema.payments.status, "success")).get())?.v ?? 0;
  const paymentCount =
    (await db.select({ v: count() }).from(schema.payments).where(eq(schema.payments.status, "success")).get())?.v ?? 0;
  const coinsInCirculation =
    (await db.select({ v: sql<number>`COALESCE(SUM(${schema.users.dpcoin}),0)` }).from(schema.users).get())?.v ?? 0;

  const byType = await db
    .select({ type: schema.coinTransactions.type, total: sql<number>`COALESCE(SUM(${schema.coinTransactions.amount}),0)`, n: count() })
    .from(schema.coinTransactions)
    .groupBy(schema.coinTransactions.type)
    .all();

  // Last 14 days of payment revenue, bucketed by day (UTC).
  const since = now() - 14 * 86400000;
  const recentPayments = await db
    .select({ amount: schema.payments.amount, createdAt: schema.payments.createdAt })
    .from(schema.payments)
    .where(and(eq(schema.payments.status, "success"), gte(schema.payments.createdAt, since)))
    .all();
  const dayMap: Record<string, number> = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now() - i * 86400000).toISOString().slice(0, 10);
    dayMap[d] = 0;
  }
  for (const p of recentPayments) {
    const d = new Date(p.createdAt).toISOString().slice(0, 10);
    if (dayMap[d] !== undefined) dayMap[d] += Number(p.amount) || 0;
  }
  const trend = Object.entries(dayMap).map(([date, amount]) => ({ date, amount }));

  const topSpenders = await db
    .select({ userId: schema.payments.userId, total: sql<number>`COALESCE(SUM(${schema.payments.amount}),0)`, username: schema.users.username, fullName: schema.users.fullName })
    .from(schema.payments)
    .leftJoin(schema.users, eq(schema.users.uid, schema.payments.userId))
    .where(eq(schema.payments.status, "success"))
    .groupBy(schema.payments.userId)
    .orderBy(desc(sql`SUM(${schema.payments.amount})`))
    .limit(10)
    .all();

  return c.json({ totalRevenue, paymentCount, coinsInCirculation, byType, trend, topSpenders });
});

// Raw payment (top-up) list.
adminRoute.get("/payments", async (c) => {
  const db = getDb(c.env);
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
  const rows = await db
    .select({
      id: schema.payments.id,
      userId: schema.payments.userId,
      amount: schema.payments.amount,
      status: schema.payments.status,
      createdAt: schema.payments.createdAt,
      username: schema.users.username,
      fullName: schema.users.fullName,
    })
    .from(schema.payments)
    .leftJoin(schema.users, eq(schema.users.uid, schema.payments.userId))
    .orderBy(desc(schema.payments.createdAt))
    .limit(limit)
    .all();
  return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null })));
});

// ======================= CONTEST MATCHES (BATTLES) =======================
function matchRow(m: any) {
  const a = (m.userA as any) || {};
  const b = (m.userB as any) || {};
  return {
    id: m.id,
    contestId: m.contestId,
    title: m.title,
    type: m.type,
    status: m.status,
    entryFee: m.entryFee,
    isPrivate: !!m.isPrivate,
    totalVotes: m.totalVotes ?? 0,
    likeCount: m.likeCount ?? 0,
    commentCount: m.commentCount ?? 0,
    winnerUid: m.winnerUid,
    rewardAmount: m.rewardAmount ?? 0,
    userA: { uid: a.uid, username: a.username, profilePic: a.profilePic || a.profileImageUrl, mediaUrl: a.mediaUrl, votes: a.votes ?? 0 },
    userB: { uid: b.uid, username: b.username, profilePic: b.profilePic || b.profileImageUrl, mediaUrl: b.mediaUrl, votes: b.votes ?? 0 },
    createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
    expiresAt: m.expiresAt ? new Date(m.expiresAt).toISOString() : null,
    completedAt: m.completedAt ? new Date(m.completedAt).toISOString() : null,
  };
}

// List matches. Optional ?status= filter.
adminRoute.get("/matches", async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status");
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 300);
  const conds: any[] = [];
  if (status) conds.push(eq(schema.contestMatches.status, status));
  const rows = await db
    .select()
    .from(schema.contestMatches)
    .where(conds.length ? and(...conds) : (undefined as any))
    .orderBy(desc(schema.contestMatches.createdAt))
    .limit(limit)
    .all();
  return c.json(rows.map(matchRow));
});

// Single match detail.
adminRoute.get("/matches/:id", async (c) => {
  const db = getDb(c.env);
  const m = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, c.req.param("id"))).get();
  return c.json(m ? matchRow(m) : null);
});

// Votes cast in a match (audit — includes device ids for fraud checks).
adminRoute.get("/matches/:id/votes", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: schema.votes.id,
      voterUid: schema.votes.voterUid,
      votedForUid: schema.votes.votedForUid,
      deviceId: schema.votes.deviceId,
      createdAt: schema.votes.createdAt,
      username: schema.users.username,
    })
    .from(schema.votes)
    .leftJoin(schema.users, eq(schema.users.uid, schema.votes.voterUid))
    .where(eq(schema.votes.matchId, c.req.param("id")))
    .orderBy(desc(schema.votes.createdAt))
    .limit(500)
    .all();
  return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null })));
});

/**
 * Force-resolve a match and pay out the winner. `winnerUid` may be provided to
 * override the vote result (dispute resolution); otherwise the winner is
 * decided by the authoritative vote tally. Mirrors the cron payout: reward +
 * XP + wins + ledger + notifications, all committed atomically. Idempotent —
 * only claims a match that is still active/waiting.
 */
adminRoute.post("/matches/:id/declare-winner", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const body = await c.req.json<any>().catch(() => ({}));
  const m = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, id)).get();
  if (!m) throw httpsError("not-found", "Match not found.");
  if (m.status === "completed") throw httpsError("failed-precondition", "Match is already completed.");
  const userA = m.userA as any;
  const userB = m.userB as any;
  if (!userA?.uid || !userB?.uid) throw httpsError("failed-precondition", "Match has no opponents to judge.");

  let votesA = Number(userA.votes || 0);
  let votesB = Number(userB.votes || 0);
  try {
    const t = await finalizeVotes(c.env, id, userA.uid, userB.uid);
    votesA = t.votesA;
    votesB = t.votesB;
  } catch (e) {
    console.error("[declare-winner] vote finalize failed, using D1 snapshot", id, e);
  }

  let winnerUid: string = body.winnerUid || (votesA >= votesB ? userA.uid : userB.uid);
  if (winnerUid !== userA.uid && winnerUid !== userB.uid) {
    throw httpsError("invalid-argument", "winnerUid must be one of the two participants.");
  }
  const loserUid = winnerUid === userA.uid ? userB.uid : userA.uid;

  let rewardAmount = Number(m.entryFee || 0);
  if (m.contestId) {
    const contest = await db.select({ reward: schema.contests.rewardCoins }).from(schema.contests).where(eq(schema.contests.id, m.contestId)).get();
    if (contest?.reward) rewardAmount = Number(contest.reward);
  }

  const ts = now();
  const claim = await db
    .update(schema.contestMatches)
    .set({ status: "completed", winnerUid, rewardAmount, completedAt: ts })
    .where(and(eq(schema.contestMatches.id, id), ne(schema.contestMatches.status, "completed")))
    .run();
  if (claim.meta.changes === 0) throw httpsError("failed-precondition", "Match was already resolved.");

  await db.batch([
    db.update(schema.users).set({
      dpcoin: sql`${schema.users.dpcoin} + ${rewardAmount}`,
      xp: sql`${schema.users.xp} + 100`,
      wins: sql`${schema.users.wins} + 1`,
      monthlyWins: sql`${schema.users.monthlyWins} + 1`,
      updatedAt: ts,
    }).where(eq(schema.users.uid, winnerUid)),
    db.update(schema.users).set({ xp: sql`${schema.users.xp} + 20`, updatedAt: ts }).where(eq(schema.users.uid, loserUid)),
    db.insert(schema.coinTransactions).values({
      id: newId(), uid: winnerUid, amount: rewardAmount, type: "contest_win_reward",
      matchId: id, contestId: m.contestId, description: `Admin-declared victory for "${m.title}"`, createdAt: ts,
    }),
  ]);

  await createNotification(c.env, winnerUid, { title: "You Won! 🏆", body: `You won the battle "${m.title}" and earned ${rewardAmount} Dpcoins!`, type: "contest-win", targetId: id });
  await createNotification(c.env, loserUid, { title: "Battle Ended", body: `The battle "${m.title}" has concluded.`, type: "contest-loss", targetId: id });
  await logAudit(c, "match.declare-winner", "match", id, { winnerUid, rewardAmount, forced: !!body.winnerUid });
  return c.json({ message: "Winner declared", winnerUid, rewardAmount });
});

/**
 * Cancel a match and refund both participants' entry fees. Only cancels a match
 * that isn't already completed/cancelled. Idempotent via an atomic status claim.
 */
adminRoute.post("/matches/:id/cancel", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const m = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, id)).get();
  if (!m) throw httpsError("not-found", "Match not found.");
  if (m.status === "completed" || m.status === "cancelled") {
    throw httpsError("failed-precondition", "Match is already finalized.");
  }
  const ts = now();
  const claim = await db
    .update(schema.contestMatches)
    .set({ status: "cancelled", completedAt: ts })
    .where(and(eq(schema.contestMatches.id, id), inArray(schema.contestMatches.status, ["active", "waiting_for_opponent"])))
    .run();
  if (claim.meta.changes === 0) throw httpsError("failed-precondition", "Match could not be cancelled.");

  const userA = m.userA as any;
  const userB = m.userB as any;
  const fee = Number(m.entryFee || 0);
  const ops: any[] = [];
  for (const u of [userA, userB]) {
    if (u?.uid && fee > 0) {
      const refund = fee / 2;
      ops.push(db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${refund}` }).where(eq(schema.users.uid, u.uid)));
      ops.push(db.insert(schema.coinTransactions).values({ id: newId(), uid: u.uid, amount: refund, type: "contest_refund", matchId: id, description: `Admin cancelled "${m.title}" — entry fee refunded`, createdAt: ts }));
    }
  }
  if (ops.length) await db.batch(ops as any);
  for (const u of [userA, userB]) {
    if (u?.uid) await createNotification(c.env, u.uid, { title: "Battle Cancelled", body: `The battle "${m.title}" was cancelled by an admin and your entry fee was refunded.`, type: "contest-refund", targetId: "wallet" });
  }
  await logAudit(c, "match.cancel", "match", id, { refunded: fee });
  return c.json({ message: "Match cancelled and refunded" });
});

// ======================= FRAUD DETECTION =======================
/**
 * Devices that cast votes under more than one voter account — a signal of
 * multi-account vote stuffing. Returns each suspicious device with the number
 * of distinct accounts and total votes it produced.
 */
adminRoute.get("/fraud/votes", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      deviceId: schema.votes.deviceId,
      accounts: sql<number>`COUNT(DISTINCT ${schema.votes.voterUid})`,
      totalVotes: count(),
    })
    .from(schema.votes)
    .where(sql`${schema.votes.deviceId} IS NOT NULL AND ${schema.votes.deviceId} != ''`)
    .groupBy(schema.votes.deviceId)
    .having(sql`COUNT(DISTINCT ${schema.votes.voterUid}) > 1`)
    .orderBy(desc(sql`COUNT(DISTINCT ${schema.votes.voterUid})`))
    .limit(100)
    .all();
  return c.json(rows);
});

// ======================= BROADCAST =======================
// Send a push + in-app notification to every user.
adminRoute.post("/broadcast", async (c) => {
  requireFullAdmin(c);
  const { title, body, image, segment } = await c.req.json<any>();
  if (!title || !body) throw httpsError("invalid-argument", "title and body are required.");
  const sent = await sendSegmentedBroadcast(c.env, title, body, image || undefined, segment);
  await logAudit(c, "notification.broadcast", "broadcast", null, { title, recipients: sent, segment });
  return c.json({ success: true, recipients: sent });
});

// ======================= COMMENTS MODERATION =======================
// Recent post comments (with author + optional ?postId= filter).
adminRoute.get("/comments", async (c) => {
  const db = getDb(c.env);
  const postId = c.req.query("postId");
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 300);
  const conds: any[] = [];
  if (postId) conds.push(eq(schema.postComments.postId, postId));
  const rows = await db
    .select({
      id: schema.postComments.id,
      postId: schema.postComments.postId,
      userId: schema.postComments.userId,
      text: schema.postComments.text,
      likeCount: schema.postComments.likeCount,
      createdAt: schema.postComments.createdAt,
      username: schema.users.username,
      fullName: schema.users.fullName,
    })
    .from(schema.postComments)
    .leftJoin(schema.users, eq(schema.users.uid, schema.postComments.userId))
    .where(conds.length ? and(...conds) : (undefined as any))
    .orderBy(desc(schema.postComments.createdAt))
    .limit(limit)
    .all();
  return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null })));
});

adminRoute.delete("/comments/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const comment = await db.select({ postId: schema.postComments.postId }).from(schema.postComments).where(eq(schema.postComments.id, id)).get();
  await db.delete(schema.postComments).where(eq(schema.postComments.id, id));
  // Keep the post's denormalized counter honest.
  if (comment?.postId) {
    await db.update(schema.posts).set({ commentCount: sql`MAX(${schema.posts.commentCount} - 1, 0)` }).where(eq(schema.posts.id, comment.postId));
  }
  await logAudit(c, "comment.delete", "comment", id);
  return c.json({ message: "Comment deleted" });
});

// ======================= FOLLOWERS =======================
adminRoute.get("/users/:id/followers", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ uid: schema.users.uid, username: schema.users.username, fullName: schema.users.fullName, profileImageUrl: schema.users.profileImageUrl, since: schema.follows.createdAt })
    .from(schema.follows)
    .leftJoin(schema.users, eq(schema.users.uid, schema.follows.followerId))
    .where(eq(schema.follows.followingId, c.req.param("id")))
    .orderBy(desc(schema.follows.createdAt))
    .limit(200)
    .all();
  return c.json(rows);
});

adminRoute.get("/users/:id/following", async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({ uid: schema.users.uid, username: schema.users.username, fullName: schema.users.fullName, profileImageUrl: schema.users.profileImageUrl, since: schema.follows.createdAt })
    .from(schema.follows)
    .leftJoin(schema.users, eq(schema.users.uid, schema.follows.followingId))
    .where(eq(schema.follows.followerId, c.req.param("id")))
    .orderBy(desc(schema.follows.createdAt))
    .limit(200)
    .all();
  return c.json(rows);
});

// ======================= WITHDRAWALS =======================
// List payout requests (optional ?status= filter).
adminRoute.get("/withdrawals", async (c) => {
  const db = getDb(c.env);
  const status = c.req.query("status");
  const conds: any[] = [];
  if (status) conds.push(eq(schema.withdrawals.status, status));
  const rows = await db
    .select({
      id: schema.withdrawals.id,
      userId: schema.withdrawals.userId,
      amount: schema.withdrawals.amount,
      cashAmount: schema.withdrawals.cashAmount,
      method: schema.withdrawals.method,
      accountDetails: schema.withdrawals.accountDetails,
      status: schema.withdrawals.status,
      adminNote: schema.withdrawals.adminNote,
      createdAt: schema.withdrawals.createdAt,
      updatedAt: schema.withdrawals.updatedAt,
      username: schema.users.username,
      fullName: schema.users.fullName,
      balance: schema.users.dpcoin,
    })
    .from(schema.withdrawals)
    .leftJoin(schema.users, eq(schema.users.uid, schema.withdrawals.userId))
    .where(conds.length ? and(...conds) : (undefined as any))
    .orderBy(desc(schema.withdrawals.createdAt))
    .limit(200)
    .all();
  return c.json(
    rows.map((r) => ({
      ...r,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    })),
  );
});

/**
 * Action a withdrawal request. action: "approve" | "reject" | "paid".
 * Coins are deducted (held) when moving to approved/paid; a rejection of an
 * approved request refunds the held coins. The user's balance is validated on
 * approval so we never approve more than they hold.
 */
adminRoute.patch("/withdrawals/:id", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const { action, adminNote } = await c.req.json<any>();
  if (!["approve", "reject", "paid"].includes(action)) throw httpsError("invalid-argument", "Invalid action.");
  const w = await db.select().from(schema.withdrawals).where(eq(schema.withdrawals.id, id)).get();
  if (!w) throw httpsError("not-found", "Withdrawal not found.");
  const admin = c.get("user");
  const ts = now();

  const status = action === "approve" ? "approved" : action === "paid" ? "paid" : "rejected";

  // On approve/paid from a pending request: deduct (hold) the coins now.
  if ((action === "approve" || action === "paid") && w.status === "pending") {
    const user = await db.select({ balance: schema.users.dpcoin }).from(schema.users).where(eq(schema.users.uid, w.userId)).get();
    if (!user) throw httpsError("not-found", "Requesting user not found.");
    if ((user.balance ?? 0) < w.amount) throw httpsError("failed-precondition", "User has insufficient balance for this payout.");
    await db.batch([
      db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} - ${w.amount}`, updatedAt: ts }).where(eq(schema.users.uid, w.userId)),
      db.insert(schema.coinTransactions).values({ id: newId(), uid: w.userId, amount: -w.amount, type: "withdrawal", description: `Payout ${status} (${w.method})`, createdAt: ts }),
    ]);
  }

  // Rejecting a previously-approved request refunds the held coins.
  if (action === "reject" && w.status === "approved") {
    await db.batch([
      db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${w.amount}`, updatedAt: ts }).where(eq(schema.users.uid, w.userId)),
      db.insert(schema.coinTransactions).values({ id: newId(), uid: w.userId, amount: w.amount, type: "withdrawal_refund", description: "Payout rejected — coins refunded", createdAt: ts }),
    ]);
  }

  await db.update(schema.withdrawals).set({ status, adminNote: adminNote || w.adminNote, processedBy: admin?.uid ?? null, updatedAt: ts }).where(eq(schema.withdrawals.id, id));
  await createNotification(c.env, w.userId, {
    title: action === "reject" ? "Withdrawal Rejected" : action === "paid" ? "Payout Sent 💸" : "Withdrawal Approved",
    body: action === "reject" ? `Your payout request was rejected. ${adminNote ? "Reason: " + adminNote : ""}` : action === "paid" ? `Your payout of ${w.amount} Dpcoins has been sent.` : "Your payout request was approved and is being processed.",
    type: "withdrawal",
    targetId: "wallet",
  });
  await logAudit(c, `withdrawal.${action}`, "withdrawal", id, { amount: w.amount });
  return c.json({ message: `Withdrawal ${status}` });
});

// ======================= AUDIT LOG =======================
adminRoute.get("/audit-log", async (c) => {
  const db = getDb(c.env);
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
  const action = c.req.query("action");
  const conds: any[] = [];
  if (action) conds.push(eq(schema.adminAuditLog.action, action));
  const rows = await db
    .select()
    .from(schema.adminAuditLog)
    .where(conds.length ? and(...conds) : (undefined as any))
    .orderBy(desc(schema.adminAuditLog.createdAt))
    .limit(limit)
    .all();
  return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null })));
});


// ======================= COIN PACKAGES (top-up store) =======================
adminRoute.get("/coin-packages", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.coinPackages).orderBy(schema.coinPackages.sortOrder).all();
  return c.json(rows.map((r) => ({ ...r, active: !!r.active })));
});

adminRoute.post("/coin-packages", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const b = await c.req.json<any>();
  const id = newId();
  const ts = now();
  await db.insert(schema.coinPackages).values({
    id,
    name: b.name || null,
    coins: Number(b.coins ?? 0),
    bonusCoins: Number(b.bonusCoins ?? 0),
    priceInr: Number(b.priceInr ?? 0),
    active: b.active !== false,
    sortOrder: Number(b.sortOrder ?? 0),
    createdAt: ts,
    updatedAt: ts,
  });
  await logAudit(c, "coin-package.create", "coin_package", id, b);
  return c.json({ success: true, id });
});

adminRoute.patch("/coin-packages/:id", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const b = await c.req.json<any>();
  const set: any = { updatedAt: now() };
  if (b.name !== undefined) set.name = b.name;
  if (b.coins !== undefined) set.coins = Number(b.coins);
  if (b.bonusCoins !== undefined) set.bonusCoins = Number(b.bonusCoins);
  if (b.priceInr !== undefined) set.priceInr = Number(b.priceInr);
  if (b.active !== undefined) set.active = !!b.active;
  if (b.sortOrder !== undefined) set.sortOrder = Number(b.sortOrder);
  await db.update(schema.coinPackages).set(set).where(eq(schema.coinPackages.id, id));
  await logAudit(c, "coin-package.update", "coin_package", id, set);
  return c.json({ message: "Package updated" });
});

adminRoute.delete("/coin-packages/:id", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  await db.delete(schema.coinPackages).where(eq(schema.coinPackages.id, id));
  await logAudit(c, "coin-package.delete", "coin_package", id);
  return c.json({ message: "Package deleted" });
});

// ======================= SCHEDULED / SEGMENTED NOTIFICATIONS ==============
adminRoute.get("/scheduled-notifications", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.scheduledNotifications).orderBy(desc(schema.scheduledNotifications.sendAt)).limit(100).all();
  return c.json(
    rows.map((r) => ({
      ...r,
      sendAt: r.sendAt ? new Date(r.sendAt).toISOString() : null,
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null,
    })),
  );
});

adminRoute.post("/scheduled-notifications", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const b = await c.req.json<any>();
  if (!b.title || !b.body) throw httpsError("invalid-argument", "title and body are required.");
  const sendAt = b.sendAt ? new Date(b.sendAt).getTime() : now();
  const id = newId();
  const admin = c.get("user");
  await db.insert(schema.scheduledNotifications).values({
    id,
    title: b.title,
    body: b.body,
    image: b.image || null,
    segment: b.segment || null,
    sendAt,
    status: "pending",
    recipients: 0,
    createdBy: admin?.uid ?? null,
    createdAt: now(),
  });
  await logAudit(c, "notification.schedule", "scheduled_notification", id, { sendAt: b.sendAt, segment: b.segment });
  return c.json({ success: true, id });
});

adminRoute.delete("/scheduled-notifications/:id", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  await db.update(schema.scheduledNotifications).set({ status: "cancelled" }).where(and(eq(schema.scheduledNotifications.id, id), eq(schema.scheduledNotifications.status, "pending")));
  return c.json({ message: "Scheduled notification cancelled" });
});

// ======================= BANNED WORDS (auto-moderation) =====================
adminRoute.get("/banned-words", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.bannedWords).orderBy(schema.bannedWords.word).all();
  return c.json(rows.map((r) => r.word));
});

adminRoute.post("/banned-words", async (c) => {
  const db = getDb(c.env);
  const { word } = await c.req.json<any>();
  const w = String(word || "").trim().toLowerCase();
  if (!w) throw httpsError("invalid-argument", "word is required.");
  await db.insert(schema.bannedWords).values({ word: w, createdAt: now() }).onConflictDoNothing();
  await logAudit(c, "banned-word.add", "banned_word", w);
  return c.json({ success: true });
});

adminRoute.delete("/banned-words/:word", async (c) => {
  const db = getDb(c.env);
  const w = decodeURIComponent(c.req.param("word")).toLowerCase();
  await db.delete(schema.bannedWords).where(eq(schema.bannedWords.word, w));
  return c.json({ message: "Removed" });
});

// ======================= USER PROFILE EDIT + GRANT =========================
adminRoute.patch("/users/:id/profile", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const b = await c.req.json<any>();
  const set: any = { updatedAt: now() };
  if (b.fullName !== undefined) set.fullName = b.fullName;
  if (b.username !== undefined) set.username = String(b.username).toLowerCase();
  if (b.bio !== undefined) set.bio = b.bio;
  if (b.verified !== undefined) set.verified = !!b.verified;
  if (b.featured !== undefined) set.featured = !!b.featured;
  await db.update(schema.users).set(set).where(eq(schema.users.uid, id));
  await logAudit(c, "user.profile-edit", "user", id, set);
  return c.json({ message: "Profile updated" });
});

// Grant XP and/or a badge to a user (coins go through /wallet).
adminRoute.post("/users/:id/grant", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const { xp, badge } = await c.req.json<any>();
  const user = await db.select({ xp: schema.users.xp, badges: schema.users.badges }).from(schema.users).where(eq(schema.users.uid, id)).get();
  if (!user) throw httpsError("not-found", "User not found.");
  const set: any = { updatedAt: now() };
  if (typeof xp === "number" && xp !== 0) set.xp = sql`${schema.users.xp} + ${xp}`;
  if (badge) {
    const badges = ((user.badges as unknown as string[]) || []).slice();
    if (!badges.includes(badge)) badges.push(badge);
    set.badges = badges as any;
  }
  await db.update(schema.users).set(set).where(eq(schema.users.uid, id));
  await logAudit(c, "user.grant", "user", id, { xp, badge });
  return c.json({ message: "Granted" });
});

// ======================= ADMINS (role management) =========================
adminRoute.get("/admins", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const rows = await db
    .select({ uid: schema.users.uid, email: schema.users.email, username: schema.users.username, fullName: schema.users.fullName, role: schema.users.role, profileImageUrl: schema.users.profileImageUrl })
    .from(schema.users)
    .where(inArray(schema.users.role, ["admin", "moderator", "superadmin"]))
    .all();
  return c.json(rows);
});

// ======================= LEADERBOARD =======================
adminRoute.get("/leaderboard", async (c) => {
  const db = getDb(c.env);
  const metric = c.req.query("metric") || "monthlyWins";
  const col: Record<string, any> = {
    monthlyWins: schema.users.monthlyWins,
    wins: schema.users.wins,
    xp: schema.users.xp,
    dpcoin: schema.users.dpcoin,
    totalVotesReceived: schema.users.totalVotesReceived,
    followersCount: schema.users.followersCount,
  };
  const orderCol = col[metric] || schema.users.monthlyWins;
  const rows = await db
    .select({
      uid: schema.users.uid,
      username: schema.users.username,
      fullName: schema.users.fullName,
      profileImageUrl: schema.users.profileImageUrl,
      verified: schema.users.verified,
      level: schema.users.level,
      xp: schema.users.xp,
      wins: schema.users.wins,
      monthlyWins: schema.users.monthlyWins,
      dpcoin: schema.users.dpcoin,
      totalVotesReceived: schema.users.totalVotesReceived,
      followersCount: schema.users.followersCount,
    })
    .from(schema.users)
    .orderBy(desc(orderCol))
    .limit(50)
    .all();
  return c.json(rows.map((r) => ({ ...r, verified: !!r.verified })));
});

// ======================= MESSAGES MODERATION =======================
adminRoute.get("/messages", async (c) => {
  const db = getDb(c.env);
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 300);
  const rows = await db
    .select({
      id: schema.messages.id,
      chatId: schema.messages.chatId,
      senderId: schema.messages.senderId,
      text: schema.messages.text,
      createdAt: schema.messages.createdAt,
      username: schema.users.username,
    })
    .from(schema.messages)
    .leftJoin(schema.users, eq(schema.users.uid, schema.messages.senderId))
    .orderBy(desc(schema.messages.createdAt))
    .limit(limit)
    .all();
  return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null })));
});

adminRoute.delete("/messages/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  await db.delete(schema.messages).where(eq(schema.messages.id, id));
  await logAudit(c, "message.delete", "message", id);
  return c.json({ message: "Message deleted" });
});

// ======================= ANALYTICS =======================
adminRoute.get("/analytics", async (c) => {
  const db = getDb(c.env);
  const nowMs = now();
  const day = 86400000;
  const cnt = async (tbl: any, col: any, since: number) =>
    (await db.select({ v: count() }).from(tbl).where(gte(col, since)).get())?.v ?? 0;
  const sum = async (col: any, tbl: any, since: number, statusOk?: any) =>
    (await db.select({ v: sql<number>`COALESCE(SUM(${col}),0)` }).from(tbl).where(statusOk ? and(gte(tbl.createdAt, since), statusOk) : gte(tbl.createdAt, since)).get())?.v ?? 0;

  const totalUsers = (await db.select({ v: count() }).from(schema.users).get())?.v ?? 0;
  const newUsersToday = await cnt(schema.users, schema.users.createdAt, nowMs - day);
  const newUsers7d = await cnt(schema.users, schema.users.createdAt, nowMs - 7 * day);
  const newUsers30d = await cnt(schema.users, schema.users.createdAt, nowMs - 30 * day);

  // Active users (proxy): distinct voters in the window.
  const dau = (await db.select({ v: sql<number>`COUNT(DISTINCT ${schema.votes.voterUid})` }).from(schema.votes).where(gte(schema.votes.createdAt, nowMs - day)).get())?.v ?? 0;
  const mau = (await db.select({ v: sql<number>`COUNT(DISTINCT ${schema.votes.voterUid})` }).from(schema.votes).where(gte(schema.votes.createdAt, nowMs - 30 * day)).get())?.v ?? 0;

  const revenueToday = await sum(schema.payments.amount, schema.payments, nowMs - day, eq(schema.payments.status, "success"));
  const revenue30d = await sum(schema.payments.amount, schema.payments, nowMs - 30 * day, eq(schema.payments.status, "success"));

  const matchesToday = await cnt(schema.contestMatches, schema.contestMatches.createdAt, nowMs - day);
  const votesToday = await cnt(schema.votes, schema.votes.createdAt, nowMs - day);
  const postsToday = await cnt(schema.posts, schema.posts.createdAt, nowMs - day);
  const activeMatches = (await db.select({ v: count() }).from(schema.contestMatches).where(eq(schema.contestMatches.status, "active")).get())?.v ?? 0;
  const completedMatches = (await db.select({ v: count() }).from(schema.contestMatches).where(eq(schema.contestMatches.status, "completed")).get())?.v ?? 0;

  return c.json({
    totalUsers, newUsersToday, newUsers7d, newUsers30d,
    dau, mau,
    revenueToday, revenue30d,
    matchesToday, votesToday, postsToday,
    activeMatches, completedMatches,
  });
});

// ======================= OPS (manual cron triggers) =======================
adminRoute.post("/ops/resolve-contests", async (c) => {
  requireFullAdmin(c);
  await resolveContests(c.env);
  await logAudit(c, "ops.resolve-contests", "ops", null);
  return c.json({ message: "Contest resolver ran" });
});

adminRoute.post("/ops/hall-of-fame", async (c) => {
  requireFullAdmin(c);
  await monthlyHallOfFame(c.env);
  await logAudit(c, "ops.hall-of-fame", "ops", null);
  return c.json({ message: "Hall of Fame ran" });
});
