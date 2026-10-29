/**
 * /admin/gamification — configuration, catalog, seasons, user inspection,
 * audited XP corrections, review flags and analytics.
 *
 * Roles: every write needs a full admin (superadmin/admin). Moderators may read
 * configuration, inspect a user's progression (without coin rewards) and review
 * flags, but never move XP or coins. Sensitive writes are listed in admin.ts
 * SENSITIVE_ADMIN_ROUTES, so they also need a recent sign-in.
 *
 * Every write is audit-logged with before/after values. XP corrections are new
 * ledger events (lib/xpService.ts), never edits to a balance.
 */
import type { Hono } from "hono";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "../lib/http";
import { newId, now } from "../lib/ids";
import { getGamificationSettings, invalidateSetting } from "../lib/settings";
import { enforceAdminIdempotency } from "../lib/idempotency";
import { assertLinkableBudget, getBudget } from "../lib/promoBudget";
import { assertApproval } from "../lib/approvalPassword";
import { createNotification } from "../lib/notify";
import {
  ACHIEVEMENT_METRICS,
  grantAchievementManually,
  syncProgression,
} from "../lib/achievements";
import {
  EQUIP_SLOTS,
  invalidateGamificationCatalog,
  ITEM_TYPES,
  loadAchievementDefs,
  loadCatalog,
  loadInventory,
  parseEquipped,
  RARITIES,
} from "../lib/cosmetics";
import {
  getProgression,
  levelInfo,
  sanitizeProgression,
  validateProgression,
  xpForLevel,
  MAX_RULE_XP,
} from "../lib/progression";
import { awardXp, reconcileXp, reverseXp } from "../lib/xpService";
import { finalizeSeason, parseSeasonRewards, validateSeasonInput } from "../lib/seasons";
import { rewardDayNumber } from "../lib/gamification";

type Audit = (c: any, action: string, targetType: string, targetId: string | null, detail?: Record<string, unknown>) => Promise<void>;

const ID_RE = /^[a-z0-9_-]{2,40}$/;
const DAY_MS = 86_400_000;

function reasonOf(body: any, min = 3): string {
  const r = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (r.length < min || r.length > 300) throw httpsError("invalid-argument", "A reason (3-300 characters) is required.");
  return r;
}

const actorOf = (c: any): string => c.get("user")?.uid ?? "server";

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export function registerGamificationRoutes(
  adminRoute: Hono<{ Bindings: Env; Variables: Variables }>,
  requireFullAdmin: (c: any) => void,
  isFullAdmin: (c: any) => boolean,
  logAudit: Audit,
) {
  // ------------------------------------------------------------------ config
  adminRoute.get("/gamification/config", async (c) => {
    const p = await getProgression(c.env);
    return c.json({
      progression: p.cfg,
      xpThreshold: p.settings.xpThreshold,
      xpIncrement: p.settings.xpIncrement,
      dayResetOffsetMinutes: p.settings.dayResetOffsetMinutes,
      metrics: ACHIEVEMENT_METRICS,
      itemTypes: ITEM_TYPES,
      equipSlots: EQUIP_SLOTS,
      // A preview of the curve so the panel can show what the numbers mean.
      curvePreview: [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 90, 100]
        .filter((l) => l <= p.curve.maxLevel)
        .map((level) => ({ level, xp: xpForLevel(level, p.curve) })),
    });
  });

  adminRoute.post("/gamification/config", async (c) => {
    requireFullAdmin(c);
    const body = await c.req.json<any>().catch(() => ({}));
    const existing = (await getGamificationSettings(c.env)) || {};
    const before = sanitizeProgression(existing.progression);
    const patch = body?.progression ?? {};
    const merged = { ...(existing.progression || {}), ...patch };
    const xpThreshold = body?.xpThreshold ?? existing.xpThreshold ?? 500;
    const xpIncrement = body?.xpIncrement ?? existing.xpIncrement ?? 500;
    try {
      validateProgression(merged, { xpThreshold, xpIncrement });
    } catch (e: any) {
      throw httpsError("invalid-argument", e?.message || "Invalid gamification settings.");
    }
    if (patch.rewardBudgetId) await assertLinkableBudget(c.env, patch.rewardBudgetId, "free_rewards");
    // Anything that makes the platform pay coins needs the approval password,
    // like every other budget link (lib/approvalPassword.ts).
    const coinsBefore = JSON.stringify(before.milestones.map((m) => [m.level, m.coins]));
    const after = sanitizeProgression(merged);
    const coinsAfter = JSON.stringify(after.milestones.map((m) => [m.level, m.coins]));
    if ((patch.rewardBudgetId !== undefined && patch.rewardBudgetId !== before.rewardBudgetId) || coinsBefore !== coinsAfter) {
      await assertApproval(c, body);
    }
    merged.version = before.version + 1;
    const data = { ...existing, progression: merged, xpThreshold, xpIncrement };
    const db = getDb(c.env);
    await db
      .insert(schema.settings)
      .values({ id: "gamification", data, updatedAt: now() })
      .onConflictDoUpdate({ target: schema.settings.id, set: { data, updatedAt: now() } });
    await invalidateSetting(c.env, "gamification");
    await logAudit(c, "gamification.config.update", "settings", "gamification", {
      before: { progression: existing.progression ?? null, xpThreshold: existing.xpThreshold, xpIncrement: existing.xpIncrement },
      after: { progression: merged, xpThreshold, xpIncrement },
    });
    return c.json({ success: true, version: merged.version });
  });

  // ------------------------------------------------------------ achievements
  adminRoute.get("/gamification/achievements", async (c) => {
    const defs = await loadAchievementDefs(c.env);
    const counts = await c.env.DB.prepare(`SELECT achievement_id, COUNT(DISTINCT uid) AS n FROM user_achievements GROUP BY achievement_id`).all<any>();
    const byId = new Map((counts.results ?? []).map((r) => [r.achievement_id, Number(r.n)]));
    return c.json(defs.map((d) => ({ ...d, unlockedBy: byId.get(d.id) ?? 0 })));
  });

  adminRoute.put("/gamification/achievements/:id", async (c) => {
    requireFullAdmin(c);
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw httpsError("invalid-argument", "id must be 2-40 lowercase letters, digits, _ or -.");
    const b = await c.req.json<any>().catch(() => ({}));
    const str = (v: unknown, field: string, max: number, required = true) => {
      if (v === undefined && !required) return undefined;
      if (typeof v !== "string" || (required && !v.trim()) || v.length > max) throw httpsError("invalid-argument", `${field} is required (max ${max}).`);
      return v.trim();
    };
    const int = (v: unknown, field: string, min: number, max: number, dflt: number) => {
      if (v === undefined || v === null) return dflt;
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw httpsError("invalid-argument", `${field} must be ${min}-${max}.`);
      return v;
    };
    const metric = String(b.metric ?? "");
    if (!(ACHIEVEMENT_METRICS as readonly string[]).includes(metric)) {
      throw httpsError("invalid-argument", `metric must be one of ${ACHIEVEMENT_METRICS.join(", ")}.`);
    }
    const rarity = String(b.rarity ?? "common");
    if (!(RARITIES as readonly string[]).includes(rarity)) throw httpsError("invalid-argument", `rarity must be ${RARITIES.join(", ")}.`);
    const itemId = b.itemId ? String(b.itemId) : null;
    if (itemId && !(await loadCatalog(c.env)).some((i) => i.id === itemId)) throw httpsError("invalid-argument", "itemId is not in the catalog.");
    const startsAt = b.startsAt == null ? null : int(b.startsAt, "startsAt", 1, 9e15, 0);
    const endsAt = b.endsAt == null ? null : int(b.endsAt, "endsAt", 1, 9e15, 0);
    if (startsAt && endsAt && endsAt <= startsAt) throw httpsError("invalid-argument", "endsAt must be after startsAt.");
    const v = {
      name: str(b.name, "name", 60)!,
      description: str(b.description ?? "", "description", 200, false) ?? "",
      icon: str(b.icon ?? "trophy", "icon", 40)!,
      category: str(b.category ?? "general", "category", 30)!,
      rarity,
      metric,
      threshold: int(b.threshold, "threshold", 1, 1_000_000, 1),
      xpReward: int(b.xpReward, "xpReward", 0, MAX_RULE_XP, 0),
      itemId,
      repeatable: b.repeatable === true,
      maxTiers: int(b.maxTiers, "maxTiers", 1, 100, 1),
      active: b.active !== false,
      hidden: b.hidden === true,
      startsAt,
      endsAt,
      sort: int(b.sort, "sort", 0, 100_000, 0),
    };
    const before = (await loadAchievementDefs(c.env)).find((d) => d.id === id) ?? null;
    const ts = now();
    // Changing what an achievement requires never takes it away from anyone who
    // already unlocked it: unlocks are rows, not re-evaluations.
    await c.env.DB.prepare(
      `INSERT INTO achievement_definitions (id, name, description, icon, category, rarity, metric, threshold, xp_reward, item_id,
         repeatable, max_tiers, active, hidden, starts_at, ends_at, sort, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, icon = excluded.icon,
         category = excluded.category, rarity = excluded.rarity, metric = excluded.metric, threshold = excluded.threshold,
         xp_reward = excluded.xp_reward, item_id = excluded.item_id, repeatable = excluded.repeatable, max_tiers = excluded.max_tiers,
         active = excluded.active, hidden = excluded.hidden, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         sort = excluded.sort, version = achievement_definitions.version + 1, updated_at = excluded.updated_at`,
    ).bind(id, v.name, v.description, v.icon, v.category, v.rarity, v.metric, v.threshold, v.xpReward, v.itemId,
      v.repeatable ? 1 : 0, v.maxTiers, v.active ? 1 : 0, v.hidden ? 1 : 0, v.startsAt, v.endsAt, v.sort, ts, ts).run();
    invalidateGamificationCatalog();
    await logAudit(c, before ? "gamification.achievement.update" : "gamification.achievement.create", "achievement", id, { before, after: v });
    return c.json({ success: true });
  });

  // ----------------------------------------------------------------- catalog
  adminRoute.get("/gamification/catalog", async (c) => {
    const items = await loadCatalog(c.env);
    const counts = await c.env.DB.prepare(`SELECT item_id, COUNT(*) AS n FROM user_inventory WHERE revoked_at IS NULL GROUP BY item_id`).all<any>();
    const byId = new Map((counts.results ?? []).map((r) => [r.item_id, Number(r.n)]));
    return c.json(items.map((i) => ({ ...i, owners: byId.get(i.id) ?? 0 })));
  });

  adminRoute.put("/gamification/catalog/:id", async (c) => {
    requireFullAdmin(c);
    const id = c.req.param("id");
    if (!ID_RE.test(id)) throw httpsError("invalid-argument", "id must be 2-40 lowercase letters, digits, _ or -.");
    const b = await c.req.json<any>().catch(() => ({}));
    if (!(ITEM_TYPES as readonly string[]).includes(b.type)) throw httpsError("invalid-argument", `type must be ${ITEM_TYPES.join(", ")}.`);
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 60) throw httpsError("invalid-argument", "name is required (max 60).");
    const rarity = String(b.rarity ?? "common");
    if (!(RARITIES as readonly string[]).includes(rarity)) throw httpsError("invalid-argument", `rarity must be ${RARITIES.join(", ")}.`);
    const asset = b.asset ?? {};
    if (typeof asset !== "object" || Array.isArray(asset) || JSON.stringify(asset).length > 2000) {
      throw httpsError("invalid-argument", "asset must be a small JSON object (colors, icon, text, animated).");
    }
    const colors = (asset as any).colors;
    if (colors !== undefined && (!Array.isArray(colors) || colors.length > 4 || !colors.every((x: unknown) => typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x)))) {
      throw httpsError("invalid-argument", "asset.colors must be up to 4 #RRGGBB colors.");
    }
    const key = (asset as any).key;
    if (key !== undefined && (typeof key !== "string" || !/^[a-z]+\.[a-z0-9_]{1,40}$/.test(key))) {
      throw httpsError("invalid-argument", "asset.key must be an app asset key like frame.gold (see the Gamification asset list).");
    }
    const before = (await loadCatalog(c.env)).find((i) => i.id === id) ?? null;
    // An item someone already owns keeps its type: changing a frame into a title
    // would silently break every equipped slot that points at it.
    if (before && before.type !== b.type) {
      const owners = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM user_inventory WHERE item_id = ?`).bind(id).first<{ n: number }>();
      if (Number(owners?.n || 0) > 0) throw httpsError("failed-precondition", "This item is already owned; its type cannot change. Create a new item instead.");
    }
    const ts = now();
    await c.env.DB.prepare(
      `INSERT INTO reward_catalog (id, type, name, description, rarity, asset, active, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET type = excluded.type, name = excluded.name, description = excluded.description,
         rarity = excluded.rarity, asset = excluded.asset, active = excluded.active, sort = excluded.sort, updated_at = excluded.updated_at`,
    ).bind(id, b.type, b.name.trim(), String(b.description ?? "").slice(0, 200), rarity, JSON.stringify(asset), b.active === false ? 0 : 1,
      Number.isInteger(b.sort) ? b.sort : 0, ts, ts).run();
    invalidateGamificationCatalog();
    const owners = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM user_inventory WHERE item_id = ?`).bind(id).first<{ n: number }>();
    await logAudit(c, before ? "gamification.item.update" : "gamification.item.create", "reward_item", id, {
      before, after: { ...b, rarity, asset }, ownersAffected: Number(owners?.n || 0),
    });
    return c.json({ success: true });
  });

  // ----------------------------------------------------------------- seasons
  adminRoute.get("/gamification/seasons", async (c) => {
    const rows = await c.env.DB.prepare(`SELECT * FROM seasons ORDER BY start_day DESC LIMIT 50`).all<any>();
    return c.json((rows.results ?? []).map((s) => ({ ...s, rewards: parseSeasonRewards(s.rewards) })));
  });

  adminRoute.post("/gamification/seasons", async (c) => {
    requireFullAdmin(c);
    const b = await c.req.json<any>().catch(() => ({}));
    const v = validateSeasonInput(b);
    const p = await getProgression(c.env);
    const off = p.settings.dayResetOffsetMinutes;
    const startDay = rewardDayNumber(v.startsAt, off);
    const endDay = rewardDayNumber(v.endsAt - 1, off);
    const overlap = await c.env.DB.prepare(
      `SELECT id FROM seasons WHERE status NOT IN ('cancelled') AND start_day <= ? AND end_day >= ? LIMIT 1`,
    ).bind(endDay, startDay).first();
    if (overlap) throw httpsError("failed-precondition", "Seasons cannot overlap.");
    if (v.rewards.some((r) => r.coins > 0)) await assertApproval(c, b);
    const id = newId();
    const ts = now();
    await c.env.DB.prepare(
      `INSERT INTO seasons (id, name, description, starts_at, ends_at, start_day, end_day, status, top_n, rewards, policy_version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)`,
    ).bind(id, v.name, v.description, v.startsAt, v.endsAt, startDay, endDay, v.topN, JSON.stringify(v.rewards), p.cfg.version, actorOf(c), ts, ts).run();
    await logAudit(c, "gamification.season.create", "season", id, { ...v, startDay, endDay });
    return c.json({ success: true, id });
  });

  adminRoute.patch("/gamification/seasons/:id", async (c) => {
    requireFullAdmin(c);
    const id = c.req.param("id");
    const cur = await c.env.DB.prepare(`SELECT * FROM seasons WHERE id = ?`).bind(id).first<any>();
    if (!cur) throw httpsError("not-found", "Season not found.");
    if (!["scheduled", "active"].includes(cur.status)) throw httpsError("failed-precondition", "Only a scheduled or active season can be edited.");
    const b = await c.req.json<any>().catch(() => ({}));
    const merged = {
      name: b.name ?? cur.name,
      description: b.description ?? cur.description,
      // The schedule is fixed once a season is running: moving it would change who earned what.
      startsAt: cur.status === "active" ? cur.starts_at : b.startsAt ?? cur.starts_at,
      endsAt: cur.status === "active" ? cur.ends_at : b.endsAt ?? cur.ends_at,
      topN: b.topN ?? cur.top_n,
      rewards: b.rewards ?? parseSeasonRewards(cur.rewards),
    };
    const v = validateSeasonInput(merged);
    if (JSON.stringify(v.rewards) !== JSON.stringify(parseSeasonRewards(cur.rewards)) && v.rewards.some((r) => r.coins > 0)) await assertApproval(c, b);
    const p = await getProgression(c.env);
    const off = p.settings.dayResetOffsetMinutes;
    await c.env.DB.prepare(
      `UPDATE seasons SET name = ?, description = ?, starts_at = ?, ends_at = ?, start_day = ?, end_day = ?, top_n = ?, rewards = ?, updated_at = ?
        WHERE id = ? AND status IN ('scheduled', 'active')`,
    ).bind(v.name, v.description, v.startsAt, v.endsAt, rewardDayNumber(v.startsAt, off), rewardDayNumber(v.endsAt - 1, off), v.topN,
      JSON.stringify(v.rewards), now(), id).run();
    await logAudit(c, "gamification.season.update", "season", id, { before: cur, after: v });
    return c.json({ success: true });
  });

  adminRoute.post("/gamification/seasons/:id/finalize", async (c) => {
    requireFullAdmin(c);
    const id = c.req.param("id");
    const ok = await finalizeSeason(c.env, id);
    const s = await c.env.DB.prepare(`SELECT status FROM seasons WHERE id = ?`).bind(id).first<{ status: string }>();
    if (!s) throw httpsError("not-found", "Season not found.");
    if (!ok && s.status !== "finalized") throw httpsError("failed-precondition", "A season can only be finalized after its last day.");
    await logAudit(c, "gamification.season.finalize", "season", id, { finalizedNow: ok });
    return c.json({ success: true, status: s.status, finalizedNow: ok });
  });

  adminRoute.post("/gamification/seasons/:id/cancel", async (c) => {
    requireFullAdmin(c);
    const id = c.req.param("id");
    const b = await c.req.json<any>().catch(() => ({}));
    const reason = reasonOf(b);
    const r = await c.env.DB.prepare(`UPDATE seasons SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('scheduled', 'active')`)
      .bind(now(), id).run();
    if (Number(r.meta?.changes || 0) === 0) throw httpsError("failed-precondition", "Only a scheduled or active season can be cancelled.");
    await logAudit(c, "gamification.season.cancel", "season", id, { reason });
    return c.json({ success: true });
  });

  adminRoute.get("/gamification/seasons/:id/results", async (c) => {
    const id = c.req.param("id");
    const limit = boundedInt(c.req.query("limit"), 100, 1, 500);
    const offset = boundedInt(c.req.query("offset"), 0, 0, 100_000);
    const rows = await c.env.DB.prepare(
      `SELECT r.rank, r.uid, r.xp, r.rewards, r.reward_state, u.username,
              (SELECT status FROM reward_grants g WHERE g.id = 'season:' || r.season_id || ':' || r.uid) AS grant_status
         FROM season_results r LEFT JOIN users u ON u.uid = r.uid
        WHERE r.season_id = ? ORDER BY r.rank LIMIT ? OFFSET ?`,
    ).bind(id, limit, offset).all<any>();
    const full = isFullAdmin(c);
    return c.json((rows.results ?? []).map((r) => ({
      ...r,
      rewards: parseSeasonRewards(r.rewards),
      // Coin delivery state is financial: full admins only.
      grant_status: full ? r.grant_status : undefined,
    })));
  });

  // -------------------------------------------------------- user inspection
  adminRoute.get("/gamification/users/:id", async (c) => {
    const uid = c.req.param("id");
    const u = await c.env.DB.prepare(`SELECT uid, username, xp, level_seen, streak, cosmetics, status FROM users WHERE uid = ?`).bind(uid).first<any>();
    if (!u) throw httpsError("not-found", "User not found.");
    const p = await getProgression(c.env);
    const ach = await c.env.DB.prepare(`SELECT achievement_id, tier, unlocked_at, xp_awarded, source FROM user_achievements WHERE uid = ? ORDER BY unlocked_at DESC`).bind(uid).all<any>();
    const flags = await c.env.DB.prepare(`SELECT * FROM xp_flags WHERE uid = ? ORDER BY created_at DESC LIMIT 50`).bind(uid).all<any>();
    const ledger = await c.env.DB.prepare(`SELECT COALESCE(SUM(delta), 0) AS s, COUNT(*) AS n FROM user_xp_events WHERE uid = ?`).bind(uid).first<any>();
    const grants = isFullAdmin(c)
      ? (await c.env.DB.prepare(`SELECT * FROM reward_grants WHERE uid = ? ORDER BY created_at DESC LIMIT 50`).bind(uid).all<any>()).results
      : undefined;
    return c.json({
      uid: u.uid,
      username: u.username,
      status: u.status,
      levelInfo: levelInfo(u.xp ?? 0, p.curve, p.cfg),
      levelSeen: u.level_seen,
      streak: u.streak,
      equipped: parseEquipped(u.cosmetics),
      ledger: { sum: Number(ledger?.s || 0), events: Number(ledger?.n || 0), matchesBalance: Number(ledger?.s || 0) === Number(u.xp ?? 0) },
      achievements: ach.results ?? [],
      inventory: await loadInventory(c.env, uid),
      flags: flags.results ?? [],
      ...(grants ? { rewardGrants: grants } : {}),
    });
  });

  adminRoute.get("/gamification/users/:id/events", async (c) => {
    const uid = c.req.param("id");
    const limit = boundedInt(c.req.query("limit"), 50, 1, 200);
    const before = boundedInt(c.req.query("before"), Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER);
    const rows = await c.env.DB.prepare(
      `SELECT e.*, (SELECT id FROM user_xp_events r WHERE r.reverses = e.id) AS reversed_by
         FROM user_xp_events e WHERE e.uid = ? AND e.created_at < ? ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
    ).bind(uid, before, limit).all<any>();
    const list = (rows.results ?? []).map(({ nonce, ...r }) => r);
    return c.json({ events: list, nextBefore: list.length === limit ? list[list.length - 1].created_at : null });
  });

  /** Audited XP correction: a new ledger event, signed amount, never below zero. */
  adminRoute.post("/gamification/users/:id/xp", async (c) => {
    requireFullAdmin(c);
    const uid = c.req.param("id");
    const b = await c.req.json<any>().catch(() => ({}));
    const amount = Number(b.amount);
    if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000) {
      throw httpsError("invalid-argument", "amount must be a non-zero whole number between -1,000,000 and 1,000,000.");
    }
    const reason = reasonOf(b);
    const user = await c.env.DB.prepare(`SELECT xp FROM users WHERE uid = ?`).bind(uid).first<{ xp: number }>();
    if (!user) throw httpsError("not-found", "User not found.");
    const idem = await enforceAdminIdempotency(c, "gamification.xp", uid);
    try {
      const correlationId = newId();
      const res = await awardXp(c.env, {
        uid, action: "admin_adjustment", eventId: `admin_xp:${uid}:${correlationId}`, amount,
        sourceType: "admin", sourceId: correlationId, reason, actor: actorOf(c), ts: now(),
      });
      const after = await c.env.DB.prepare(`SELECT xp FROM users WHERE uid = ?`).bind(uid).first<{ xp: number }>();
      await logAudit(c, "gamification.xp.adjust", "user", uid, {
        requested: amount, applied: res.delta, before: user.xp ?? 0, after: after?.xp ?? 0, reason, correlationId,
      });
      if (b.notify === true && res.delta !== 0) {
        await createNotification(c.env, uid, {
          title: "Your XP was updated",
          body: res.delta > 0 ? `+${res.delta} XP was added to your account.` : `${res.delta} XP was removed from your account.`,
          type: "level_up",
          targetId: "rewards",
        }).catch(() => undefined);
      }
      c.executionCtx.waitUntil(syncProgression(c.env, uid).catch(() => undefined));
      return c.json({ success: true, applied: res.delta, before: user.xp ?? 0, after: after?.xp ?? 0, correlationId });
    } catch (e) {
      await idem?.finish(false);
      throw e;
    }
  });

  /** Reverse one XP event (append-only). Admin adjustments are corrected with a new adjustment instead. */
  adminRoute.post("/gamification/events/:eventId/reverse", async (c) => {
    requireFullAdmin(c);
    const eventId = c.req.param("eventId");
    const b = await c.req.json<any>().catch(() => ({}));
    const reason = reasonOf(b);
    const ev = await c.env.DB.prepare(`SELECT uid, delta, action FROM user_xp_events WHERE id = ?`).bind(eventId).first<any>();
    if (!ev) throw httpsError("not-found", "XP event not found.");
    if (ev.action === "reversal" || Number(ev.delta) <= 0) throw httpsError("failed-precondition", "Only an event that granted XP can be reversed.");
    const before = await c.env.DB.prepare(`SELECT xp FROM users WHERE uid = ?`).bind(ev.uid).first<{ xp: number }>();
    const delta = await reverseXp(c.env, { originalId: eventId, reason, actor: actorOf(c), ts: now() });
    if (delta === null) throw httpsError("already-exists", "This event was already reversed.");
    await logAudit(c, "gamification.xp.reverse", "xp_event", eventId, { uid: ev.uid, delta, before: before?.xp ?? 0, reason });
    return c.json({ success: true, delta });
  });

  adminRoute.post("/gamification/users/:id/achievements/:achievementId", async (c) => {
    requireFullAdmin(c);
    const uid = c.req.param("id");
    const achievementId = c.req.param("achievementId");
    const reason = reasonOf(await c.req.json<any>().catch(() => ({})));
    let res: { granted: boolean };
    try {
      res = await grantAchievementManually(c.env, uid, achievementId, actorOf(c), reason);
    } catch (e: any) {
      throw httpsError("invalid-argument", e?.message || "Could not grant achievement.");
    }
    await logAudit(c, "gamification.achievement.grant", "user", uid, { achievementId, reason, granted: res.granted });
    return c.json({ success: true, ...res });
  });

  adminRoute.post("/gamification/users/:id/inventory/:itemId/revoke", async (c) => {
    requireFullAdmin(c);
    const uid = c.req.param("id");
    const itemId = c.req.param("itemId");
    const reason = reasonOf(await c.req.json<any>().catch(() => ({})));
    const ts = now();
    const res = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE user_inventory SET revoked_at = ?, revoke_reason = ? WHERE uid = ? AND item_id = ? AND revoked_at IS NULL`).bind(ts, reason, uid, itemId),
      // Unequip it wherever it is equipped.
      ...EQUIP_SLOTS.map((slot) =>
        c.env.DB.prepare(`UPDATE users SET cosmetics = json_remove(cosmetics, ?) WHERE uid = ? AND json_extract(cosmetics, ?) = ?`)
          .bind(`$.${slot}`, uid, `$.${slot}`, itemId),
      ),
    ]);
    if (Number(res[0]?.meta?.changes || 0) === 0) throw httpsError("not-found", "The user does not hold this item.");
    await logAudit(c, "gamification.item.revoke", "user", uid, { itemId, reason });
    return c.json({ success: true });
  });

  adminRoute.post("/gamification/users/:id/inventory/:itemId/restore", async (c) => {
    requireFullAdmin(c);
    const uid = c.req.param("id");
    const itemId = c.req.param("itemId");
    const reason = reasonOf(await c.req.json<any>().catch(() => ({})));
    const res = await c.env.DB.prepare(`UPDATE user_inventory SET revoked_at = NULL, revoke_reason = NULL WHERE uid = ? AND item_id = ? AND revoked_at IS NOT NULL`)
      .bind(uid, itemId).run();
    if (Number(res.meta?.changes || 0) === 0) throw httpsError("not-found", "Nothing to restore.");
    await logAudit(c, "gamification.item.restore", "user", uid, { itemId, reason });
    return c.json({ success: true });
  });

  // ------------------------------------------------------------------- flags
  adminRoute.get("/gamification/flags", async (c) => {
    const status = c.req.query("status") || "open";
    const rows = await c.env.DB.prepare(
      `SELECT f.*, u.username FROM xp_flags f LEFT JOIN users u ON u.uid = f.uid WHERE f.status = ? ORDER BY f.created_at DESC LIMIT 200`,
    ).bind(status).all<any>();
    return c.json(rows.results ?? []);
  });

  adminRoute.patch("/gamification/flags/:id", async (c) => {
    const id = c.req.param("id");
    const b = await c.req.json<any>().catch(() => ({}));
    if (!["dismissed", "actioned", "open"].includes(b.status)) throw httpsError("invalid-argument", "status must be open, dismissed or actioned.");
    const note = typeof b.note === "string" ? b.note.slice(0, 300) : null;
    const r = await c.env.DB.prepare(`UPDATE xp_flags SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?`)
      .bind(b.status, actorOf(c), now(), note, id).run();
    if (Number(r.meta?.changes || 0) === 0) throw httpsError("not-found", "Flag not found.");
    await logAudit(c, "gamification.flag.review", "xp_flag", id, { status: b.status, note });
    return c.json({ success: true });
  });

  // -------------------------------------------------------------- analytics
  adminRoute.get("/gamification/analytics", async (c) => {
    requireFullAdmin(c);
    const p = await getProgression(c.env);
    const days = boundedInt(c.req.query("days"), 30, 1, 90);
    const today = rewardDayNumber(now(), p.settings.dayResetOffsetMinutes);
    const from = today - days + 1;
    const byDay = await c.env.DB.prepare(
      `SELECT day, action, SUM(xp) AS xp, SUM(events) AS events, COUNT(DISTINCT uid) AS users
         FROM user_xp_daily WHERE day BETWEEN ? AND ? GROUP BY day, action ORDER BY day`,
    ).bind(from, today).all<any>();
    const earners = await c.env.DB.prepare(
      `SELECT day, COUNT(DISTINCT uid) AS n FROM user_xp_daily WHERE day BETWEEN ? AND ? AND xp > 0 GROUP BY day ORDER BY day`,
    ).bind(from, today).all<any>();
    // Level distribution by rank band, in one aggregate over users.xp.
    const ranks = [...p.cfg.ranks].sort((a, b) => a.minLevel - b.minLevel);
    const bounds = ranks.map((r) => xpForLevel(r.minLevel, p.curve));
    const cases = ranks
      .map((r, i) => `SUM(CASE WHEN COALESCE(xp, 0) >= ${bounds[i]}${i + 1 < ranks.length ? ` AND COALESCE(xp, 0) < ${bounds[i + 1]}` : ""} THEN 1 ELSE 0 END) AS r${i}`)
      .join(", ");
    const dist = await c.env.DB.prepare(`SELECT ${cases} FROM users WHERE status IS NULL OR status <> 'deleted'`).first<any>();
    const ach = await c.env.DB.prepare(`SELECT achievement_id, COUNT(DISTINCT uid) AS n FROM user_achievements GROUP BY achievement_id ORDER BY n DESC`).all<any>();
    const grants = await c.env.DB.prepare(`SELECT source_type, status, COUNT(*) AS n, COALESCE(SUM(coins), 0) AS coins FROM reward_grants GROUP BY source_type, status`).all<any>();
    const flags = await c.env.DB.prepare(`SELECT kind, status, COUNT(*) AS n FROM xp_flags GROUP BY kind, status`).all<any>();
    const quests = await c.env.DB.prepare(`SELECT quest_id, period_key, COUNT(*) AS n FROM quest_claims GROUP BY quest_id, period_key ORDER BY period_key DESC LIMIT 100`).all<any>();
    const budgetId = p.cfg.rewardBudgetId;
    const budget = budgetId ? await getBudget(c.env, budgetId).catch(() => null) : null;
    const seasons = await c.env.DB.prepare(
      `SELECT s.id, s.name, s.status, (SELECT COUNT(*) FROM season_results r WHERE r.season_id = s.id) AS ranked FROM seasons s ORDER BY s.start_day DESC LIMIT 10`,
    ).all<any>();
    return c.json({
      days,
      xpByDay: byDay.results ?? [],
      activeEarners: earners.results ?? [],
      levelDistribution: ranks.map((r, i) => ({ rank: r.name, minLevel: r.minLevel, minXp: bounds[i], users: Number(dist?.[`r${i}`] || 0) })),
      achievements: ach.results ?? [],
      rewardGrants: grants.results ?? [],
      flags: flags.results ?? [],
      quests: quests.results ?? [],
      rewardBudget: budget,
      seasons: seasons.results ?? [],
    });
  });

  /** Ledger vs balance check, for given uids or the most recent XP earners. */
  adminRoute.post("/gamification/reconcile", async (c) => {
    requireFullAdmin(c);
    const b = await c.req.json<any>().catch(() => ({}));
    let uids: string[] = Array.isArray(b.uids) ? b.uids.filter((u: unknown) => typeof u === "string").slice(0, 500) : [];
    if (!uids.length) {
      const rows = await c.env.DB.prepare(`SELECT DISTINCT uid FROM user_xp_events WHERE created_at > ? LIMIT 500`).bind(now() - DAY_MS).all<{ uid: string }>();
      uids = (rows.results ?? []).map((r) => r.uid);
    }
    const mismatches = await reconcileXp(c.env, uids);
    return c.json({ checked: uids.length, mismatches });
  });

  adminRoute.get("/gamification/grants", async (c) => {
    requireFullAdmin(c);
    const status = c.req.query("status") || "claimable";
    const rows = await c.env.DB.prepare(
      `SELECT g.*, u.username FROM reward_grants g LEFT JOIN users u ON u.uid = g.uid WHERE g.status = ? ORDER BY g.created_at DESC LIMIT 200`,
    ).bind(status).all<any>();
    return c.json(rows.results ?? []);
  });
}
