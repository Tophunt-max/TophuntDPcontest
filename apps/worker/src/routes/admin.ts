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
import { and, eq, desc, sql, count, ne, like, gte, lt, inArray, or, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { httpsError, ApiError } from "../lib/http";
import { timingSafeEqualSecret } from "../lib/timingSafe";
import { verifyIdToken, bearerToken } from "../lib/firebaseAuth";
import { assertAccountNotBlocked } from "../middleware/auth";
import { getAppConfig, getGamificationSettings, getSeoAudit, invalidateSetting } from "../lib/settings";
import { deleteAuthUser, updateAuthUser, setCustomClaims, getUserByEmail } from "../lib/firebaseAdmin";
import { createNotification } from "../lib/notify";
import { enqueueBroadcast } from "../lib/broadcast";
import { finalizeVotes } from "../lib/voteCounter";
import { settleRefund, settleWinner } from "../lib/contestSettlement";
import { refundRejectedWithdrawal } from "../lib/payouts";
import { publish } from "../lib/publish";
import { resolveContests, monthlyHallOfFame, seoAuditJob } from "../cron";
import { newId, now } from "../lib/ids";
import { discoverUrls, processBatch } from "../lib/importerTask";
import { runVideoBackfillBatch } from "../lib/videoBackfill";
import {
  blogListCacheKey,
  blogPostCacheKey,
  commentsCacheKey,
  delCache,
  invalidateContestCaches,
} from "../lib/cache";
import {
  assertContestWindow,
  contestBannerUrl,
  cleanContestExtra,
  createContestExtra,
  hasOwn,
  isRecord,
  validateContestInput,
} from "../lib/contestAdmin";
import {
  contestBannerKeyFromPublicUrl,
  deleteContestBannerByPublicUrl,
  putVerifiedImage,
  sanitizeMediaFolder,
  uploadToR2,
} from "../lib/r2";
import {
  adjustUserWallet,
  assertCoinAmount,
  assertPrizeFundedByPot,
  matchPot,
  perPlayerEntryFee,
  roundFiat,
  toPaise,
  validateCoinPackage,
  WalletReplay,
} from "../lib/money";
import { fetchExternalImage } from "../lib/safeFetch";
import { enforceAdminIdempotency } from "../lib/idempotency";
import { registerIntegrationRoutes } from "./integrations";
import { assertIdentifiersAvailable, validateUsername } from "../lib/userIdentifiers";
import { computeDeepHealth } from "../lib/health";
import { computeMoneyHealth } from "../lib/moneyHealth";
import { cronHealth } from "../lib/ops";

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

/** Close existing private realtime sessions after an account is blocked. */
async function revokeRealtimeSessions(env: Env, uid: string): Promise<void> {
  const chats = await env.DB.prepare(
    `SELECT id FROM chats
      WHERE EXISTS (
        SELECT 1 FROM json_each(chats.users) WHERE json_each.value = ?
      )`,
  ).bind(uid).all<{ id: string }>();
  const channels = new Set<string>([
    `user:${uid}`,
    ...(chats.results ?? []).map((chat) => `chat:${chat.id}`),
  ]);
  await Promise.all([...channels].map(async (channel) => {
    const id = env.REALTIME.idFromName(channel);
    await env.REALTIME.get(id).fetch("https://do.internal/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid }),
    });
  }));
}

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
  // Constant-time compare: this secret grants full superadmin access, so a
  // short-circuiting `===` would hand out a timing oracle for guessing it
  // byte by byte.
  if (
    secret &&
    c.env.ADMIN_PROXY_SECRET &&
    (await timingSafeEqualSecret(secret, c.env.ADMIN_PROXY_SECRET))
  ) {
    c.set("adminRole", "superadmin");
    return next();
  }
  const token = bearerToken(c.req.header("Authorization"));
  if (token) {
    try {
      const user = await verifyIdToken(token, c.env);
      await assertAccountNotBlocked(c.env, user.uid);
      c.set("user", user);
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
  if (!isFullAdmin(c)) {
    throw httpsError("permission-denied", "This action requires full admin access.");
  }
}

/**
 * True for superadmin/admin, false for moderator.
 *
 * Used where the right answer is to FILTER what a moderator sees rather than
 * reject the request outright (e.g. the notification bell in the panel layout,
 * which would otherwise error on every page for a moderator).
 */
function isFullAdmin(c: any): boolean {
  return c.get("adminRole") !== "moderator";
}

// ---- third-party integrations (SMS gateway, email, payments, video CDN) ----
// Config + encrypted credentials, all manageable from the panel. See
// routes/integrations.ts for why credential values are write-only.
registerIntegrationRoutes(adminRoute, requireFullAdmin);

// ---- app settings (settings/appConfig) ----

/**
 * Merge an app-settings patch into the stored config, one nesting level at a time.
 *
 * This used to be `{ ...existing, ...body }`, which is only correct for a patch
 * whose values are all scalars. `appConfig` is not that shape — `legalContent`,
 * `withdrawal`, `announcement`, `features` and `ads` are all nested objects, and a
 * spread REPLACES a nested object rather than merging into it.
 *
 * The consequence was data loss on any partial write. Posting
 * `{ legalContent: { termsOfService: "..." } }` — which is exactly what
 * `scripts/update-legal-content.mjs` did — silently deleted the privacy policy,
 * refund policy and community guidelines. Nothing surfaced it: the request
 * returned 200 and the documents were simply gone until someone opened the app.
 *
 * Plain objects merge recursively. Everything else replaces, which matters for
 * arrays: index-wise merging an array would leave the tail of the old value
 * behind, so removing an item would be impossible. `null` replaces too, so a
 * caller can still clear a value deliberately.
 */
function mergeSettings(existing: any, patch: any): any {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isPlainObject(existing) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(existing[key])
      ? mergeSettings(existing[key], value)
      : value;
  }
  return out;
}

adminRoute.get("/app-settings", async (c) => c.json((await getAppConfig(c.env)) || {}));
adminRoute.post("/app-settings", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const body = await c.req.json<any>();
  const existing = (await getAppConfig(c.env)) || {};
  const merged = mergeSettings(existing, body);
  await db
    .insert(schema.settings)
    .values({ id: "appConfig", data: merged, updatedAt: now() })
    .onConflictDoUpdate({ target: schema.settings.id, set: { data: merged, updatedAt: now() } });
  await invalidateSetting(c.env, "appConfig");
  return c.json({ message: "Settings updated successfully" });
});

// ---- rewards (settings/gamification) ----
adminRoute.get("/rewards", async (c) => c.json((await getGamificationSettings(c.env)) || {}));
/**
 * Reward keys whose value is added directly to `users.dpcoin`.
 *
 * This endpoint merges arbitrary JSON into the gamification settings row, and
 * these particular keys are then credited to real balances by the daily-reward,
 * signup and referral paths. A fractional value would break the "coins are whole
 * numbers" invariant for everyone who claimed it, and a negative one would
 * silently DEBIT them — so they are validated here, at the point of entry, rather
 * than being discovered later in a balance. lib/gamification.ts sanitises on read
 * as a second line of defence for values stored before this check existed.
 */
const REWARD_COIN_KEYS = ["dailyLoginReward", "dailyBaseReward", "dailyStreakBonus", "signupBonus", "referralBonus"] as const;

adminRoute.post("/rewards", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const body = await c.req.json<any>();
  for (const key of REWARD_COIN_KEYS) {
    if (body?.[key] === undefined || body[key] === null) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 1_000_000) {
      throw httpsError(
        "invalid-argument",
        `${key} must be a whole number of coins between 0 and 1000000 — it is credited straight to user balances.`,
      );
    }
  }
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
const CONTEST_BANNER_MAX_BYTES = 5 * 1024 * 1024;
const CONTEST_BANNER_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

function contestBannerCandidates(row: any): string[] {
  const extra = isRecord(row?.extra) ? row.extra : {};
  return [...new Set([row?.bannerUrl, extra.bannerUrl, extra.bannerImageUrl].filter((url): url is string => typeof url === "string" && !!url))];
}

async function contestMatchCounts(db: ReturnType<typeof getDb>, contestId: string): Promise<{ waiting: number; active: number }> {
  const result = await db
    .select({
      waiting: sql<number>`COALESCE(SUM(CASE WHEN ${schema.contestMatches.status} = 'waiting_for_opponent' THEN 1 ELSE 0 END), 0)`,
      active: sql<number>`COALESCE(SUM(CASE WHEN ${schema.contestMatches.status} = 'active' THEN 1 ELSE 0 END), 0)`,
    })
    .from(schema.contestMatches)
    .where(eq(schema.contestMatches.contestId, contestId))
    .get();
  return { waiting: Number(result?.waiting ?? 0), active: Number(result?.active ?? 0) };
}

async function contestBannerKeyIsAttached(
  db: ReturnType<typeof getDb>,
  env: Env,
  key: string,
): Promise<boolean> {
  const rows = await db.select({ bannerUrl: schema.contests.bannerUrl, extra: schema.contests.extra }).from(schema.contests).all();
  return rows.some((row) =>
    contestBannerCandidates(row).some((url) => contestBannerKeyFromPublicUrl(env, url) === key),
  );
}

async function cleanupUnattachedContestBanners(c: any, urls: string[]): Promise<void> {
  try {
    const db = getDb(c.env);
    for (const url of new Set(urls)) {
      const key = contestBannerKeyFromPublicUrl(c.env, url);
      if (!key) continue;
      if (!(await contestBannerKeyIsAttached(db, c.env, key))) await deleteContestBannerByPublicUrl(c.env, url);
    }
  } catch (e) {
    console.error("[r2] contest banner cleanup failed (continuing)", e);
  }
}

/**
 * Shared pre-read guards for the two admin image uploads.
 *
 * Both routes had an identical 25-line block plus their own local magic-byte
 * sniffer. The sniffer now lives in `lib/mediaTypes.ts` and is applied inside
 * `uploadToR2`, so what is left here is the declared-type and size screening that
 * should happen before the body is read at all.
 */
function assertAdminImageUpload(c: any): string {
  const fileType = (c.req.header("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!CONTEST_BANNER_MIME_TYPES.includes(fileType as any)) {
    throw httpsError("invalid-argument", "Must be a JPEG, PNG, or WebP image.");
  }
  const contentLength = c.req.header("Content-Length");
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw httpsError("invalid-argument", "Invalid Content-Length.");
    }
    if (declaredBytes > CONTEST_BANNER_MAX_BYTES) {
      throw httpsError("invalid-argument", "File too large (max 5MB).");
    }
  }
  return fileType;
}

async function readAdminImageBody(c: any): Promise<ArrayBuffer> {
  const body = await c.req.arrayBuffer();
  if (!body.byteLength) throw httpsError("invalid-argument", "Empty upload.");
  if (body.byteLength > CONTEST_BANNER_MAX_BYTES) throw httpsError("invalid-argument", "File too large (max 5MB).");
  return body;
}

adminRoute.post("/media/contest-banner", async (c) => {
  requireFullAdmin(c);
  const fileType = assertAdminImageUpload(c);
  const body = await readAdminImageBody(c);

  // Passing the exact declared type as the allow-list keeps the strict
  // behaviour these routes always had: the panel sends the browser's own
  // `file.type`, so the bytes must match it exactly, not merely be some image.
  const uploaded = await uploadToR2(c.env, fileType, "contest-banners", body, [fileType]);
  await logAudit(c, "contest.banner.upload", "contest-banner", uploaded.fileKey, { publicUrl: uploaded.publicUrl });
  return c.json(uploaded);
});

// Upload the manual payment QR image (stored in R2). Returns a public URL that
// the admin saves into appConfig.paymentGateway.qrImageUrl — so the app keeps
// reading a single URL, but it's now an uploaded image (no external hosting).
adminRoute.post("/media/payment-qr", async (c) => {
  requireFullAdmin(c);
  const fileType = assertAdminImageUpload(c);
  const body = await readAdminImageBody(c);

  const uploaded = await uploadToR2(c.env, fileType, "payment-qr", body, [fileType]);
  await logAudit(c, "payment.qr.upload", "payment-qr", uploaded.fileKey, { publicUrl: uploaded.publicUrl });
  return c.json(uploaded);
});

adminRoute.delete("/media/contest-banner", async (c) => {
  requireFullAdmin(c);
  const body = await c.req.json<unknown>();
  if (!isRecord(body) || typeof body.url !== "string") {
    throw httpsError("invalid-argument", "url must be an owned contest-banner URL.");
  }
  const key = contestBannerKeyFromPublicUrl(c.env, body.url);
  if (!key) throw httpsError("invalid-argument", "url must be an owned contest-banner URL.");
  const db = getDb(c.env);
  if (await contestBannerKeyIsAttached(db, c.env, key)) {
    throw httpsError("failed-precondition", "Cannot delete a banner that is attached to a contest.");
  }
  await deleteContestBannerByPublicUrl(c.env, body.url);
  await logAudit(c, "contest.banner.delete", "contest-banner", body.url);
  return c.json({ success: true });
});

adminRoute.delete("/contests/:id", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const current = await db.select().from(schema.contests).where(eq(schema.contests.id, id)).get();
  if (!current) throw httpsError("not-found", "Contest not found.");
  if (current.status === "live") throw httpsError("failed-precondition", "Live contests cannot be deleted.");
  const matches = await contestMatchCounts(db, id);
  if (matches.waiting || matches.active) {
    throw httpsError("failed-precondition", "Contests with waiting or active matches cannot be deleted.");
  }

  const deleted = await db
    .delete(schema.contests)
    .where(and(
      eq(schema.contests.id, id),
      sql`(${schema.contests.status} IS NULL OR ${schema.contests.status} <> 'live')`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${schema.contestMatches}
        WHERE ${schema.contestMatches.contestId} = ${id}
          AND ${schema.contestMatches.status} IN ('waiting_for_opponent', 'active')
      )`,
    ))
    .run();
  if (deleted.meta.changes === 0) {
    const stillExists = await db.select({ id: schema.contests.id }).from(schema.contests).where(eq(schema.contests.id, id)).get();
    if (!stillExists) throw httpsError("not-found", "Contest not found.");
    throw httpsError("failed-precondition", "Contest became ineligible for deletion; refresh and try again.");
  }
  await invalidateContestCaches(c.env, id);
  await logAudit(c, "contest.delete", "contest", id, { previous: current });
  await cleanupUnattachedContestBanners(c, contestBannerCandidates(current));
  return c.json({ message: "Contest deleted successfully" });
});

// Update a contest template.
adminRoute.patch("/contests/:id", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const body = await c.req.json<unknown>();
  const { recognized, values } = validateContestInput(body, false);
  if (!recognized) throw httpsError("invalid-argument", "At least one recognized contest field is required.");

  const current = await db.select().from(schema.contests).where(eq(schema.contests.id, id)).get();
  if (!current) throw httpsError("not-found", "Contest not found.");

  // Validate the invariant on the MERGED result: a PATCH that only raises
  // rewardCoins, or only lowers totalEntryFee, must be rejected just the same.
  assertPrizeFundedByPot(
    hasOwn(values, "totalEntryFee") ? values.totalEntryFee : Number(current.totalEntryFee ?? 0),
    hasOwn(values, "rewardCoins") ? values.rewardCoins : Number(current.rewardCoins ?? 0),
  );

  // Same reason as above: a PATCH that only moves one edge of the window has to
  // be checked against the edge already in the database.
  assertContestWindow(
    hasOwn(values, "startsAt") ? values.startsAt : (current.startsAt ?? null),
    hasOwn(values, "endsAt") ? values.endsAt : (current.endsAt ?? null),
  );

  const matches = await contestMatchCounts(db, id);
  if (hasOwn(values, "status") && current.status === "live" && values.status !== "live" && matches.waiting) {
    throw httpsError("failed-precondition", "Cannot move a live contest while waiting matches exist.");
  }
  if (hasOwn(values, "rewardCoins") && values.rewardCoins !== Number(current.rewardCoins ?? 0) && matches.active) {
    throw httpsError("failed-precondition", "Cannot change rewards while active matches exist.");
  }
  if (
    hasOwn(values, "voteDurationDays") &&
    values.voteDurationDays !== Number(current.voteDurationDays ?? 1) &&
    matches.waiting
  ) {
    throw httpsError("failed-precondition", "Cannot change vote duration while waiting matches exist.");
  }

  const currentExtra = isRecord(current.extra) ? current.extra : {};
  const set: Record<string, any> = {};
  for (const field of [
    "title", "type", "status", "totalEntryFee", "rewardCoins", "voteDurationDays", "autoCancelHours", "minVotes", "bannerUrl",
    "startsAt", "endsAt",
  ]) {
    if (hasOwn(values, field)) set[field] = values[field];
  }
  // Migrate a legacy extra-only banner before removing stale canonical copies.
  if (!hasOwn(set, "bannerUrl") && !current.bannerUrl && typeof (currentExtra.bannerUrl ?? currentExtra.bannerImageUrl) === "string") {
    set.bannerUrl = currentExtra.bannerUrl ?? currentExtra.bannerImageUrl;
  }
  const extra = cleanContestExtra(currentExtra);
  if (hasOwn(values, "description")) extra.description = values.description;
  if (hasOwn(values, "rules")) extra.rules = values.rules;
  set.extra = extra;

  const finalStatus = hasOwn(set, "status") ? set.status : current.status;
  const finalBanner = hasOwn(set, "bannerUrl") ? set.bannerUrl : current.bannerUrl;
  if (
    finalStatus === "live" &&
    !contestBannerUrl(finalBanner) &&
    (current.status !== "live" || hasOwn(set, "bannerUrl"))
  ) {
    throw httpsError("failed-precondition", "A banner is required before a contest can go live.");
  }

  const oldBanners = contestBannerCandidates(current);
  const updateConditions: any[] = [eq(schema.contests.id, id)];
  if (current.status === "live" && set.status !== undefined && set.status !== "live") {
    updateConditions.push(sql`NOT EXISTS (
      SELECT 1 FROM ${schema.contestMatches}
      WHERE ${schema.contestMatches.contestId} = ${id}
        AND ${schema.contestMatches.status} = 'waiting_for_opponent'
    )`);
  }
  if (set.rewardCoins !== undefined && set.rewardCoins !== Number(current.rewardCoins ?? 0)) {
    updateConditions.push(sql`NOT EXISTS (
      SELECT 1 FROM ${schema.contestMatches}
      WHERE ${schema.contestMatches.contestId} = ${id}
        AND ${schema.contestMatches.status} = 'active'
    )`);
  }
  if (set.voteDurationDays !== undefined && set.voteDurationDays !== Number(current.voteDurationDays ?? 1)) {
    updateConditions.push(sql`NOT EXISTS (
      SELECT 1 FROM ${schema.contestMatches}
      WHERE ${schema.contestMatches.contestId} = ${id}
        AND ${schema.contestMatches.status} = 'waiting_for_opponent'
    )`);
  }

  const updated = await db.update(schema.contests).set(set).where(and(...updateConditions)).run();
  if (updated.meta.changes === 0) {
    throw httpsError("failed-precondition", "Contest activity changed while saving. Refresh and try again.");
  }
  await invalidateContestCaches(c.env, id);
  await logAudit(c, "contest.update", "contest", id, set);
  await cleanupUnattachedContestBanners(c, oldBanners);
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
/** Fetch a light preview (media/text) of a reported target for moderation. */
async function reportPreview(db: any, targetType: string | null, targetId: string | null): Promise<any> {
  if (!targetId) return null;
  try {
    switch (targetType) {
      case "post": {
        const p = await db.select({ mediaUrl: schema.posts.mediaUrl, caption: schema.posts.caption, userId: schema.posts.userId }).from(schema.posts).where(eq(schema.posts.id, targetId)).get();
        return p ? { kind: "post", mediaUrl: p.mediaUrl, text: p.caption, ownerId: p.userId } : { kind: "post", missing: true };
      }
      case "story": {
        const s = await db.select({ mediaUrl: schema.stories.mediaUrl, userId: schema.stories.userId }).from(schema.stories).where(eq(schema.stories.id, targetId)).get();
        return s ? { kind: "story", mediaUrl: s.mediaUrl, ownerId: s.userId } : { kind: "story", missing: true };
      }
      case "match":
      case "contestMatch":
      case "contestMatches": {
        const m = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, targetId)).get();
        const a = (m?.userA as any) || {};
        return m ? { kind: "match", mediaUrl: a.mediaUrl, text: m.title } : { kind: "match", missing: true };
      }
      case "comment": {
        const cm = await db.select({ text: schema.postComments.text, userId: schema.postComments.userId }).from(schema.postComments).where(eq(schema.postComments.id, targetId)).get();
        return cm ? { kind: "comment", text: cm.text, ownerId: cm.userId } : { kind: "comment", missing: true };
      }
      case "user": {
        const u = await db.select({ username: schema.users.username, profileImageUrl: schema.users.profileImageUrl }).from(schema.users).where(eq(schema.users.uid, targetId)).get();
        return u ? { kind: "user", mediaUrl: u.profileImageUrl, text: u.username } : { kind: "user", missing: true };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

adminRoute.get("/reports", async (c) => {
  const db = getDb(c.env);
  const rows = await db.select().from(schema.reports).orderBy(desc(schema.reports.createdAt)).limit(100).all();
  const out = await Promise.all(
    rows.map(async (r) => ({
      ...r,
      createdAt: new Date(r.createdAt).toISOString(),
      preview: await reportPreview(db, r.targetType, r.targetId),
    })),
  );
  return c.json(out);
});
adminRoute.delete("/reports", async (c) => {
  const db = getDb(c.env);
  const id = c.req.query("id");
  if (id) await db.delete(schema.reports).where(eq(schema.reports.id, id));
  return c.json({ message: "Report deleted" });
});

/**
 * Resolve a report. action: "dismiss" (just close it) or "remove" (delete the
 * reported content, then close it).
 */
adminRoute.post("/reports/:id/resolve", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const { action } = await c.req.json<any>();
  const r = await db.select().from(schema.reports).where(eq(schema.reports.id, id)).get();
  if (!r) throw httpsError("not-found", "Report not found.");

  if (action === "remove") {
    switch (r.targetType) {
      case "post":
        await db.delete(schema.posts).where(eq(schema.posts.id, r.targetId as string));
        break;
      case "story":
        await db.delete(schema.stories).where(eq(schema.stories.id, r.targetId as string));
        break;
      case "comment":
        await db.delete(schema.postComments).where(eq(schema.postComments.id, r.targetId as string));
        break;
      case "match":
      case "contestMatch":
      case "contestMatches":
        await db.update(schema.contestMatches).set({ status: "cancelled" }).where(eq(schema.contestMatches.id, r.targetId as string));
        break;
      default:
        break;
    }
  }
  await db.delete(schema.reports).where(eq(schema.reports.id, id));
  await logAudit(c, `report.${action === "remove" ? "remove" : "dismiss"}`, r.targetType || "report", r.targetId || id);
  return c.json({ message: action === "remove" ? "Content removed" : "Report dismissed" });
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
  await revokeRealtimeSessions(c.env, id);
  await db.delete(schema.users).where(eq(schema.users.uid, id));
  await deleteAuthUser(c.env, id).catch((e) => console.error("Auth delete failed", e));
  await logAudit(c, "user.delete", "user", id);
  return c.json({ message: "User deleted successfully" });
});
adminRoute.patch("/users/:id", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const { isBlocked } = await c.req.json<any>();
  const blocked = !!isBlocked;
  const updated = await db.update(schema.users)
    .set({ isBlocked: blocked, status: blocked ? "blocked" : "active", updatedAt: now() })
    .where(eq(schema.users.uid, id))
    .run();
  if (updated.meta.changes === 0) throw httpsError("not-found", "User not found.");
  await updateAuthUser(c.env, id, { disabled: blocked }).catch((e) => console.warn("Auth update failed", e));
  if (blocked) await revokeRealtimeSessions(c.env, id);
  await logAudit(c, blocked ? "user.block" : "user.unblock", "user", id);
  return c.json({ message: `User ${blocked ? "blocked" : "unblocked"} successfully`, status: blocked });
});

// ---- wallet (was adminManageWallet Cloud Function) ----
adminRoute.post("/users/:id/wallet", async (c) => {
  requireFullAdmin(c);
  const userId = c.req.param("id");
  const { amount, type } = await c.req.json<any>();
  if (!["add", "subtract"].includes(type)) {
    throw httpsError("invalid-argument", "type must be add or subtract.");
  }
  const amt = assertCoinAmount(amount, "amount");
  // `adjustUserWallet` is the only supported wallet mutation: it validates the
  // amount as a positive whole number, writes balance + ledger in one D1
  // transaction, and fails loudly instead of clamping an over-subtraction.
  // An `Idempotency-Key` header turns a double-clicked adjustment into a no-op.
  const idemKey = c.req.header("Idempotency-Key");
  try {
    const { newBalance, applied } = await adjustUserWallet(c.env, {
      uid: userId,
      amount: amt,
      direction: type,
      type: "admin_adjustment",
      description: `Admin ${type} ${amt} Dpcoin`,
      claimKey: idemKey ? `admin_wallet:${userId}:${idemKey}` : undefined,
      ts: now(),
    });
    await logAudit(c, "wallet.adjust", "user", userId, { amount: applied, type, newBalance });
    return c.json({ message: "Wallet updated successfully", newBalance });
  } catch (e) {
    if (e instanceof WalletReplay) {
      // Same key, already applied. Report the current balance rather than
      // pretending to have moved coins a second time.
      const current = await getDb(c.env)
        .select({ balance: schema.users.dpcoin })
        .from(schema.users)
        .where(eq(schema.users.uid, userId))
        .get();
      return c.json({
        message: "Wallet already updated for this request (no change applied).",
        newBalance: current?.balance ?? 0,
        replayed: true,
      });
    }
    throw e;
  }
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

const BLOG_LIMITS = {
  title: 200,
  excerpt: 500,
  content: 1_000_000,
  url: 2_048,
  category: 100,
  author: 100,
  tag: 50,
  tags: 20,
  metaTitle: 160,
  metaDescription: 300,
};

function blogText(
  value: unknown,
  label: string,
  maxLength: number,
  options: { required?: boolean; preserveWhitespace?: boolean } = {},
): string | null {
  if (value === null || value === undefined) {
    if (options.required) throw httpsError("invalid-argument", `${label} is required.`);
    return null;
  }
  if (typeof value !== "string") throw httpsError("invalid-argument", `${label} must be text.`);
  const normalized = options.preserveWhitespace ? value.trim() : value.trim().replace(/\s+/g, " ");
  if (!normalized) {
    if (options.required) throw httpsError("invalid-argument", `${label} is required.`);
    return null;
  }
  if (normalized.length > maxLength) {
    throw httpsError("invalid-argument", `${label} must be ${maxLength.toLocaleString()} characters or fewer.`);
  }
  return normalized;
}

function blogUrl(value: unknown, label: string): string | null {
  const normalized = blogText(value, label, BLOG_LIMITS.url);
  if (!normalized) return null;
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw httpsError("invalid-argument", `${label} must be a valid URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw httpsError("invalid-argument", `${label} must use http:// or https://.`);
  }
  return normalized;
}

function blogTags(value: unknown): string[] {
  if (!Array.isArray(value)) throw httpsError("invalid-argument", "Tags must be an array.");
  if (value.length > BLOG_LIMITS.tags) {
    throw httpsError("invalid-argument", `Add no more than ${BLOG_LIMITS.tags} tags.`);
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const tag = blogText(raw, "Each tag", BLOG_LIMITS.tag);
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (!seen.has(key)) {
      tags.push(tag);
      seen.add(key);
    }
  }
  return tags;
}

function blogStatus(value: unknown): "published" | "draft" {
  if (value !== "published" && value !== "draft") {
    throw httpsError("invalid-argument", "Status must be published or draft.");
  }
  return value;
}

function blogPlainText(content: string | null | undefined): string {
  return (content || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-zA-Z0-9#]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validatePublishedBlog(status: string, content: string | null | undefined): void {
  if (status === "published" && blogPlainText(content).length < 20) {
    throw httpsError("invalid-argument", "Published posts need at least 20 characters of readable content.");
  }
}

/** Clear the hot public list/detail caches after an editorial write. */
async function invalidateBlogReadCache(c: any, id?: string, ...slugs: Array<string | null | undefined>): Promise<void> {
  const keys = new Set<string>([blogListCacheKey(12)]);
  if (id) keys.add(blogPostCacheKey(id));
  for (const slug of slugs) if (slug) keys.add(blogPostCacheKey(slug));
  await delCache(c.env, ...keys);

  // Categories use the Cache API rather than KV. This is best-effort just like
  // the shared KV invalidator and must never make an admin write fail.
  try {
    const categoriesUrl = new URL(c.req.url);
    categoriesUrl.pathname = "/read/blog/categories";
    categoriesUrl.search = "";
    await (caches as any).default.delete(new Request(categoriesUrl.toString()));
  } catch (e) {
    console.error("[cache] blog categories delete failed (continuing)", e);
  }
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

/** Bound on a single imported image so one URL cannot exhaust Worker memory. */
const MAX_IMPORT_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * Fetch a single (Wayback-hosted) TopHunt image and store the ORIGINAL bytes in
 * R2, returning the permanent public R2 URL. De-duplicated by content hash so
 * the same image is never uploaded twice. Only image content-types are stored.
 */
adminRoute.post("/media/fetch-to-r2", async (c) => {
  // Server-side fetch of an attacker-influenced URL is an SSRF primitive, and
  // it writes into our own R2 bucket. Restricted to full admins, the URL is
  // validated against private/link-local/metadata targets, and redirects are
  // re-validated per hop (see lib/safeFetch.ts).
  requireFullAdmin(c);
  const { url, folder } = await c.req.json<any>();
  if (!url || typeof url !== "string") throw httpsError("invalid-argument", "url is required.");
  // Keep the key inside our own namespace: no leading slash, no traversal, no
  // empty segments — a client-controlled prefix must not be able to write over
  // deployment-owned paths such as `contest-banners/`.
  const baseFolder = sanitizeMediaFolder(folder || "blog/imported", "blog/imported");

  const { buffer: buf, contentType: ct } = await fetchExternalImage(
    url,
    "TopHuntArchiveImporter/1.0 (+https://tophunt.in)",
    MAX_IMPORT_IMAGE_BYTES,
  );

  const hash = await sha256Hex(buf);
  // `putVerifiedImage` decides the extension and the stored content type from the
  // bytes. The remote `Content-Type` (`ct`) is not trusted for either: this used
  // to map `image/svg+xml` to `.svg` and fall back to a `.img` extension for
  // anything unrecognised, which meant a hostile archive host could place a
  // scriptable SVG — or simply an arbitrary blob — into our bucket.
  const stored = await putVerifiedImage(c.env, baseFolder, buf, hash);
  if (!stored) {
    throw httpsError(
      "invalid-argument",
      `That URL returned ${ct || "unknown"} data that is not a JPEG, PNG, WebP or GIF image.`,
    );
  }
  return c.json({
    url: stored.publicUrl,
    hash,
    key: stored.key,
    cached: stored.cached,
    bytes: buf.byteLength,
    contentType: stored.contentType,
  });
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
  const b = await c.req.json<any>().catch(() => {
    throw httpsError("invalid-argument", "A JSON request body is required.");
  });
  const title = blogText(b.title, "Title", BLOG_LIMITS.title, { required: true })!;
  const content = blogText(b.content, "Content", BLOG_LIMITS.content, { preserveWhitespace: true });
  const excerpt = blogText(b.excerpt, "Excerpt", BLOG_LIMITS.excerpt);
  const status = blogStatus(b.status ?? "draft");
  const author = blogText(b.author ?? "TopHunt", "Author", BLOG_LIMITS.author, { required: true })!;
  const category = blogText(b.category, "Category", BLOG_LIMITS.category);
  const coverImageUrl = blogUrl(b.coverImageUrl, "Cover image URL");
  const tags = b.tags === undefined ? [] : blogTags(b.tags);
  validatePublishedBlog(status, content);

  const ts = now();
  const slug = await uniqueBlogSlug(db, slugify(blogText(b.slug, "Slug", 120) || title));
  const id = newId();
  const metaTitle = blogText(b.metaTitle, "SEO title", BLOG_LIMITS.metaTitle) || title.slice(0, BLOG_LIMITS.metaTitle);
  const metaDescription =
    blogText(b.metaDescription, "SEO description", BLOG_LIMITS.metaDescription) ||
    (excerpt || blogPlainText(content)).slice(0, BLOG_LIMITS.metaDescription) || null;
  if (
    b.publishedAt !== undefined &&
    b.publishedAt !== null &&
    (typeof b.publishedAt !== "number" || !Number.isFinite(b.publishedAt))
  ) {
    throw httpsError("invalid-argument", "Published date must be a timestamp or null.");
  }
  const publishedAt =
    typeof b.publishedAt === "number" && Number.isFinite(b.publishedAt)
      ? b.publishedAt
      : status === "published"
        ? ts
        : null;

  await db.insert(schema.blogPosts).values({
    id,
    slug,
    title,
    excerpt,
    content,
    coverImageUrl,
    category,
    tags,
    author,
    status,
    metaTitle,
    metaDescription,
    source: "admin",
    originalUrl: null,
    viewCount: 0,
    publishedAt,
    createdAt: ts,
    updatedAt: ts,
  });
  await invalidateBlogReadCache(c, id, slug);
  await logAudit(c, "blog.create", "blog_post", id, { title, slug, status });
  return c.json({ success: true as const, id, slug });
});

// Read a single post (with content) for the edit form.
adminRoute.get("/blog/:id", async (c) => {
  const db = getDb(c.env);
  const row = await db.select().from(schema.blogPosts).where(eq(schema.blogPosts.id, c.req.param("id"))).get();
  if (!row) throw httpsError("not-found", "Post not found.");
  return c.json(row);
});

// Update a post. Omitted fields are preserved; supplied fields are normalized.
adminRoute.patch("/blog/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const b = await c.req.json<any>().catch(() => {
    throw httpsError("invalid-argument", "A JSON request body is required.");
  });
  const current = await db.select().from(schema.blogPosts).where(eq(schema.blogPosts.id, id)).get();
  if (!current) throw httpsError("not-found", "Post not found.");
  if (b.expectedUpdatedAt !== undefined) {
    if (typeof b.expectedUpdatedAt !== "number" || !Number.isFinite(b.expectedUpdatedAt)) {
      throw httpsError("invalid-argument", "expectedUpdatedAt must be a timestamp.");
    }
    if (b.expectedUpdatedAt !== current.updatedAt) {
      throw httpsError("failed-precondition", "This post changed after you opened it. Close and reopen the editor before saving.");
    }
  }

  const set: any = { updatedAt: now() };
  if (b.title !== undefined) set.title = blogText(b.title, "Title", BLOG_LIMITS.title, { required: true });
  if (b.excerpt !== undefined) set.excerpt = blogText(b.excerpt, "Excerpt", BLOG_LIMITS.excerpt);
  if (b.content !== undefined) set.content = blogText(b.content, "Content", BLOG_LIMITS.content, { preserveWhitespace: true });
  if (b.coverImageUrl !== undefined) set.coverImageUrl = blogUrl(b.coverImageUrl, "Cover image URL");
  if (b.category !== undefined) set.category = blogText(b.category, "Category", BLOG_LIMITS.category);
  if (b.tags !== undefined) set.tags = blogTags(b.tags);
  if (b.author !== undefined) set.author = blogText(b.author, "Author", BLOG_LIMITS.author, { required: true });
  if (b.status !== undefined) set.status = blogStatus(b.status);
  if (b.publishedAt !== undefined) {
    if (b.publishedAt !== null && (typeof b.publishedAt !== "number" || !Number.isFinite(b.publishedAt))) {
      throw httpsError("invalid-argument", "Published date must be a timestamp or null.");
    }
    set.publishedAt = b.publishedAt;
  }

  const finalTitle = set.title ?? current.title;
  const finalExcerpt = set.excerpt !== undefined ? set.excerpt : current.excerpt;
  const finalContent = set.content !== undefined ? set.content : current.content;
  const finalStatus = set.status ?? current.status ?? "draft";
  if (b.content !== undefined || b.status !== undefined) {
    validatePublishedBlog(finalStatus, finalContent);
  }

  if (b.metaTitle !== undefined) {
    set.metaTitle = blogText(b.metaTitle, "SEO title", BLOG_LIMITS.metaTitle) || finalTitle.slice(0, BLOG_LIMITS.metaTitle);
  } else if (!current.metaTitle) {
    set.metaTitle = finalTitle.slice(0, BLOG_LIMITS.metaTitle);
  }
  if (b.metaDescription !== undefined) {
    set.metaDescription =
      blogText(b.metaDescription, "SEO description", BLOG_LIMITS.metaDescription) ||
      (finalExcerpt || blogPlainText(finalContent)).slice(0, BLOG_LIMITS.metaDescription) || null;
  } else if (!current.metaDescription) {
    set.metaDescription = (finalExcerpt || blogPlainText(finalContent)).slice(0, BLOG_LIMITS.metaDescription) || null;
  }

  // Regenerate the permalink only when explicitly requested.
  if (b.slug !== undefined) {
    const requestedSlug = blogText(b.slug, "Slug", 120, { required: true })!;
    set.slug = await uniqueBlogSlug(db, slugify(requestedSlug), id);
  }
  if (
    finalStatus === "published" &&
    current.status !== "published" &&
    (set.publishedAt === null || set.publishedAt === undefined)
  ) {
    set.publishedAt = now();
  }

  await db.update(schema.blogPosts).set(set).where(eq(schema.blogPosts.id, id));
  const finalSlug = set.slug || current.slug;
  await invalidateBlogReadCache(c, id, current.slug, finalSlug);
  await logAudit(c, "blog.update", "blog_post", id, {
    title: finalTitle,
    slug: finalSlug,
    status: finalStatus,
    fields: Object.keys(b),
  });
  return c.json({ message: "Post updated", id, slug: finalSlug });
});

// Delete a post.
adminRoute.delete("/blog/:id", async (c) => {
  const db = getDb(c.env);
  const id = c.req.param("id");
  const current = await db
    .select({ id: schema.blogPosts.id, slug: schema.blogPosts.slug, title: schema.blogPosts.title })
    .from(schema.blogPosts)
    .where(eq(schema.blogPosts.id, id))
    .get();
  if (!current) throw httpsError("not-found", "Post not found.");
  await db.delete(schema.blogPosts).where(eq(schema.blogPosts.id, id));
  await invalidateBlogReadCache(c, id, current.slug);
  await logAudit(c, "blog.delete", "blog_post", id, { title: current.title, slug: current.slug });
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
  //
  // `revenue` is COINS SOLD (that is what payments.amount has always held, and
  // what the dashboard card is labelled). `revenueInr` is the actual money.
  const money = await db
    .select({
      coins: sql<number>`COALESCE(SUM(COALESCE(${schema.payments.coins}, ${schema.payments.amount})),0)`,
      paise: sql<number>`COALESCE(SUM(${schema.payments.amountPaise}),0)`,
    })
    .from(schema.payments)
    .where(eq(schema.payments.status, "success"))
    .get();
  const revenue = Number(money?.coins ?? 0);
  const revenueInr = roundFiat(Number(money?.paise ?? 0) / 100);
  const activeMatches =
    (await db.select({ v: count() }).from(schema.contestMatches).where(eq(schema.contestMatches.status, "active")).get())?.v ?? 0;
  const liveContests =
    (await db.select({ v: count() }).from(schema.contests).where(eq(schema.contests.status, "live")).get())?.v ?? 0;
  const pendingWithdrawals =
    (await db.select({ v: count() }).from(schema.withdrawals).where(eq(schema.withdrawals.status, "pending")).get())?.v ?? 0;
  const pendingDeposits =
    (await db.select({ v: count() }).from(schema.deposits).where(eq(schema.deposits.status, "pending")).get())?.v ?? 0;
  return c.json({ users, posts, reports, support, revenue, revenueInr, activeMatches, liveContests, pendingWithdrawals, pendingDeposits });
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
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10), 0);
  const conds: any[] = [];
  if (q.length >= 2) {
    const term = `%${q}%`;
    conds.push(
      or(
        like(sql`lower(${schema.users.username})`, term),
        like(sql`lower(${schema.users.fullName})`, term),
        like(sql`lower(${schema.users.email})`, term),
      ),
    );
  }
  const rows = await db
    .select()
    .from(schema.users)
    .where(conds.length ? and(...conds) : (undefined as any))
    .orderBy(desc(schema.users.createdAt))
    .limit(limit)
    .offset(offset)
    .all();
  if (rows.length === limit) c.header("X-Next-Offset", String(offset + limit));
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
  const rows = await db
    .select({
      id: schema.contests.id,
      title: schema.contests.title,
      type: schema.contests.type,
      status: schema.contests.status,
      bannerUrl: schema.contests.bannerUrl,
      totalEntryFee: schema.contests.totalEntryFee,
      rewardCoins: schema.contests.rewardCoins,
      voteDurationDays: schema.contests.voteDurationDays,
      autoCancelHours: schema.contests.autoCancelHours,
      minVotes: schema.contests.minVotes,
      startsAt: schema.contests.startsAt,
      endsAt: schema.contests.endsAt,
      extra: schema.contests.extra,
      createdBy: schema.contests.createdBy,
      createdAt: schema.contests.createdAt,
      totalMatches: count(schema.contestMatches.id),
      waitingMatches: sql<number>`COALESCE(SUM(CASE WHEN ${schema.contestMatches.status} = 'waiting_for_opponent' THEN 1 ELSE 0 END), 0)`,
      activeMatches: sql<number>`COALESCE(SUM(CASE WHEN ${schema.contestMatches.status} = 'active' THEN 1 ELSE 0 END), 0)`,
    })
    .from(schema.contests)
    .leftJoin(schema.contestMatches, eq(schema.contestMatches.contestId, schema.contests.id))
    .groupBy(schema.contests.id)
    .orderBy(desc(schema.contests.createdAt))
    .all();

  return c.json(rows.map((row) => {
    const extra = isRecord(row.extra) ? row.extra : {};
    return {
      id: row.id,
      title: row.title,
      name: row.title,
      type: row.type,
      status: row.status,
      // Fall back only for legacy rows; any subsequent edit migrates this URL
      // into the canonical physical column and removes stale extra aliases.
      bannerUrl: row.bannerUrl ?? (
        typeof extra.bannerUrl === "string"
          ? extra.bannerUrl
          : typeof extra.bannerImageUrl === "string"
            ? extra.bannerImageUrl
            : null
      ),
      totalEntryFee: row.totalEntryFee,
      entryFishCoins: row.totalEntryFee,
      rewardCoins: row.rewardCoins,
      prizePool: row.rewardCoins,
      voteDurationDays: row.voteDurationDays,
      autoCancelHours: row.autoCancelHours,
      minVotes: row.minVotes,
      startsAt: row.startsAt ?? null,
      endsAt: row.endsAt ?? null,
      description: typeof extra.description === "string" ? extra.description : null,
      rules: typeof extra.rules === "string" ? extra.rules : null,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      totalMatches: Number(row.totalMatches ?? 0),
      waitingMatches: Number(row.waitingMatches ?? 0),
      activeMatches: Number(row.activeMatches ?? 0),
    };
  }));
});

// ======================= ADMIN NOTIFICATIONS =======================
/**
 * Notifications visible to the caller.
 *
 * The feed carries financial events (payout requests, refund clawbacks,
 * chargebacks, cron failures) which name users and amounts. Moderators have
 * panel access for content moderation only, so they see moderation-scoped
 * notifications and nothing else — filtered rather than 403'd, so the bell in
 * the panel layout keeps working for them.
 */
adminRoute.get("/notifications", async (c) => {
  const db = getDb(c.env);
  const scopes = isFullAdmin(c) ? ["finance", "moderation"] : ["moderation"];
  const rows = await db
    .select()
    .from(schema.adminNotifications)
    .where(inArray(schema.adminNotifications.scope, scopes))
    .orderBy(desc(schema.adminNotifications.createdAt))
    .limit(10)
    .all();
  return c.json(rows.map((n) => ({ ...n, isRead: !!n.isRead })));
});

adminRoute.post("/notifications/read", async (c) => {
  const db = getDb(c.env);
  // Only mark read what the caller was allowed to see.
  const scopes = isFullAdmin(c) ? ["finance", "moderation"] : ["moderation"];
  await db
    .update(schema.adminNotifications)
    .set({ isRead: true })
    .where(and(
      eq(schema.adminNotifications.isRead, false),
      inArray(schema.adminNotifications.scope, scopes),
    ));
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

// Create a contest template (used by seed-contests and the admin panel).
adminRoute.post("/contests", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const body = await c.req.json<unknown>();
  const { values } = validateContestInput(body, true);
  if (!values.bannerUrl) throw httpsError("failed-precondition", "A banner is required for a new contest.");
  // A prize larger than the pot the two players fund would mint coins on every
  // settled match. Enforced here and on PATCH against the MERGED values.
  assertPrizeFundedByPot(values.totalEntryFee, values.rewardCoins);
  assertContestWindow(values.startsAt, values.endsAt, { requireFuture: true });

  const id = newId();
  const user = c.get("user");
  const createdBy = user?.uid || user?.email || "server";
  const extra = createContestExtra(body as Record<string, any>, values);
  const createdAt = now();
  await db.insert(schema.contests).values({
    id,
    title: values.title,
    type: values.type,
    status: values.status,
    totalEntryFee: values.totalEntryFee,
    rewardCoins: values.rewardCoins,
    voteDurationDays: values.voteDurationDays,
    autoCancelHours: values.autoCancelHours,
    minVotes: values.minVotes,
    bannerUrl: values.bannerUrl,
    startsAt: values.startsAt,
    endsAt: values.endsAt,
    extra,
    createdBy,
    createdAt,
  });
  await invalidateContestCaches(c.env, id);
  await logAudit(c, "contest.create", "contest", id, { ...values, createdBy, createdAt });
  return c.json({ success: true, contestId: id, id });
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
  // Full admins only: the coin ledger for every user.
  requireFullAdmin(c);
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
  // Full admins only: ledger metadata.
  requireFullAdmin(c);
  const db = getDb(c.env);
  const rows = await db.select({ type: schema.coinTransactions.type }).from(schema.coinTransactions).groupBy(schema.coinTransactions.type).all();
  return c.json(rows.map((r) => r.type).filter(Boolean));
});

/**
 * Revenue analytics.
 *
 * IMPORTANT: money and coins are different units and are now reported as such.
 * `payments.amount` holds COINS (it always did), so summing it and calling the
 * result `totalRevenue` reported a coin count as rupees — every ₹ figure in the
 * admin panel was wrong. Revenue is read from `payments.amount_paise`, the actual
 * amount charged, in integer paise.
 *
 * Refunded and disputed payments are excluded from revenue, which is only
 * possible now that the clawback path marks them.
 */
adminRoute.get("/revenue", async (c) => {
  // Full admins only: revenue and top spenders.
  requireFullAdmin(c);
  const db = getDb(c.env);
  const successful = eq(schema.payments.status, "success");

  const totals = await db
    .select({
      paise: sql<number>`COALESCE(SUM(${schema.payments.amountPaise}),0)`,
      coins: sql<number>`COALESCE(SUM(COALESCE(${schema.payments.coins}, ${schema.payments.amount})),0)`,
      n: count(),
      // Rows predating the split have no fiat value recorded. Surfacing the count
      // is more honest than silently under-reporting revenue.
      unpriced: sql<number>`SUM(CASE WHEN ${schema.payments.amountPaise} IS NULL THEN 1 ELSE 0 END)`,
    })
    .from(schema.payments)
    .where(successful)
    .get();

  const reversed = await db
    .select({
      paise: sql<number>`COALESCE(SUM(${schema.payments.amountPaise}),0)`,
      n: count(),
    })
    .from(schema.payments)
    .where(inArray(schema.payments.status, ["refunded", "disputed"]))
    .get();

  const coinsInCirculation =
    (await db.select({ v: sql<number>`COALESCE(SUM(${schema.users.dpcoin}),0)` }).from(schema.users).get())?.v ?? 0;

  const byType = await db
    .select({ type: schema.coinTransactions.type, total: sql<number>`COALESCE(SUM(${schema.coinTransactions.amount}),0)`, n: count() })
    .from(schema.coinTransactions)
    .groupBy(schema.coinTransactions.type)
    .all();

  // Last 14 days, bucketed by day (UTC). Both units are returned so the panel
  // can label each correctly instead of guessing.
  const since = now() - 14 * 86400000;
  const recentPayments = await db
    .select({
      paise: schema.payments.amountPaise,
      coins: schema.payments.coins,
      legacyAmount: schema.payments.amount,
      createdAt: schema.payments.createdAt,
    })
    .from(schema.payments)
    .where(and(successful, gte(schema.payments.createdAt, since)))
    .all();
  const dayMap: Record<string, { paise: number; coins: number }> = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now() - i * 86400000).toISOString().slice(0, 10);
    dayMap[d] = { paise: 0, coins: 0 };
  }
  for (const p of recentPayments) {
    const d = new Date(p.createdAt).toISOString().slice(0, 10);
    if (!dayMap[d]) continue;
    dayMap[d].paise += Number(p.paise) || 0;
    dayMap[d].coins += Number(p.coins ?? p.legacyAmount) || 0;
  }
  const trend = Object.entries(dayMap).map(([date, v]) => ({
    date,
    revenueInr: roundFiat(v.paise / 100),
    coins: v.coins,
    // Legacy field name kept for the existing chart; now genuinely rupees.
    amount: roundFiat(v.paise / 100),
  }));

  const topSpenders = await db
    .select({
      userId: schema.payments.userId,
      totalInr: sql<number>`COALESCE(SUM(${schema.payments.amountPaise}),0)`,
      totalCoins: sql<number>`COALESCE(SUM(COALESCE(${schema.payments.coins}, ${schema.payments.amount})),0)`,
      username: schema.users.username,
      fullName: schema.users.fullName,
    })
    .from(schema.payments)
    .leftJoin(schema.users, eq(schema.users.uid, schema.payments.userId))
    .where(successful)
    .groupBy(schema.payments.userId)
    .orderBy(desc(sql`SUM(${schema.payments.amountPaise})`))
    .limit(10)
    .all();

  const grossPaise = Number(totals?.paise ?? 0);
  const refundedPaise = Number(reversed?.paise ?? 0);
  return c.json({
    // Money (rupees).
    totalRevenue: roundFiat(grossPaise / 100),
    grossRevenueInr: roundFiat(grossPaise / 100),
    refundedInr: roundFiat(refundedPaise / 100),
    netRevenueInr: roundFiat((grossPaise - refundedPaise) / 100),
    refundedCount: Number(reversed?.n ?? 0),
    // Coins (not money).
    coinsSold: Number(totals?.coins ?? 0),
    coinsInCirculation,
    // Data-quality signal for pre-migration rows with no recorded fiat amount.
    paymentsWithoutRecordedAmount: Number(totals?.unpriced ?? 0),
    paymentCount: Number(totals?.n ?? 0),
    byType,
    trend,
    topSpenders: topSpenders.map((s) => ({
      ...s,
      totalInr: roundFiat(Number(s.totalInr) / 100),
      // Legacy field the panel already renders.
      total: roundFiat(Number(s.totalInr) / 100),
    })),
  });
});

// Raw payment (top-up) list.
adminRoute.get("/payments", async (c) => {
  // Full admins only: individual payment records.
  requireFullAdmin(c);
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
  if (m.status !== "active") throw httpsError("failed-precondition", "Only an active match can have a winner declared.");
  const userA = m.userA as any;
  const userB = m.userB as any;
  if (!userA?.uid || !userB?.uid) throw httpsError("failed-precondition", "Match has no opponents to judge.");

  const requestedWinnerUid = body.winnerUid == null ? null : String(body.winnerUid);
  if (requestedWinnerUid && requestedWinnerUid !== userA.uid && requestedWinnerUid !== userB.uid) {
    throw httpsError("invalid-argument", "winnerUid must be one of the two participants.");
  }

  // Validate every client-supplied field before permanently closing the actor.
  const t = await finalizeVotes(c.env, id, userA.uid, userB.uid, Number(m.expiresAt || 0), true);
  const votesA = t.votesA;
  const votesB = t.votesB;

  const winnerUid: string = requestedWinnerUid || (votesA >= votesB ? userA.uid : userB.uid);
  const loserUid = winnerUid === userA.uid ? userB.uid : userA.uid;

  // Pay the prize snapshotted on the match, clamped to the pot the two players
  // funded — identical rule to the cron resolver, so a manual declaration can
  // never pay more than an automatic one.
  const pot = matchPot(m.entryFee);
  let rewardAmount = m.prizeCoins == null ? null : Math.min(Number(m.prizeCoins), pot);
  if (rewardAmount == null) {
    if (m.contestId) {
      const contest = await db.select({ reward: schema.contests.rewardCoins }).from(schema.contests).where(eq(schema.contests.id, m.contestId)).get();
      rewardAmount = Math.min(Number(contest?.reward ?? pot), pot);
    } else {
      rewardAmount = pot;
    }
  }

  const ts = now();
  const settled = await settleWinner(c.env, {
    matchId: id,
    contestId: m.contestId,
    expectedStatus: "active",
    winnerUid,
    loserUid,
    rewardAmount,
    description: `Admin-declared victory for "${m.title}"`,
    completedAt: ts,
  });
  if (!settled) throw httpsError("failed-precondition", "Match was already resolved.");

  // Flip any live feed card to its winner/result view without a refetch.
  await publish(c.env, `match:${id}`, {
    type: "match_status",
    status: "completed",
    votesA,
    votesB,
    totalVotes: votesA + votesB,
    winnerUid,
  });

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
  if (m.status !== "active" && m.status !== "waiting_for_opponent") {
    throw httpsError("failed-precondition", "Only an active or waiting match can be cancelled.");
  }
  const userA = m.userA as any;
  const userB = m.userB as any;
  if (m.status === "active") {
    if (!userA?.uid || !userB?.uid) {
      throw httpsError("failed-precondition", "Active match participants are incomplete.");
    }
    // Close first so a vote already in flight cannot land after cancellation.
    await finalizeVotes(c.env, id, userA.uid, userB.uid, Number(m.expiresAt || 0), true);
  } else if (!userA?.uid) {
    throw httpsError("failed-precondition", "Waiting match creator is missing.");
  }

  const ts = now();
  const participants = [userA, userB].filter((u) => u?.uid).map((u) => String(u.uid));
  const settled = await settleRefund(c.env, {
    matchId: id,
    contestId: m.contestId,
    expectedStatus: m.status as "active" | "waiting_for_opponent",
    finalStatus: "cancelled",
    participantUids: participants,
    // Refund exactly what each player was charged (whole coins, floored).
    refundPerUser: perPlayerEntryFee(m.entryFee),
    description: `Admin cancelled "${m.title}" — entry fee refunded`,
    completedAt: ts,
  });
  if (!settled) throw httpsError("failed-precondition", "Match could not be cancelled.");
  for (const u of [userA, userB]) {
    if (u?.uid) await createNotification(c.env, u.uid, { title: "Battle Cancelled", body: `The battle "${m.title}" was cancelled by an admin and your entry fee was refunded.`, type: "contest-refund", targetId: "wallet" });
  }
  await logAudit(c, "match.cancel", "match", id, {
    refundPerUser: perPlayerEntryFee(m.entryFee),
    participants: participants.length,
  });
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

/**
 * Networks that voted for the SAME entry under many accounts within one match.
 *
 * The IP was never recorded before, so this class of collusion — a farm rotating
 * device ids but sharing an uplink — was invisible.
 *
 * Read this as a signal, not proof: carrier NAT legitimately puts thousands of
 * unrelated users behind one address, which is exactly why the vote path does not
 * BLOCK on IP. What is suspicious is many accounts from one address converging on
 * one entry in one match, so the grouping is per (match, ip, votedFor).
 */
adminRoute.get("/fraud/vote-networks", async (c) => {
  // Full admins only: exposes voter IP addresses.
  requireFullAdmin(c);
  const db = getDb(c.env);
  const minAccounts = Math.min(Math.max(parseInt(c.req.query("minAccounts") || "3", 10), 2), 50);
  const rows = await db
    .select({
      matchId: schema.votes.matchId,
      ip: schema.votes.ip,
      votedForUid: schema.votes.votedForUid,
      accounts: sql<number>`COUNT(DISTINCT ${schema.votes.voterUid})`,
      devices: sql<number>`COUNT(DISTINCT ${schema.votes.deviceId})`,
      totalVotes: count(),
    })
    .from(schema.votes)
    .where(sql`${schema.votes.ip} IS NOT NULL AND ${schema.votes.ip} != ''`)
    .groupBy(schema.votes.matchId, schema.votes.ip, schema.votes.votedForUid)
    .having(sql`COUNT(DISTINCT ${schema.votes.voterUid}) >= ${minAccounts}`)
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
  // A re-submitted broadcast used to fan out to every user a second time. With
  // an Idempotency-Key header the retry is rejected instead.
  const idem = await enforceAdminIdempotency(c, "broadcast");
  try {
    // Queued and drained by cron — see lib/broadcast.ts for why this is not sent
    // inline. `recipients` is the estimated audience.
    const { jobId, estimatedRecipients } = await enqueueBroadcast(c.env, {
      title,
      body,
      image: image || undefined,
      segment,
      createdBy: c.get("user")?.uid ?? null,
    });
    await logAudit(c, "notification.broadcast", "broadcast", jobId, {
      title,
      recipients: estimatedRecipients,
      segment,
    });
    return c.json({ success: true, jobId, recipients: estimatedRecipients, queued: true });
  } catch (e) {
    await idem?.finish(false);
    throw e;
  }
});

// ======================= COMMENTS MODERATION =======================
// Recent comments (with author + optional ?postId= filter).
//
// `?target=blog` switches to `blog_comments`. Blog comments NEED a moderation
// surface more than app-feed ones do, because they sit on pages that search
// engines index: spam there is not just visible to followers, it is published.
// The two are separate lists rather than a merged feed so the "Post" column
// keeps a single meaning and a delete can never hit the wrong table.
adminRoute.get("/comments", async (c) => {
  const db = getDb(c.env);
  const postId = c.req.query("postId");
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 300);
  if (c.req.query("target") === "blog") {
    const rows = await db
      .select({
        id: schema.blogComments.id,
        postId: schema.blogComments.postId,
        userId: schema.blogComments.userId,
        text: schema.blogComments.text,
        likeCount: schema.blogComments.likeCount,
        createdAt: schema.blogComments.createdAt,
        username: schema.users.username,
        fullName: schema.users.fullName,
        // The article title/slug, so a moderator can see WHAT was commented on
        // instead of an opaque id — and can open the public page to check context.
        postTitle: schema.blogPosts.title,
        postSlug: schema.blogPosts.slug,
      })
      .from(schema.blogComments)
      .leftJoin(schema.users, eq(schema.users.uid, schema.blogComments.userId))
      .leftJoin(schema.blogPosts, eq(schema.blogPosts.id, schema.blogComments.postId))
      .where(postId ? eq(schema.blogComments.postId, postId) : (undefined as any))
      .orderBy(desc(schema.blogComments.createdAt))
      .limit(limit)
      .all();
    return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null })));
  }
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
  if (c.req.query("target") === "blog") {
    const row = await db.select({ postId: schema.blogComments.postId }).from(schema.blogComments).where(eq(schema.blogComments.id, id)).get();
    await db.delete(schema.blogComments).where(eq(schema.blogComments.id, id));
    // Drop the cached thread, otherwise the removed comment stays on the public
    // page for the rest of the TTL — the one place a moderator expects a delete
    // to be immediate, since anyone can be looking at that url.
    if (row?.postId) await delCache(c.env, commentsCacheKey("blog", row.postId));
    await logAudit(c, "blogComment.delete", "blogComment", id);
    return c.json({ message: "Comment deleted" });
  }
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
  // Full admins only: payout PII (bank / UPI details).
  requireFullAdmin(c);
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
      payoutRef: schema.withdrawals.payoutRef,
      paidAt: schema.withdrawals.paidAt,
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
 * Allowed withdrawal status transitions. `paid` and `rejected` are terminal.
 *
 * This table is load-bearing, not documentation. Without it a `reserved` row
 * could be rejected (coins refunded) and then marked paid — the `w.reserved`
 * branch performs no deduction — leaving the user with their coins AND the
 * payout. It matches the buttons the admin panel actually renders:
 * pending → Approve/Reject, approved → Mark as paid.
 */
const WITHDRAWAL_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ["approved", "rejected"],
  approved: ["paid", "rejected"],
  paid: [],
  rejected: [],
};

/**
 * Action a withdrawal request. action: "approve" | "reject" | "paid".
 *
 * Coins are deducted (held) when moving to approved/paid; a rejection of a
 * still-held request refunds the coins. The user's balance is validated on
 * approval so we never approve more than they hold.
 *
 * Concurrency: the status is claimed with a compare-and-swap BEFORE any money
 * moves, so a double-clicked Reject or two admins acting at once cannot both
 * observe `pending` and both issue a refund.
 */
adminRoute.patch("/withdrawals/:id", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const { action, adminNote, payoutRef } = await c.req.json<any>();
  if (!["approve", "reject", "paid"].includes(action)) throw httpsError("invalid-argument", "Invalid action.");
  const w = await db.select().from(schema.withdrawals).where(eq(schema.withdrawals.id, id)).get();
  if (!w) throw httpsError("not-found", "Withdrawal not found.");
  const admin = c.get("user");
  const ts = now();

  const status = action === "approve" ? "approved" : action === "paid" ? "paid" : "rejected";
  const fromStatus = w.status;

  if (!(WITHDRAWAL_TRANSITIONS[fromStatus] ?? []).includes(status))
    throw httpsError(
      "failed-precondition",
      `Cannot ${action} a withdrawal that is already "${fromStatus}".`,
    );

  // Payouts are executed by hand in the banking app, so "we marked it paid" and
  // "the bank actually sent it" were two facts with nothing linking them. A bank
  // reference (UTR / RRN / NEFT ref) is now REQUIRED to mark a payout paid, which
  // makes every outgoing rupee reconcilable against a statement.
  let payoutReference: string | null = null;
  if (action === "paid") {
    payoutReference = String(payoutRef ?? "").trim();
    if (payoutReference.length < 4 || payoutReference.length > 64 || !/^[A-Za-z0-9._/-]+$/.test(payoutReference)) {
      throw httpsError(
        "invalid-argument",
        "A bank payout reference (UTR / RRN, 4–64 characters) is required to mark a payout as paid.",
      );
    }
    // The same reference must not be recorded against two payouts.
    const dupe = await db
      .select({ id: schema.withdrawals.id })
      .from(schema.withdrawals)
      .where(and(eq(schema.withdrawals.payoutRef, payoutReference), ne(schema.withdrawals.id, id)))
      .get();
    if (dupe) {
      throw httpsError("already-exists", `That payout reference is already recorded on withdrawal ${dupe.id}.`);
    }
  }

  // Atomic claim: flip the status only if it is STILL the value we just read.
  // The loser of this compare-and-swap does no accounting at all. Same pattern
  // as the exactly-once coin credit in lib/coinOrders.ts.
  const claim = await db
    .update(schema.withdrawals)
    .set({
      status,
      adminNote: adminNote || w.adminNote,
      processedBy: admin?.uid ?? null,
      payoutRef: payoutReference ?? w.payoutRef,
      paidAt: action === "paid" ? ts : w.paidAt,
      updatedAt: ts,
    })
    .where(and(eq(schema.withdrawals.id, id), eq(schema.withdrawals.status, fromStatus)))
    .run();
  if (claim.meta.changes === 0)
    throw httpsError(
      "failed-precondition",
      "This withdrawal was just actioned by someone else. Reload and try again.",
    );

  /** Undo the claim so a failed accounting step doesn't strand the row. */
  const revertClaim = async () => {
    await db
      .update(schema.withdrawals)
      .set({
        status: fromStatus,
        adminNote: w.adminNote,
        processedBy: w.processedBy,
        payoutRef: w.payoutRef,
        paidAt: w.paidAt,
        updatedAt: w.updatedAt,
      })
      .where(and(eq(schema.withdrawals.id, id), eq(schema.withdrawals.status, status)))
      .run();
  };

  // Coin accounting depends on WHEN the coins were held:
  //   * reserved rows (new model): coins were already deducted at request time,
  //     so approving/paying does NOT deduct again; a rejection refunds them.
  //   * legacy rows (reserved = false, created before the escrow model): coins
  //     are deducted here on approval and refunded only on a reject-from-approved.
  try {
    if (w.reserved) {
      // Refund on rejection of a still-held request. The transition table
      // guarantees fromStatus is "pending" or "approved" here.
      if (action === "reject") {
        await refundRejectedWithdrawal(c.env, id, w.userId, w.amount, ts);
      }
      // Settle the hold when the money actually leaves.
      //
      // The `withdrawal_hold` debit written at request time was never resolved:
      // marking a reserved payout paid wrote NO ledger row at all, so the ledger
      // carried a permanently dangling hold and could not be reconciled against
      // a bank statement. This closes it with a zero-sum pair (release the hold,
      // record the settled payout) so the balance is unchanged — the coins left
      // at request time — while the ledger tells the true story.
      if (action === "paid") {
        await db.batch([
          db.insert(schema.coinTransactions).values({
            id: `withdrawal_hold_release:${id}`,
            uid: w.userId,
            amount: w.amount,
            type: "withdrawal_hold_release",
            description: "Payout hold released on settlement",
            createdAt: ts,
          }).onConflictDoNothing(),
          db.insert(schema.coinTransactions).values({
            id: `withdrawal_settled:${id}`,
            uid: w.userId,
            amount: -w.amount,
            type: "withdrawal",
            description: `Payout sent (${w.method}) — ref ${payoutReference}`,
            createdAt: ts,
          }).onConflictDoNothing(),
        ]);
      }
    } else {
      // Legacy rows are deducted on approval. `paid` can now only be reached
      // from `approved`, where the deduction already happened.
      if (action === "approve") {
        // Deduct and ledger in ONE transaction. These were two separate writes,
        // so a failure between them moved a balance with no ledger row. Both
        // statements test the same pre-transaction balance snapshot (the INSERT
        // runs first and does not touch `users`), so they cannot disagree.
        const solvent = `EXISTS (SELECT 1 FROM users WHERE uid = ? AND dpcoin >= ?)`;
        const legacyResults = await c.env.DB.batch([
          c.env.DB.prepare(
            `INSERT OR IGNORE INTO coin_transactions
               (id, uid, amount, type, description, created_at)
             SELECT ?, ?, ?, 'withdrawal', ?, ?
              WHERE ${solvent}`,
          ).bind(
            `withdrawal_legacy:${id}`,
            w.userId,
            -w.amount,
            `Payout ${status} (${w.method})`,
            ts,
            w.userId,
            w.amount,
          ),
          c.env.DB.prepare(
            `UPDATE users SET dpcoin = dpcoin - ?, updated_at = ? WHERE uid = ? AND dpcoin >= ?`,
          ).bind(w.amount, ts, w.userId, w.amount),
        ]);
        if (Number(legacyResults[1]?.meta?.changes || 0) === 0) {
          await revertClaim();
          throw httpsError("failed-precondition", "User has insufficient balance for this payout.");
        }
      }
      // Rejecting a previously-approved legacy request refunds the held coins.
      if (action === "reject" && fromStatus === "approved") {
        await refundRejectedWithdrawal(c.env, id, w.userId, w.amount, ts);
      }
    }
  } catch (err) {
    // Insufficient-balance already reverted and is a clean precondition failure.
    if (err instanceof ApiError) throw err;
    await revertClaim();
    throw err;
  }

  await createNotification(c.env, w.userId, {
    title: action === "reject" ? "Withdrawal Rejected" : action === "paid" ? "Payout Sent 💸" : "Withdrawal Approved",
    body: action === "reject" ? `Your payout request was rejected. ${adminNote ? "Reason: " + adminNote : ""}` : action === "paid" ? `Your payout of ${w.amount} Dpcoins has been sent.` : "Your payout request was approved and is being processed.",
    type: "withdrawal",
    targetId: "wallet",
  });
  await logAudit(c, `withdrawal.${action}`, "withdrawal", id, {
    amount: w.amount,
    from: fromStatus,
    to: status,
    reserved: w.reserved,
  });
  return c.json({ message: `Withdrawal ${status}` });
});

// ======================= DEPOSITS (manual QR/UPI top-ups) =======================
adminRoute.get("/deposits", async (c) => {
  // Full admins only: deposit records and UTRs.
  requireFullAdmin(c);
  const db = getDb(c.env);
  const status = c.req.query("status");
  const conds: any[] = [];
  if (status) conds.push(eq(schema.deposits.status, status));
  const rows = await db
    .select({
      id: schema.deposits.id,
      userId: schema.deposits.userId,
      amount: schema.deposits.amount,
      payAmount: schema.deposits.payAmount,
      bonusCoins: schema.deposits.bonusCoins,
      method: schema.deposits.method,
      utr: schema.deposits.utr,
      screenshotUrl: schema.deposits.screenshotUrl,
      status: schema.deposits.status,
      adminNote: schema.deposits.adminNote,
      createdAt: schema.deposits.createdAt,
      updatedAt: schema.deposits.updatedAt,
      username: schema.users.username,
      fullName: schema.users.fullName,
    })
    .from(schema.deposits)
    .leftJoin(schema.users, eq(schema.users.uid, schema.deposits.userId))
    .where(conds.length ? and(...conds) : (undefined as any))
    .orderBy(desc(schema.deposits.createdAt))
    .limit(200)
    .all();
  // Flag UTRs that appear on more than one deposit (possible reuse / fraud).
  const dupRows = await db
    .select({ utr: schema.deposits.utr })
    .from(schema.deposits)
    .where(sql`${schema.deposits.utr} IS NOT NULL AND ${schema.deposits.utr} != ''`)
    .groupBy(schema.deposits.utr)
    .having(sql`COUNT(*) > 1`)
    .all();
  const dupSet = new Set(dupRows.map((r) => (r.utr || "").toLowerCase()));
  return c.json(
    rows.map((r) => ({
      ...r,
      duplicateUtr: !!r.utr && dupSet.has((r.utr || "").toLowerCase()),
      createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
      updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    })),
  );
});

// ======================= REFERRALS =======================
adminRoute.get("/referrals", async (c) => {
  // Full admins only: referral payouts.
  requireFullAdmin(c);
  const db = getDb(c.env);
  const referrer = alias(schema.users, "ref_user");
  const referred = alias(schema.users, "invited_user");
  const rows = await db
    .select({
      id: schema.referrals.id,
      referrerUid: schema.referrals.referrerUid,
      referredUid: schema.referrals.referredUid,
      bonus: schema.referrals.bonus,
      createdAt: schema.referrals.createdAt,
      referrerName: referrer.username,
      referredName: referred.username,
    })
    .from(schema.referrals)
    .leftJoin(referrer, eq(referrer.uid, schema.referrals.referrerUid))
    .leftJoin(referred, eq(referred.uid, schema.referrals.referredUid))
    .orderBy(desc(schema.referrals.createdAt))
    .limit(200)
    .all();
  return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null })));
});

// ======================= FINANCE TRENDS =======================
/**
 * 14-day daily series of approved deposits and paid/approved withdrawals.
 *
 * Deposits and withdrawals are reported in BOTH units. The previous version
 * summed `deposits.amount` and `withdrawals.amount` — both coin counts — and the
 * panel charted them as money. The rupee values live in `deposits.pay_amount`
 * (what the user transferred in) and `withdrawals.cash_amount` (what we pay out).
 */
adminRoute.get("/finance-trends", async (c) => {
  // Full admins only: financial trends.
  requireFullAdmin(c);
  const db = getDb(c.env);
  const since = now() - 14 * 86400000;
  const deps = await db
    .select({
      coins: schema.deposits.amount,
      inr: schema.deposits.payAmount,
      createdAt: schema.deposits.updatedAt,
    })
    .from(schema.deposits)
    .where(and(eq(schema.deposits.status, "approved"), gte(schema.deposits.updatedAt, since)))
    .all();
  const wds = await db
    .select({
      coins: schema.withdrawals.amount,
      inr: schema.withdrawals.cashAmount,
      status: schema.withdrawals.status,
      createdAt: schema.withdrawals.updatedAt,
    })
    .from(schema.withdrawals)
    .where(and(inArray(schema.withdrawals.status, ["approved", "paid"]), gte(schema.withdrawals.updatedAt, since)))
    .all();
  const days: string[] = [];
  const depMap: Record<string, { coins: number; inr: number }> = {};
  const wdMap: Record<string, { coins: number; inr: number }> = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now() - i * 86400000).toISOString().slice(0, 10);
    days.push(d);
    depMap[d] = { coins: 0, inr: 0 };
    wdMap[d] = { coins: 0, inr: 0 };
  }
  for (const r of deps) {
    const d = new Date(r.createdAt).toISOString().slice(0, 10);
    if (!depMap[d]) continue;
    depMap[d].coins += Number(r.coins) || 0;
    depMap[d].inr += Number(r.inr) || 0;
  }
  for (const r of wds) {
    const d = new Date(r.createdAt).toISOString().slice(0, 10);
    if (!wdMap[d]) continue;
    wdMap[d].coins += Number(r.coins) || 0;
    wdMap[d].inr += Number(r.inr) || 0;
  }
  return c.json(
    days.map((d) => ({
      date: d,
      // Legacy field names, now unambiguously RUPEES so the existing chart is
      // finally labelled correctly.
      deposits: roundFiat(depMap[d].inr),
      withdrawals: roundFiat(wdMap[d].inr),
      depositsInr: roundFiat(depMap[d].inr),
      withdrawalsInr: roundFiat(wdMap[d].inr),
      depositsCoins: depMap[d].coins,
      withdrawalsCoins: wdMap[d].coins,
    })),
  );
});

/**
 * Action a manual deposit. action: "approve" | "reject".
 * Approving credits the coins (users.dpcoin), records a payment + coin ledger
 * entry, and is idempotent via an atomic status claim (only a pending row is
 * ever credited, so double-approval can't double-credit).
 */
adminRoute.patch("/deposits/:id", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const { action, adminNote } = await c.req.json<any>();
  if (!["approve", "reject"].includes(action)) throw httpsError("invalid-argument", "Invalid action.");
  const d = await db.select().from(schema.deposits).where(eq(schema.deposits.id, id)).get();
  if (!d) throw httpsError("not-found", "Deposit not found.");
  if (d.status !== "pending") throw httpsError("failed-precondition", "Deposit is already processed.");
  const admin = c.get("user");
  const ts = now();
  const status = action === "approve" ? "approved" : "rejected";

  // Guard against crediting a UTR that was already credited on another deposit.
  // Submit-time blocking covers new requests; this catches any duplicate rows
  // that predate that check (or were created concurrently).
  if (action === "approve" && d.utr) {
    const already = await db
      .select({ id: schema.deposits.id })
      .from(schema.deposits)
      .where(and(sql`lower(${schema.deposits.utr}) = ${d.utr.toLowerCase()}`, eq(schema.deposits.status, "approved"), ne(schema.deposits.id, id)))
      .get();
    if (already) throw httpsError("failed-precondition", "This UTR was already credited on another deposit.");
  }

  // Atomically claim the pending row so overlapping approvals can't double-credit.
  const claim = await db
    .update(schema.deposits)
    .set({ status, adminNote: adminNote || null, processedBy: admin?.uid ?? null, updatedAt: ts })
    .where(and(eq(schema.deposits.id, id), eq(schema.deposits.status, "pending")))
    .run();
  if (claim.meta.changes === 0) throw httpsError("failed-precondition", "Deposit was already processed.");

  // `amount` already includes the package bonus; this just makes it visible in
  // the ledger and the notification so the user can see the offer was applied.
  const depBonus = Number(d.bonusCoins) || 0;
  const bonusSuffix = depBonus > 0 ? ` (incl. ${depBonus} bonus)` : "";

  if (action === "approve") {
    await db.batch([
      db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${d.amount}`, updatedAt: ts }).where(eq(schema.users.uid, d.userId)),
      db.insert(schema.payments).values({
        id: `dep_${id}`,
        userId: d.userId,
        // `amount` is the legacy coin column; the split fields record the coins
        // credited and the rupees actually transferred, so revenue reporting can
        // read real money instead of a coin count.
        amount: d.amount,
        coins: d.amount,
        amountPaise: toPaise(Number(d.payAmount) || 0),
        source: "manual_deposit",
        status: "success",
        createdAt: ts,
      }).onConflictDoNothing(),
      db.insert(schema.coinTransactions).values({ id: newId(), uid: d.userId, amount: d.amount, type: "manual_deposit", description: `Manual deposit approved${bonusSuffix} (UTR ${d.utr || "-"})`, createdAt: ts }),
    ]);
  }

  await createNotification(c.env, d.userId, {
    title: action === "approve" ? "Deposit Approved 🎉" : "Deposit Rejected",
    body: action === "approve" ? `${d.amount} coins have been added to your wallet${bonusSuffix}.` : `Your deposit request was rejected. ${adminNote ? "Reason: " + adminNote : ""}`,
    type: "deposit",
    targetId: "wallet",
  });
  await logAudit(c, `deposit.${action}`, "deposit", id, { amount: d.amount, utr: d.utr });
  return c.json({ message: `Deposit ${status}` });
});

// ======================= AUDIT LOG =======================
adminRoute.get("/audit-log", async (c) => {
  // Full admins only: the trail of admin actions, including actions taken against the caller.
  requireFullAdmin(c);
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


// ======================= ERROR LOGS (observability) =========================
// Server errors persisted from app.onError (src/lib/observability.ts) so admins
// can triage without the Cloudflare dashboard.
adminRoute.get("/logs", async (c) => {
  // Full admins only: server error logs, which can contain request context.
  requireFullAdmin(c);
  const db = getDb(c.env);
  const limit = Math.min(parseInt(c.req.query("limit") || "100", 10), 500);
  const level = c.req.query("level");
  const q = c.req.query("q");
  const conds: any[] = [];
  if (level) conds.push(eq(schema.errorLogs.level, level));
  if (q) conds.push(like(schema.errorLogs.message, `%${q}%`));
  const rows = await db
    .select()
    .from(schema.errorLogs)
    .where(conds.length ? and(...conds) : (undefined as any))
    .orderBy(desc(schema.errorLogs.createdAt))
    .limit(limit)
    .all();
  return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null })));
});

adminRoute.get("/logs/stats", async (c) => {
  // Full admins only: error-log statistics.
  requireFullAdmin(c);
  const db = getDb(c.env);
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const total = await db.select({ n: count() }).from(schema.errorLogs).get();
  const last24h = await db
    .select({ n: count() })
    .from(schema.errorLogs)
    .where(gte(schema.errorLogs.createdAt, since))
    .get();
  return c.json({ total: total?.n ?? 0, last24h: last24h?.n ?? 0 });
});

adminRoute.delete("/logs", async (c) => {
  // Full admins only: destroys the error trail.
  requireFullAdmin(c);
  await c.env.DB.prepare("DELETE FROM error_logs").run();
  return c.json({ success: true });
});


// ======================= SYSTEM HEALTH (admin console) =======================
//
// Authenticated mirrors of the operational health signals, for the admin
// panel's one-stop System Health page. These never mutate anything.

/**
 * Deep health, behind the admin gate and always 200.
 *
 * Same computation as the public `/health/deep` (see lib/health.ts) — D1, KV,
 * R2, required secrets, integrations and cron — but returned as 200 with the
 * payload even when unhealthy, so the panel's Bearer-auth client (which throws
 * on non-2xx) can render the red state instead of treating it as a request
 * error.
 */
adminRoute.get("/health", async (c) => {
  requireFullAdmin(c);
  return c.json(await computeDeepHealth(c.env));
});

/**
 * Money-flow integrity: ledger-vs-balance drift, stranded/stuck orders, clawback
 * shortfalls, negative balances, and the pending money queues. Read-only.
 */
adminRoute.get("/money-health", async (c) => {
  requireFullAdmin(c);
  return c.json(await computeMoneyHealth(c.env));
});

/**
 * Per-job cron status (last run, ok/fail, duration, stale). Previously only
 * visible inside the public /health/deep; surfaced here for the console.
 */
adminRoute.get("/ops/cron-health", async (c) => {
  requireFullAdmin(c);
  return c.json(await cronHealth(c.env));
});

// ============================== SEO AUDIT ==================================
/**
 * Latest stored SEO audit, or `{ ranAt: null }` before the first cron run.
 *
 * Deliberately returns 200 even when the audit is full of critical findings — same
 * reasoning as /health above: the panel throws on a non-2xx response and would
 * render a request error instead of the report it is asking for.
 */
adminRoute.get("/seo", async (c) => {
  requireFullAdmin(c);
  const audit = await getSeoAudit(c.env);
  return c.json(audit ?? { ranAt: null });
});

/**
 * Re-scan now.
 *
 * A scan makes ~15 subrequests to our own public site and reads every published
 * post, so it is a real cost — hence full-admin only, and audited.
 */
adminRoute.post("/seo/scan", async (c) => {
  requireFullAdmin(c);
  const result = await seoAuditJob(c.env, { force: true });
  await logAudit(c, "seo.scan", "seo", null, result as Record<string, unknown>);
  return c.json({ message: "SEO scan complete", ...result });
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
  // Packages price every real purchase, so they are validated on the way IN.
  const values = validateCoinPackage(b);
  if (values.coins == null || values.priceInr == null) {
    throw httpsError("invalid-argument", "coins and priceInr are required.");
  }
  const id = newId();
  const ts = now();
  await db.insert(schema.coinPackages).values({
    id,
    name: values.name ?? null,
    coins: values.coins,
    bonusCoins: values.bonusCoins ?? 0,
    priceInr: values.priceInr,
    active: values.active ?? true,
    sortOrder: values.sortOrder ?? 0,
    createdAt: ts,
    updatedAt: ts,
  });
  await logAudit(c, "coin-package.create", "coin_package", id, values);
  return c.json({ success: true, id });
});

adminRoute.patch("/coin-packages/:id", async (c) => {
  requireFullAdmin(c);
  const db = getDb(c.env);
  const id = c.req.param("id");
  const b = await c.req.json<any>();
  const current = await db.select().from(schema.coinPackages).where(eq(schema.coinPackages.id, id)).get();
  if (!current) throw httpsError("not-found", "Package not found.");
  // Validate against the MERGED result so raising the bonus alone, or lowering
  // the coins alone, is still checked against the other value.
  const values = validateCoinPackage(b, {
    coins: Number(current.coins),
    bonusCoins: Number(current.bonusCoins),
  });
  const set: any = { ...values, updatedAt: now() };
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
  if (b.fullName !== undefined) {
    const fullName = String(b.fullName).trim();
    if (fullName.length > 80) throw httpsError("invalid-argument", "Full name must be at most 80 characters.");
    set.fullName = fullName;
  }
  if (b.username !== undefined) {
    // This used to be a bare `.toLowerCase()`, bypassing the length, charset and
    // reserved-name policy that signup enforces — an admin could set a username
    // of "support" or "admin", which is a phishing vector in the app's own DMs.
    set.username = validateUsername(b.username);
    // And it must still be globally unique.
    await assertIdentifiersAvailable(c.env, id, { username: set.username });
  }
  if (b.bio !== undefined) {
    const bio = String(b.bio);
    if (bio.length > 500) throw httpsError("invalid-argument", "Bio must be at most 500 characters.");
    set.bio = bio;
  }
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
  // XP was accepted as any number: NaN, Infinity, fractions and huge values all
  // went straight into the leaderboard. A grant is repeatable by design, so an
  // Idempotency-Key makes a double-click a no-op.
  let xpDelta = 0;
  if (xp !== undefined && xp !== null && xp !== 0) {
    const parsed = Number(xp);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 1_000_000) {
      throw httpsError("invalid-argument", "xp must be a whole number between 1 and 1,000,000.");
    }
    xpDelta = parsed;
  }
  const badgeName = badge == null ? null : String(badge).trim();
  if (badgeName !== null && (badgeName.length === 0 || badgeName.length > 60)) {
    throw httpsError("invalid-argument", "badge must be 1–60 characters.");
  }
  if (!xpDelta && !badgeName) throw httpsError("invalid-argument", "Provide xp and/or a badge to grant.");

  const user = await db.select({ xp: schema.users.xp, badges: schema.users.badges }).from(schema.users).where(eq(schema.users.uid, id)).get();
  if (!user) throw httpsError("not-found", "User not found.");

  const idem = await enforceAdminIdempotency(c, "user.grant", id);
  try {
    const set: any = { updatedAt: now() };
    if (xpDelta) set.xp = sql`${schema.users.xp} + ${xpDelta}`;
    if (badgeName) {
      const badges = ((user.badges as unknown as string[]) || []).slice();
      if (!badges.includes(badgeName)) badges.push(badgeName);
      set.badges = badges as any;
    }
    await db.update(schema.users).set(set).where(eq(schema.users.uid, id));
    await logAudit(c, "user.grant", "user", id, { xp: xpDelta, badge: badgeName });
    return c.json({ message: "Granted" });
  } catch (e) {
    await idem?.finish(false);
    throw e;
  }
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
  // Full admins only: every user's coin balance.
  requireFullAdmin(c);
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
  // Full admins only: a plaintext dump of private direct messages.
  requireFullAdmin(c);
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
  // Reading other people's private conversations is exactly the kind of access
  // that must leave a trace. Every other destructive/sensitive action here is
  // audited; this read was not, so there was no record of who looked at what.
  await logAudit(c, "message.read", "message", null, { count: rows.length, limit });
  return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null })));
});

adminRoute.delete("/messages/:id", async (c) => {
  // Full admins only: deletes a private message.
  requireFullAdmin(c);
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
  // Range variants ([since, until)) for previous-period deltas.
  const cntRange = async (tbl: any, col: any, since: number, until: number) =>
    (await db.select({ v: count() }).from(tbl).where(and(gte(col, since), lt(col, until))).get())?.v ?? 0;
  const sumRange = async (col: any, tbl: any, since: number, until: number, statusOk?: any) =>
    (await db.select({ v: sql<number>`COALESCE(SUM(${col}),0)` }).from(tbl).where(statusOk ? and(gte(tbl.createdAt, since), lt(tbl.createdAt, until), statusOk) : and(gte(tbl.createdAt, since), lt(tbl.createdAt, until))).get())?.v ?? 0;
  const votersRange = async (since: number, until: number) =>
    (await db.select({ v: sql<number>`COUNT(DISTINCT ${schema.votes.voterUid})` }).from(schema.votes).where(and(gte(schema.votes.createdAt, since), lt(schema.votes.createdAt, until))).get())?.v ?? 0;

  const totalUsers = (await db.select({ v: count() }).from(schema.users).get())?.v ?? 0;
  const newUsersToday = await cnt(schema.users, schema.users.createdAt, nowMs - day);
  const newUsers7d = await cnt(schema.users, schema.users.createdAt, nowMs - 7 * day);
  const newUsers30d = await cnt(schema.users, schema.users.createdAt, nowMs - 30 * day);

  // Active users (proxy): distinct voters in the window.
  const dau = (await db.select({ v: sql<number>`COUNT(DISTINCT ${schema.votes.voterUid})` }).from(schema.votes).where(gte(schema.votes.createdAt, nowMs - day)).get())?.v ?? 0;
  const mau = (await db.select({ v: sql<number>`COUNT(DISTINCT ${schema.votes.voterUid})` }).from(schema.votes).where(gte(schema.votes.createdAt, nowMs - 30 * day)).get())?.v ?? 0;

  // `revenue*` are COIN counts (payments.amount is coins) — the dashboard cards
  // are labelled "Coins Sold". `revenue*Inr` are the real rupee figures.
  const revenueToday = await sum(schema.payments.amount, schema.payments, nowMs - day, eq(schema.payments.status, "success"));
  const revenue7d = await sum(schema.payments.amount, schema.payments, nowMs - 7 * day, eq(schema.payments.status, "success"));
  const revenue30d = await sum(schema.payments.amount, schema.payments, nowMs - 30 * day, eq(schema.payments.status, "success"));
  const paiseToInr = (v: number) => roundFiat(Number(v || 0) / 100);
  const revenueTodayInr = paiseToInr(
    await sum(schema.payments.amountPaise, schema.payments, nowMs - day, eq(schema.payments.status, "success")),
  );
  const revenue7dInr = paiseToInr(
    await sum(schema.payments.amountPaise, schema.payments, nowMs - 7 * day, eq(schema.payments.status, "success")),
  );
  const revenue30dInr = paiseToInr(
    await sum(schema.payments.amountPaise, schema.payments, nowMs - 30 * day, eq(schema.payments.status, "success")),
  );

  const matchesToday = await cnt(schema.contestMatches, schema.contestMatches.createdAt, nowMs - day);
  const votesToday = await cnt(schema.votes, schema.votes.createdAt, nowMs - day);
  const postsToday = await cnt(schema.posts, schema.posts.createdAt, nowMs - day);
  const activeMatches = (await db.select({ v: count() }).from(schema.contestMatches).where(eq(schema.contestMatches.status, "active")).get())?.v ?? 0;
  const completedMatches = (await db.select({ v: count() }).from(schema.contestMatches).where(eq(schema.contestMatches.status, "completed")).get())?.v ?? 0;

  // Previous-period comparators so the dashboard can show honest deltas:
  //   * "today" cards compare against yesterday (24-48h ago),
  //   * weekly momentum compares the last 7 days against the 7 days before that.
  const newUsersYesterday = await cntRange(schema.users, schema.users.createdAt, nowMs - 2 * day, nowMs - day);
  const votesYesterday = await cntRange(schema.votes, schema.votes.createdAt, nowMs - 2 * day, nowMs - day);
  const dauYesterday = await votersRange(nowMs - 2 * day, nowMs - day);
  const revenueYesterday = await sumRange(schema.payments.amount, schema.payments, nowMs - 2 * day, nowMs - day, eq(schema.payments.status, "success"));
  const newUsersPrev7d = await cntRange(schema.users, schema.users.createdAt, nowMs - 14 * day, nowMs - 7 * day);
  const revenuePrev7d = await sumRange(schema.payments.amount, schema.payments, nowMs - 14 * day, nowMs - 7 * day, eq(schema.payments.status, "success"));

  return c.json({
    totalUsers, newUsersToday, newUsers7d, newUsers30d,
    dau, mau,
    revenueToday, revenue7d, revenue30d,
    revenueTodayInr, revenue7dInr, revenue30dInr,
    matchesToday, votesToday, postsToday,
    activeMatches, completedMatches,
    // deltas
    newUsersYesterday, votesYesterday, dauYesterday, revenueYesterday,
    newUsersPrev7d, revenuePrev7d,
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
  // Safe to re-run: each (period, rank, uid) payout is claimed in
  // `idempotency_keys` inside the crediting transaction, so a second click pays
  // nobody twice. `skipped` tells the admin how many were already settled.
  const body = await c.req.json<any>().catch(() => ({}));
  const period = typeof body?.period === "string" && /^\d{4}-\d{2}$/.test(body.period) ? body.period : undefined;
  const result = await monthlyHallOfFame(c.env, period);
  await logAudit(c, "ops.hall-of-fame", "ops", null, result);
  return c.json({ message: `Hall of Fame settled for ${result.period}`, ...result });
});


// ======================= VIDEO MIGRATION (R2 -> Bunny Stream) =======================
/**
 * Enqueue one resumable batch of existing R2 videos for migration to Bunny.
 *
 * Driven by `apps/admin-panel/scripts/migrate-videos-to-bunny.mjs`. Lives here
 * rather than in the script so the Bunny API key never leaves the Worker.
 *
 * Safe to re-run: enqueued rows are marked `migrating`, and `mediaUrl` is not
 * repointed until Bunny reports the encode `ready` (the webhook does that), so
 * playback keeps working from R2 throughout.
 */
adminRoute.post("/videos/migrate-batch", async (c) => {
  requireFullAdmin(c);
  const body = await c.req.json<any>().catch(() => ({}));
  const target = ["stories", "matches", "all"].includes(body?.target) ? body.target : "all";
  const limit = Number(body?.limit) || 10;

  let result;
  try {
    result = await runVideoBackfillBatch(c.env, { limit, target });
  } catch (e: any) {
    throw httpsError("failed-precondition", e?.message || "Video migration failed.");
  }

  await logAudit(c, "videos.migrate-batch", "videos", null, {
    target,
    limit,
    enqueued: result.enqueued,
    failed: result.failed,
  });
  return c.json(result);
});

/** Migration progress, for the script's summary output and for spot checks. */
adminRoute.get("/videos/migration-status", async (c) => {
  const db = getDb(c.env);
  const byStatus = await db
    .select({ status: schema.videos.status, count: count() })
    .from(schema.videos)
    .groupBy(schema.videos.status)
    .all();
  const pendingStories = await db
    .select({ count: count() })
    .from(schema.stories)
    .where(and(isNull(schema.stories.videoProvider), eq(schema.stories.mediaType, "video")))
    .get();
  const pendingMatches = await db
    .select({ count: count() })
    .from(schema.contestMatches)
    .where(and(isNull(schema.contestMatches.videoProvider), eq(schema.contestMatches.type, "video")))
    .get();

  return c.json({
    videosByStatus: byStatus,
    pending: {
      stories: pendingStories?.count ?? 0,
      matches: pendingMatches?.count ?? 0,
    },
  });
});
