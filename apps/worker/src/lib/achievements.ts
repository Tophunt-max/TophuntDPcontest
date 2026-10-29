/**
 * Progression sync: achievements, level-up detection, milestone unlocks and
 * review flags for one user.
 *
 * Runs after a user's own actions (check-in, task, quest, entry), after match
 * settlement, from the hourly cron for recent XP earners, and whenever the app
 * reads `getProgression`. It is safe to run any number of times, concurrently:
 *
 *   - Level-ups are detected against `users.level_seen` with a compare-and-set
 *     UPDATE, so exactly one run announces a given level-up.
 *   - Achievements are INSERT OR IGNORE on (uid, achievement, tier), and their
 *     XP uses the deterministic event id `achievement:<id>:<tier>:<uid>`.
 *   - Items are INSERT OR IGNORE on (uid, item).
 *
 * The FIRST sync of an account (level_seen IS NULL) is silent: it records the
 * current level and every achievement already met, grants the cosmetics for
 * levels already reached, but awards no XP, pays nothing and sends nothing. So
 * launching this does not hand existing users a lump of retroactive XP or a
 * burst of notifications. While the experience is switched off
 * (progression.enabled) every sync stays silent in the same way.
 *
 * Achievements are only ever decided here, from server-side data. No client
 * input reaches this module.
 */
import type { Env } from "../types";
import { createNotification } from "./notify";
import { experienceOn, getProgression, levelInfo, milestonesUpTo, type LevelInfo, type Progression } from "./progression";
import { rewardDayNumber } from "./gamification";
import { grantItemStatements, loadAchievementDefs, type AchievementDef } from "./cosmetics";
import { xpAwardStatements } from "./xpService";

/** Metrics an achievement can be defined on. All computed on the server. */
export const ACHIEVEMENT_METRICS = [
  "profile_complete",
  "entries",
  "photo_entries",
  "video_entries",
  "completed_battles",
  "wins",
  "verified_wins",
  "votes",
  "streak",
  "active_days",
  "season_top",
  "manual",
] as const;
export type AchievementMetric = (typeof ACHIEVEMENT_METRICS)[number];

/**
 * A contest entry's ledger id is `contest_entry:<matchId>:<uid>` (startMatch and
 * joinMatch both write it), so the match is recoverable from the ledger row the
 * entry fee already wrote — with the ledger's uid index — instead of scanning
 * contest_matches' JSON participant columns.
 */
export const ENTRY_MATCH_JOIN = `JOIN contest_matches m ON m.id = substr(t.id, 15, length(t.id) - 15 - length(t.uid))`;
export const ENTRY_ROWS = `t.type = 'contest_entry_fee' AND t.id LIKE 'contest_entry:%'`;
/** An entry counts once its battle actually ran (an opponent joined). */
export const VALID_ENTRY_STATUS = `m.status IN ('active', 'completed', 'ended')`;

interface UserRow {
  uid: string;
  xp: number | null;
  level_seen: number | null;
  streak: number | null;
  wins: number | null;
  verified: number | null;
  status: string | null;
  profile_image_url: string | null;
  full_name: string | null;
  username: string | null;
  bio: string | null;
}

const filled = (v: unknown) => typeof v === "string" && v.trim().length > 0;

export function profileComplete(u: Pick<UserRow, "profile_image_url" | "full_name" | "username" | "bio">): boolean {
  return filled(u.profile_image_url) && filled(u.full_name) && filled(u.username) && filled(u.bio);
}

/** Compute only the metrics `needed` names. */
export async function computeMetrics(env: Env, user: UserRow, needed: Set<string>): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const uid = user.uid;
  if (needed.has("profile_complete")) out.profile_complete = profileComplete(user) ? 1 : 0;
  if (needed.has("wins")) out.wins = Number(user.wins) || 0;
  if (needed.has("verified_wins")) out.verified_wins = user.verified ? Number(user.wins) || 0 : 0;
  if (needed.has("streak")) out.streak = Number(user.streak) || 0;
  if (needed.has("manual")) out.manual = 0;
  if (["entries", "photo_entries", "video_entries", "completed_battles"].some((k) => needed.has(k))) {
    const rows = await env.DB.prepare(
      `SELECT m.type AS type,
              SUM(CASE WHEN ${VALID_ENTRY_STATUS} THEN 1 ELSE 0 END) AS valid,
              SUM(CASE WHEN m.status IN ('completed', 'ended') THEN 1 ELSE 0 END) AS done
         FROM coin_transactions t ${ENTRY_MATCH_JOIN}
        WHERE t.uid = ? AND ${ENTRY_ROWS}
        GROUP BY m.type`,
    ).bind(uid).all<{ type: string | null; valid: number; done: number }>();
    let entries = 0, photo = 0, video = 0, done = 0;
    for (const r of rows.results ?? []) {
      entries += Number(r.valid) || 0;
      done += Number(r.done) || 0;
      if (r.type === "video") video += Number(r.valid) || 0;
      else photo += Number(r.valid) || 0;
    }
    Object.assign(out, { entries, photo_entries: photo, video_entries: video, completed_battles: done });
  }
  if (needed.has("votes")) {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM votes WHERE voter_uid = ?`).bind(uid).first<{ n: number }>();
    out.votes = Number(r?.n || 0);
  }
  if (needed.has("active_days")) {
    const r = await env.DB.prepare(
      `SELECT COUNT(DISTINCT day) AS n FROM user_xp_daily WHERE uid = ? AND xp > 0 AND action NOT IN ('admin_adjustment', 'reversal')`,
    ).bind(uid).first<{ n: number }>();
    out.active_days = Number(r?.n || 0);
  }
  if (needed.has("season_top")) {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM season_results WHERE uid = ? AND rewards <> '[]'`).bind(uid).first<{ n: number }>();
    out.season_top = Number(r?.n || 0);
  }
  return out;
}

/** Highest tier a metric value has earned for `def`, bounded by maxTiers. */
export function tierFor(def: Pick<AchievementDef, "threshold" | "repeatable" | "maxTiers">, value: number): number {
  if (!(def.threshold >= 1)) return 0;
  const tiers = Math.floor(value / def.threshold);
  return Math.max(0, Math.min(def.repeatable ? def.maxTiers : 1, tiers));
}

const inWindow = (d: AchievementDef, ts: number) => (d.startsAt == null || ts >= d.startsAt) && (d.endsAt == null || ts < d.endsAt);

export interface UnlockedAchievement {
  id: string;
  name: string;
  icon: string;
  rarity: string;
  tier: number;
  xp: number;
}

export interface SyncResult {
  levelInfo: LevelInfo;
  leveledUp: { from: number; to: number } | null;
  unlocked: UnlockedAchievement[];
  newItems: string[];
}

async function loadUser(env: Env, uid: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT uid, xp, level_seen, streak, wins, verified, status, profile_image_url, full_name, username, bio
       FROM users WHERE uid = ?`,
  ).bind(uid).first<UserRow>();
}

/**
 * Evaluate achievements. `silent` records unlocks without XP or notifications.
 * Returns the unlocks THIS run wrote.
 */
async function evaluateAchievements(env: Env, p: Progression, user: UserRow, silent: boolean, ts: number): Promise<UnlockedAchievement[]> {
  const defs = (await loadAchievementDefs(env)).filter((d) => d.active && d.metric !== "manual" && inWindow(d, ts));
  if (!defs.length) return [];
  const have = await env.DB.prepare(`SELECT achievement_id, MAX(tier) AS tier FROM user_achievements WHERE uid = ? GROUP BY achievement_id`)
    .bind(user.uid)
    .all<{ achievement_id: string; tier: number }>();
  const top = new Map((have.results ?? []).map((r) => [r.achievement_id, Number(r.tier)]));
  const open = defs.filter((d) => (top.get(d.id) ?? 0) < (d.repeatable ? d.maxTiers : 1));
  if (!open.length) return [];
  const metrics = await computeMetrics(env, user, new Set(open.map((d) => d.metric)));

  const statements: D1PreparedStatement[] = [];
  const pending: { def: AchievementDef; tier: number; insertIndex: number }[] = [];
  for (const def of open) {
    const earned = tierFor(def, metrics[def.metric] ?? 0);
    for (let tier = (top.get(def.id) ?? 0) + 1; tier <= earned; tier++) {
      const eventId = `achievement:${def.id}:${tier}:${user.uid}`;
      const insertIndex = statements.length;
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO user_achievements (uid, achievement_id, tier, unlocked_at, xp_awarded, event_id, source)
           VALUES (?, ?, ?, ?, 0, ?, ?)`,
        ).bind(user.uid, def.id, tier, ts, silent ? null : eventId, silent ? "backfill" : "progress"),
      );
      if (!silent && def.xpReward > 0) {
        const award = xpAwardStatements(env, p, {
          uid: user.uid,
          action: "achievement",
          eventId,
          amount: def.xpReward,
          sourceType: "achievement",
          sourceId: def.id,
          ts,
          // Only for the row THIS achievement path wrote (a silently backfilled
          // row has event_id NULL and never pays).
          gate: `EXISTS (SELECT 1 FROM user_achievements WHERE uid = ? AND achievement_id = ? AND tier = ? AND event_id = ?)`,
          gateArgs: [user.uid, def.id, tier, eventId],
        });
        statements.push(...award.statements);
        statements.push(
          env.DB.prepare(
            `UPDATE user_achievements SET xp_awarded = COALESCE((SELECT delta FROM user_xp_events WHERE id = ?), 0)
              WHERE uid = ? AND achievement_id = ? AND tier = ? AND event_id = ?`,
          ).bind(eventId, user.uid, def.id, tier, eventId),
        );
      }
      if (def.itemId) statements.push(...grantItemStatements(env, user.uid, [def.itemId], "achievement", def.id, ts));
      pending.push({ def, tier, insertIndex });
    }
  }
  if (!statements.length) return [];
  const results = await env.DB.batch(statements);
  return pending
    .filter((x) => Number(results[x.insertIndex]?.meta?.changes || 0) > 0)
    .map((x) => ({
      id: x.def.id,
      name: x.def.name,
      icon: x.def.icon,
      rarity: x.def.rarity,
      tier: x.tier,
      xp: silent ? 0 : x.def.xpReward,
    }));
}

/** Items for every milestone at or below `level` that the user does not hold yet. */
async function grantMilestoneItems(env: Env, p: Progression, uid: string, level: number, ts: number): Promise<string[]> {
  const wanted = new Map<string, number>();
  for (const ms of milestonesUpTo(p.cfg, level)) for (const it of ms.items) if (!wanted.has(it)) wanted.set(it, ms.level);
  if (!wanted.size) return [];
  const held = await env.DB.prepare(`SELECT item_id FROM user_inventory WHERE uid = ?`).bind(uid).all<{ item_id: string }>();
  const heldSet = new Set((held.results ?? []).map((r) => r.item_id));
  const missing = [...wanted.keys()].filter((i) => !heldSet.has(i));
  if (!missing.length) return [];
  const stmts = missing.flatMap((it) => grantItemStatements(env, uid, [it], "level", `level:${wanted.get(it)}`, ts));
  const res = await env.DB.batch(stmts);
  return missing.filter((_, i) => Number(res[i]?.meta?.changes || 0) > 0);
}

/** Coin rewards for milestones crossed in (from, to]: claimable grants, paid later through the reward budget. */
function milestoneGrantStatements(env: Env, p: Progression, uid: string, from: number, to: number, ts: number): D1PreparedStatement[] {
  return p.cfg.milestones
    .filter((ms) => ms.level > from && ms.level <= to && Number(ms.coins) > 0)
    .map((ms) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO reward_grants (id, uid, source_type, source_id, coins, status, note, created_at, updated_at)
         VALUES (?, ?, 'level', ?, ?, 'claimable', ?, ?, ?)`,
      ).bind(`level:${ms.level}:${uid}`, uid, String(ms.level), Math.floor(ms.coins), `Level ${ms.level}: ${ms.title}`, ts, ts),
    );
}

/** Raise a review flag (never a block) when one action's events today pass the threshold. */
async function velocityFlags(env: Env, p: Progression, uid: string, ts: number): Promise<void> {
  const day = rewardDayNumber(ts, p.settings.dayResetOffsetMinutes);
  const rows = await env.DB.prepare(`SELECT action, events, xp FROM user_xp_daily WHERE uid = ? AND day = ? AND events >= ?`)
    .bind(uid, day, p.cfg.velocityFlagEvents)
    .all<{ action: string; events: number; xp: number }>();
  for (const r of rows.results ?? []) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO xp_flags (id, uid, kind, detail, status, created_at) VALUES (?, ?, 'velocity', ?, 'open', ?)`,
    ).bind(`velocity:${uid}:${day}:${r.action}`, uid, JSON.stringify({ day, action: r.action, events: r.events, xp: r.xp }), ts).run();
  }
}

export async function syncProgression(env: Env, uid: string, opts: { p?: Progression; full?: boolean } = {}): Promise<SyncResult | null> {
  const p = opts.p ?? (await getProgression(env));
  let user = await loadUser(env, uid);
  if (!user || user.status === "deleted") return null;
  const ts = Date.now();
  const first = user.level_seen == null;
  const on = experienceOn(p.cfg, uid);
  const silent = first || !on;

  // Achievements can award XP, which can level the user up, which can (in
  // principle) satisfy another achievement. Bounded loop.
  const unlocked: UnlockedAchievement[] = [];
  if (on || first) {
    for (let i = 0; i < 3; i++) {
      const got = await evaluateAchievements(env, p, user, silent, ts);
      unlocked.push(...got);
      if (!got.some((g) => g.xp > 0)) break;
      user = (await loadUser(env, uid)) ?? user;
    }
  }

  const info = levelInfo(user.xp ?? 0, p.curve, p.cfg);
  let leveledUp: SyncResult["leveledUp"] = null;
  let newItems: string[] = [];

  if (first) {
    await env.DB.prepare(`UPDATE users SET level_seen = ? WHERE uid = ? AND level_seen IS NULL`).bind(info.level, uid).run();
    newItems = await grantMilestoneItems(env, p, uid, info.level, ts);
  } else if (info.level > Number(user.level_seen)) {
    const from = Number(user.level_seen);
    const cas = await env.DB.prepare(`UPDATE users SET level_seen = ? WHERE uid = ? AND level_seen = ?`).bind(info.level, uid, from).run();
    if (Number(cas.meta?.changes || 0) > 0) {
      newItems = await grantMilestoneItems(env, p, uid, info.level, ts);
      if (on) {
        leveledUp = { from, to: info.level };
        const grants = milestoneGrantStatements(env, p, uid, from, info.level, ts);
        if (grants.length) await env.DB.batch(grants);
        const unlockedNames = p.cfg.milestones.filter((ms) => ms.level > from && ms.level <= info.level).map((ms) => ms.title);
        await createNotification(env, uid, {
          title: `Level up! You're now level ${info.level} 🎉`,
          body: unlockedNames.length
            ? `Unlocked: ${unlockedNames.slice(0, 3).join(", ")}${unlockedNames.length > 3 ? " and more" : ""}.`
            : `Rank: ${info.rank.name}. Keep going!`,
          type: "level_up",
          targetId: "rewards",
          data: { level: String(info.level) },
        }).catch((e) => console.error("[progression] level-up notification failed", uid, e));
      }
    }
  } else if (opts.full) {
    // Catch up items added to milestones the user already passed.
    newItems = await grantMilestoneItems(env, p, uid, info.level, ts);
  }

  if (on && !silent) {
    const shown = unlocked.filter((u) => u.tier >= 1).slice(0, 3);
    for (const a of shown) {
      await createNotification(env, uid, {
        title: `Achievement unlocked: ${a.name} 🏅`,
        body: a.xp > 0 ? `+${a.xp} XP` : "Added to your collection.",
        type: "achievement",
        targetId: "achievements",
        data: { achievementId: a.id },
      }).catch((e) => console.error("[progression] achievement notification failed", uid, e));
    }
    await velocityFlags(env, p, uid, ts).catch((e) => console.error("[progression] velocity flag failed", uid, e));
  }

  return { levelInfo: info, leveledUp, unlocked: silent ? [] : unlocked, newItems };
}

/** Fire-and-forget wrapper for waitUntil: a sync failure never fails the action. */
export async function syncProgressionSafe(env: Env, uid: string): Promise<void> {
  try {
    await syncProgression(env, uid);
  } catch (e) {
    console.error("[progression] sync failed", uid, e);
  }
}

/**
 * Staff-granted achievement (e.g. "Community Contributor", metric `manual`).
 * Pays its XP through the ledger. Idempotent per (user, achievement, tier 1).
 */
export async function grantAchievementManually(
  env: Env,
  uid: string,
  achievementId: string,
  actor: string,
  reason: string,
): Promise<{ granted: boolean }> {
  const p = await getProgression(env);
  const def = (await loadAchievementDefs(env)).find((d) => d.id === achievementId);
  if (!def) throw new Error("Unknown achievement.");
  const ts = Date.now();
  const eventId = `achievement:${def.id}:1:${uid}`;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO user_achievements (uid, achievement_id, tier, unlocked_at, xp_awarded, event_id, source)
       SELECT ?, ?, 1, ?, 0, ?, 'manual' WHERE EXISTS (SELECT 1 FROM users WHERE uid = ?)`,
    ).bind(uid, def.id, ts, eventId, uid),
  ];
  if (def.xpReward > 0) {
    statements.push(
      ...xpAwardStatements(env, p, {
        uid,
        action: "achievement",
        eventId,
        amount: def.xpReward,
        sourceType: "achievement",
        sourceId: def.id,
        reason,
        actor,
        ts,
        gate: `EXISTS (SELECT 1 FROM user_achievements WHERE uid = ? AND achievement_id = ? AND tier = 1 AND event_id = ?)`,
        gateArgs: [uid, def.id, eventId],
      }).statements,
    );
  }
  if (def.itemId) statements.push(...grantItemStatements(env, uid, [def.itemId], "achievement", def.id, ts));
  const res = await env.DB.batch(statements);
  return { granted: Number(res[0]?.meta?.changes || 0) > 0 };
}

/** Review flag for a same-device battle (both sides). Best-effort, idempotent. */
export async function flagSameDeviceMatch(env: Env, matchId: string, uids: string[]): Promise<void> {
  try {
    const ts = Date.now();
    await env.DB.batch(
      uids.map((uid) =>
        env.DB.prepare(`INSERT OR IGNORE INTO xp_flags (id, uid, kind, detail, status, created_at) VALUES (?, ?, 'same_device_match', ?, 'open', ?)`)
          .bind(`same_device:${matchId}:${uid}`, uid, JSON.stringify({ matchId, with: uids.filter((u) => u !== uid) }), ts),
      ),
    );
  } catch (e) {
    console.error("[progression] same-device flag failed", matchId, e);
  }
}
