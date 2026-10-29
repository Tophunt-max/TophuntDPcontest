/**
 * `/api` actions for the signed-in user's own progression. The caller is always
 * the verified token's uid; no action accepts a uid, an XP amount, an unlock or
 * an ownership claim. Mounted from routes/api.ts.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import { rateLimit } from "./rateLimit";
import { computeMetrics, syncProgression } from "./achievements";
import { equipCosmetic, loadAchievementDefs, loadCatalog, loadInventory, parseEquipped, pinAchievements, resolveCosmetics } from "./cosmetics";
import { creatorInsights } from "./creatorInsights";
import { experienceOn, featureLevel, getProgression, levelFor, type Progression } from "./progression";
import { claimQuest, listQuests } from "./quests";
import { claimRewardGrant, listGrants, rewardBudgetFor } from "./rewardGrants";
import { currentSeason, LEADERBOARD_PERIODS, myRank, rangeFor, type LeaderboardPeriod } from "./seasons";

export const GAMIFICATION_ACTIONS = new Set([
  "getProgression",
  "getAchievements",
  "getInventory",
  "equipCosmetic",
  "pinAchievements",
  "getQuests",
  "claimQuest",
  "getXpHistory",
  "claimRewardGrant",
  "getCreatorInsights",
  "getXpRank",
]);

const ACTION_LABELS: Record<string, string> = {
  vote: "Voted in a battle",
  contest_entry: "Entered a battle",
  match_win: "Won a battle",
  match_loss: "Finished a battle",
  daily_checkin: "Daily check-in",
  hall_of_fame: "Hall of Fame",
  daily_task: "Daily quest",
  quest: "Quest completed",
  achievement: "Achievement unlocked",
  admin_adjustment: "Adjustment by TopHunt",
  reversal: "Reversed",
  opening_balance: "XP before history began",
};

interface Ctx {
  env: Env;
  uid: string;
  body: any;
  waitUntil: (p: Promise<unknown>) => void;
  /** Purge the caller's shared profile cache after a visible change. */
  purgeProfile: () => void;
}

async function own(env: Env, uid: string) {
  const u = await env.DB.prepare(`SELECT xp, cosmetics FROM users WHERE uid = ?`).bind(uid).first<{ xp: number; cosmetics: string | null }>();
  if (!u) throw httpsError("not-found", "User not found.");
  return u;
}

/**
 * Coin-reward state of a milestone, from the user's own `reward_grants`:
 *   none        the milestone pays no coins
 *   pending     not reached yet
 *   claimable   reached; a grant is waiting to be claimed
 *   claimed     reached and paid
 *   ineligible  reached before coin rewards applied (no grant was created)
 */
export type MilestoneRewardState = "none" | "pending" | "claimable" | "claimed" | "ineligible";

async function roadmap(env: Env, p: Progression, level: number, owned: Set<string>, uid: string, on: boolean) {
  const catalog = new Map((await loadCatalog(env)).map((i) => [i.id, i]));
  const grants = new Map<string, string>();
  if (on && p.cfg.milestones.some((m) => m.coins > 0)) {
    const rows = await env.DB.prepare(`SELECT source_id, status FROM reward_grants WHERE uid = ? AND source_type = 'level'`).bind(uid).all<{ source_id: string; status: string }>();
    for (const r of rows.results ?? []) grants.set(r.source_id, r.status);
  }
  const rewardState = (m: { level: number; coins: number }): MilestoneRewardState => {
    if (!on || !(m.coins > 0)) return "none";
    if (level < m.level) return "pending";
    const g = grants.get(String(m.level));
    return g === "claimed" ? "claimed" : g === "claimable" ? "claimable" : "ineligible";
  };
  return [...p.cfg.milestones]
    .filter((m) => m.level <= p.curve.maxLevel)
    .sort((a, b) => a.level - b.level)
    .map((m) => ({
      level: m.level,
      title: m.title,
      description: m.description,
      feature: m.feature,
      coins: on ? m.coins : 0,
      unlocked: level >= m.level,
      rewardState: rewardState(m),
      items: m.items
        .map((id) => catalog.get(id))
        .filter((i) => !!i)
        .map((i) => ({ id: i!.id, type: i!.type, name: i!.name, rarity: i!.rarity, asset: i!.asset, owned: owned.has(i!.id) })),
    }));
}

export async function handleGamificationAction(action: string, ctx: Ctx): Promise<unknown> {
  const { env, uid, body } = ctx;
  const p = await getProgression(env);
  const on = experienceOn(p.cfg, uid);

  switch (action) {
    case "getProgression": {
      await rateLimit(env, `prog:${uid}`, 240, 3600);
      // Sync first, so the answer reflects anything earned in the background
      // (votes, settlement) and any level-up is announced exactly once.
      const sync = await syncProgression(env, uid, { p, full: true });
      if (!sync) throw httpsError("not-found", "User not found.");
      const u = await own(env, uid);
      const inv = await loadInventory(env, uid);
      const owned = new Set(inv.filter((i) => !i.revoked).map((i) => i.itemId));
      const recent = await env.DB.prepare(
        `SELECT id, action, delta, created_at FROM user_xp_events WHERE uid = ? AND action <> 'opening_balance' ORDER BY created_at DESC, id DESC LIMIT 10`,
      ).bind(uid).all<any>();
      const achCount = await env.DB.prepare(`SELECT COUNT(DISTINCT achievement_id) AS n FROM user_achievements WHERE uid = ?`).bind(uid).first<{ n: number }>();
      const defs = (await loadAchievementDefs(env)).filter((d) => d.active && !d.hidden);
      const season = on ? await currentSeason(env, p) : null;
      // Season XP only: one range read on the user's own (uid, day) primary key.
      // The global rank is an aggregate over every earner, so it is computed on
      // the leaderboard screen (getXpRank), never on every Rewards open.
      const seasonXp = season
        ? Number((await env.DB.prepare(
            `SELECT COALESCE(SUM(xp), 0) AS s FROM user_xp_daily WHERE uid = ? AND day BETWEEN ? AND ? AND action <> 'admin_adjustment'`,
          ).bind(uid, season.start_day, season.end_day).first<{ s: number }>())?.s ?? 0)
        : 0;
      // Unlocks the user may not have SEEN yet: background syncs (after a
      // check-in, a join, the cron) usually write them before this call. The
      // app dedupes per device by id + tier, so returning a recent window is safe.
      const recentUnlocks = on
        ? (await env.DB.prepare(
            `SELECT achievement_id, tier, xp_awarded FROM user_achievements
              WHERE uid = ? AND source <> 'backfill' AND unlocked_at > ? ORDER BY unlocked_at DESC LIMIT 5`,
          ).bind(uid, Date.now() - 7 * 86_400_000).all<any>()).results ?? []
        : [];
      const grants = on ? (await listGrants(env, uid)).filter((g) => g.status === "claimable") : [];
      return {
        enabled: on,
        levelInfo: sync.levelInfo,
        leveledUp: sync.leveledUp,
        newlyUnlocked: (() => {
          const byId = new Map(defs.map((d) => [d.id, d]));
          const out = [...sync.unlocked];
          for (const r of recentUnlocks) {
            const d = byId.get(r.achievement_id);
            if (d && !out.some((u) => u.id === d.id && u.tier === Number(r.tier))) {
              out.push({ id: d.id, name: d.name, icon: d.icon, rarity: d.rarity, tier: Number(r.tier), xp: Number(r.xp_awarded) });
            }
          }
          return out.slice(0, 5);
        })(),
        cosmetics: await resolveCosmetics(env, u.cosmetics),
        roadmap: await roadmap(env, p, sync.levelInfo.level, owned, uid, on),
        recentXp: (recent.results ?? []).map((r) => ({ id: r.id, action: r.action, label: ACTION_LABELS[r.action] ?? r.action, delta: Number(r.delta), createdAt: Number(r.created_at) })),
        achievements: { unlocked: Number(achCount?.n || 0), total: defs.length },
        pinnedLimit: p.cfg.pinnedLimit,
        showcaseUnlocksAt: featureLevel(p.cfg, "achievement_showcase") ?? 1,
        season: season
          ? { id: season.id, name: season.name, endsAt: season.ends_at, xp: seasonXp, rank: null }
          : null,
        rewards: {
          claimable: grants,
          budgetAvailable: grants.length ? !!(await rewardBudgetFor(env, p)) : true,
        },
      };
    }

    case "getAchievements": {
      const defs = await loadAchievementDefs(env);
      const mine = await env.DB.prepare(`SELECT achievement_id, tier, unlocked_at, xp_awarded FROM user_achievements WHERE uid = ?`).bind(uid).all<any>();
      const byId = new Map<string, { tier: number; unlockedAt: number; xp: number }>();
      for (const r of mine.results ?? []) {
        const cur = byId.get(r.achievement_id);
        if (!cur || r.tier > cur.tier) byId.set(r.achievement_id, { tier: Number(r.tier), unlockedAt: Number(r.unlocked_at), xp: Number(r.xp_awarded) });
      }
      const user = await env.DB.prepare(
        `SELECT uid, xp, level_seen, streak, wins, verified, status, profile_image_url, full_name, username, bio FROM users WHERE uid = ?`,
      ).bind(uid).first<any>();
      const metrics: Record<string, number> = user ? await computeMetrics(env, user, new Set(defs.map((d) => d.metric))) : {};
      const pinned = parseEquipped((await own(env, uid)).cosmetics).pinned ?? [];
      return {
        pinned,
        pinnedLimit: p.cfg.pinnedLimit,
        achievements: defs
          // Hidden achievements stay secret until unlocked; inactive ones show only if earned.
          .filter((d) => (d.active && !d.hidden) || byId.has(d.id))
          .map((d) => {
            const got = byId.get(d.id);
            const maxTier = d.repeatable ? d.maxTiers : 1;
            const nextTier = Math.min(maxTier, (got?.tier ?? 0) + 1);
            const value = metrics[d.metric] ?? 0;
            return {
              id: d.id,
              name: d.name,
              description: d.description,
              icon: d.icon,
              category: d.category,
              rarity: d.rarity,
              xpReward: d.xpReward,
              itemId: d.itemId,
              repeatable: d.repeatable,
              tier: got?.tier ?? 0,
              maxTier,
              unlocked: !!got,
              unlockedAt: got?.unlockedAt ?? null,
              progress: d.metric === "manual" ? null : Math.min(value, d.threshold * nextTier),
              target: d.metric === "manual" ? null : d.threshold * nextTier,
              endsAt: d.endsAt,
            };
          }),
      };
    }

    case "getInventory": {
      const u = await own(env, uid);
      const inv = await loadInventory(env, uid);
      const held = new Map(inv.map((i) => [i.itemId, i]));
      const level = levelFor(u.xp ?? 0, p.curve);
      const unlockAt = new Map<string, number>();
      for (const m of p.cfg.milestones) for (const id of m.items) if (!unlockAt.has(id)) unlockAt.set(id, m.level);
      const equipped = parseEquipped(u.cosmetics);
      return {
        level,
        equipped,
        items: (await loadCatalog(env))
          .filter((i) => i.active || held.has(i.id))
          .map((i) => {
            const h = held.get(i.id);
            return {
              id: i.id,
              type: i.type,
              name: i.name,
              description: i.description,
              rarity: i.rarity,
              asset: i.asset,
              owned: !!h && !h.revoked,
              acquiredAt: h && !h.revoked ? h.acquiredAt : null,
              unlocksAtLevel: unlockAt.get(i.id) ?? null,
              equipped: Object.values(equipped).includes(i.id),
            };
          }),
      };
    }

    case "equipCosmetic": {
      await rateLimit(env, `equip:${uid}`, 120, 3600);
      await equipCosmetic(env, uid, body.slot, body.itemId ?? null);
      ctx.purgeProfile();
      return { success: true, cosmetics: await resolveCosmetics(env, (await own(env, uid)).cosmetics) };
    }

    case "pinAchievements": {
      await rateLimit(env, `pin:${uid}`, 60, 3600);
      const u = await own(env, uid);
      const at = featureLevel(p.cfg, "achievement_showcase") ?? 1;
      if (levelFor(u.xp ?? 0, p.curve) < at) throw httpsError("failed-precondition", `The achievement showcase unlocks at level ${at}.`);
      const pinned = await pinAchievements(env, uid, body.achievementIds, p.cfg.pinnedLimit);
      ctx.purgeProfile();
      return { success: true, pinned };
    }

    case "getQuests": {
      if (!on) return { enabled: false, quests: [] };
      const u = await own(env, uid);
      return { enabled: true, quests: await listQuests(env, uid, p, u.xp ?? 0) };
    }

    case "claimQuest": {
      if (!on) throw httpsError("failed-precondition", "Quests are not available yet.");
      await rateLimit(env, `quest:${uid}`, 30, 3600, { failClosed: true });
      const res = await claimQuest(env, uid, p, body.questId);
      ctx.waitUntil(syncProgression(env, uid, { p }).catch(() => undefined));
      return { success: true, ...res };
    }

    case "getXpHistory": {
      await rateLimit(env, `xphist:${uid}`, 240, 3600);
      const limit = Math.min(50, Math.max(1, Number(body.limit) || 30));
      // Keyset cursor "<created_at>:<id>" on idx_xp_events_uid_created.
      let cursorTs = Number.MAX_SAFE_INTEGER;
      let cursorId = "\uffff";
      if (typeof body.cursor === "string" && body.cursor) {
        const i = body.cursor.indexOf(":");
        const ts = Number(body.cursor.slice(0, i));
        if (i <= 0 || !Number.isFinite(ts)) throw httpsError("invalid-argument", "Invalid cursor.");
        cursorTs = ts;
        cursorId = body.cursor.slice(i + 1);
      }
      const rows = await env.DB.prepare(
        `SELECT id, action, delta, source_type, created_at, reverses FROM user_xp_events
          WHERE uid = ? AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).bind(uid, cursorTs, cursorTs, cursorId, limit + 1).all<any>();
      const list = rows.results ?? [];
      const page = list.slice(0, limit);
      return {
        // Reasons are staff notes and never leave the admin panel.
        events: page.map((r) => ({
          id: r.id,
          action: r.action,
          label: ACTION_LABELS[r.action] ?? r.action,
          delta: Number(r.delta),
          sourceType: r.source_type ?? null,
          reversed: !!r.reverses,
          createdAt: Number(r.created_at),
        })),
        nextCursor: list.length > limit ? `${page[page.length - 1].created_at}:${page[page.length - 1].id}` : null,
      };
    }

    case "claimRewardGrant": {
      await rateLimit(env, `grant:${uid}`, 30, 3600, { failClosed: true });
      const res = await claimRewardGrant(env, uid, p, body.grantId, ctx.waitUntil);
      return { success: true, ...res };
    }

    case "getCreatorInsights": {
      await rateLimit(env, `insights:${uid}`, 60, 3600);
      return await creatorInsights(env, uid, p);
    }

    case "getXpRank": {
      const period = (LEADERBOARD_PERIODS as string[]).includes(body.period) ? (body.period as LeaderboardPeriod) : "lifetime";
      await rateLimit(env, `xprank:${uid}`, 120, 3600);
      const range = await rangeFor(env, p, period);
      if (period === "season" && !range) return { period, rank: null, score: 0, season: null };
      const r = await myRank(env, uid, range);
      return { period, ...r, label: range?.label ?? "All time", endsAt: range?.endsAt ?? null };
    }
  }
  throw httpsError("invalid-argument", `Unknown action ${action}.`);
}
