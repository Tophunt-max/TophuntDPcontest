/**
 * XP leaderboards (lifetime, weekly, monthly, seasonal), seasons and the Hall
 * of Fame.
 *
 * Lifetime XP is `users.xp`. Period XP (week / month / season) is the sum of
 * `user_xp_daily` over the period's reward days, so the two are separate
 * counters: a season ending resets nothing, it just stops counting. Admin
 * adjustments are excluded from period rankings; reversals reduce the period
 * that earned the reversed XP.
 *
 * Ranking order (documented tie-break, deterministic):
 *   1. period XP, highest first
 *   2. lifetime XP, highest first
 *   3. account age, oldest first
 *   4. uid, ascending
 * A rank is the position in that order, so ties never share a rank.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import { rewardDayNumber } from "./gamification";
import { createNotificationsBulk } from "./notify";
import { getProgression, xpForLevel, featureLevel, type Progression } from "./progression";
import { monthPeriod, weekPeriod } from "./quests";
import { grantItemStatements } from "./cosmetics";

const DAY_MS = 86_400_000;
/** Same visibility rule as read.ts `discoverableUser`. */
export const DISCOVERABLE = `(u.status IS NULL OR u.status NOT IN ('blocked', 'pending_deletion', 'deleted')) AND COALESCE(u.signup_completed, 0) = 1`;
/** Actions that never count towards a period ranking. */
const PERIOD_EXCLUDED = `'admin_adjustment'`;

export type LeaderboardPeriod = "lifetime" | "week" | "month" | "season";
export const LEADERBOARD_PERIODS: LeaderboardPeriod[] = ["lifetime", "week", "month", "season"];

export interface SeasonRow {
  id: string;
  name: string;
  description: string;
  starts_at: number;
  ends_at: number;
  start_day: number;
  end_day: number;
  status: string;
  top_n: number;
  rewards: string;
  policy_version: number;
  finalized_at: number | null;
}

export interface SeasonReward {
  fromRank: number;
  toRank: number;
  coins: number;
  itemId: string | null;
}

export function parseSeasonRewards(raw: unknown): SeasonReward[] {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function validateSeasonInput(b: any, maxRank = 1000): {
  name: string; description: string; startsAt: number; endsAt: number; topN: number; rewards: SeasonReward[];
} {
  const name = typeof b?.name === "string" ? b.name.trim() : "";
  if (!name || name.length > 80) throw httpsError("invalid-argument", "name is required (max 80 characters).");
  const description = typeof b?.description === "string" ? b.description.slice(0, 500) : "";
  const startsAt = Number(b?.startsAt);
  const endsAt = Number(b?.endsAt);
  if (!Number.isInteger(startsAt) || !Number.isInteger(endsAt) || startsAt <= 0 || endsAt <= startsAt) {
    throw httpsError("invalid-argument", "startsAt and endsAt must be dates, with the end after the start.");
  }
  if (endsAt - startsAt > 366 * DAY_MS) throw httpsError("invalid-argument", "A season can last at most a year.");
  const topN = b?.topN === undefined ? 100 : Number(b.topN);
  if (!Number.isInteger(topN) || topN < 1 || topN > maxRank) throw httpsError("invalid-argument", `topN must be 1-${maxRank}.`);
  const rewards = b?.rewards === undefined ? [] : b.rewards;
  if (!Array.isArray(rewards) || rewards.length > 20) throw httpsError("invalid-argument", "rewards must be a list of at most 20 bands.");
  const clean: SeasonReward[] = [];
  for (const r of rewards) {
    const fromRank = Number(r?.fromRank), toRank = Number(r?.toRank), coins = Number(r?.coins ?? 0);
    if (!Number.isInteger(fromRank) || !Number.isInteger(toRank) || fromRank < 1 || toRank < fromRank || toRank > topN) {
      throw httpsError("invalid-argument", `Each reward band needs 1 <= fromRank <= toRank <= topN (${topN}).`);
    }
    if (!Number.isInteger(coins) || coins < 0 || coins > 100_000) throw httpsError("invalid-argument", "Reward coins must be 0-100,000.");
    const itemId = r?.itemId ? String(r.itemId) : null;
    if (itemId && !/^[a-z0-9_-]{2,40}$/.test(itemId)) throw httpsError("invalid-argument", "Invalid reward itemId.");
    if (!coins && !itemId) throw httpsError("invalid-argument", "A reward band needs coins or an item.");
    clean.push({ fromRank, toRank, coins, itemId });
  }
  const sorted = [...clean].sort((a, b) => a.fromRank - b.fromRank);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].fromRank <= sorted[i - 1].toRank) throw httpsError("invalid-argument", "Reward bands must not overlap.");
  }
  return { name, description, startsAt, endsAt, topN, rewards: sorted };
}

/** The season covering today, if any. */
export async function currentSeason(env: Env, p: Progression, ts = Date.now()): Promise<SeasonRow | null> {
  const today = rewardDayNumber(ts, p.settings.dayResetOffsetMinutes);
  return env.DB.prepare(
    `SELECT * FROM seasons WHERE status IN ('scheduled', 'active') AND start_day <= ? AND end_day >= ? ORDER BY start_day DESC LIMIT 1`,
  ).bind(today, today).first<SeasonRow>();
}

export interface DayRange {
  startDay: number;
  endDay: number;
  label: string;
  seasonId?: string;
  endsAt?: number;
}

export async function rangeFor(env: Env, p: Progression, period: LeaderboardPeriod, ts = Date.now()): Promise<DayRange | null> {
  const off = p.settings.dayResetOffsetMinutes;
  if (period === "week") {
    const w = weekPeriod(ts, off);
    return { startDay: w.startDay, endDay: w.endDay, label: "This week", endsAt: w.endMs };
  }
  if (period === "month") {
    const mo = monthPeriod(ts, off);
    return { startDay: mo.startDay, endDay: mo.endDay, label: "This month", endsAt: mo.endMs };
  }
  if (period === "season") {
    const s = await currentSeason(env, p, ts);
    return s ? { startDay: s.start_day, endDay: s.end_day, label: s.name, seasonId: s.id, endsAt: s.ends_at } : null;
  }
  return null;
}

export interface RankRow {
  rank: number;
  uid: string;
  username: string | null;
  fullName: string | null;
  profileImageUrl: string | null;
  verified: boolean;
  score: number;
  lifetimeXp: number;
}

const toRow = (r: any, rank: number): RankRow => ({
  rank,
  uid: r.uid,
  username: r.username ?? null,
  fullName: r.full_name ?? null,
  profileImageUrl: r.profile_image_url ?? null,
  verified: !!r.verified,
  score: Number(r.score) || 0,
  lifetimeXp: Number(r.lifetime) || 0,
});

const PERIOD_SCORES = `SELECT uid, SUM(xp) AS score FROM user_xp_daily
   WHERE day BETWEEN ? AND ? AND action NOT IN (${PERIOD_EXCLUDED}) GROUP BY uid HAVING SUM(xp) > 0`;

/** One page of a leaderboard. Only public profile fields. */
export async function leaderboardPage(env: Env, range: DayRange | null, offset: number, limit: number): Promise<RankRow[]> {
  if (!range) {
    const rows = await env.DB.prepare(
      `SELECT u.uid, u.username, u.full_name, u.profile_image_url, u.verified, u.xp AS score, u.xp AS lifetime
         FROM users u WHERE ${DISCOVERABLE} AND COALESCE(u.xp, 0) > 0
        ORDER BY u.xp DESC, u.created_at ASC, u.uid ASC LIMIT ? OFFSET ?`,
    ).bind(limit, offset).all<any>();
    return (rows.results ?? []).map((r, i) => toRow(r, offset + i + 1));
  }
  const rows = await env.DB.prepare(
    `SELECT u.uid, u.username, u.full_name, u.profile_image_url, u.verified, s.score, COALESCE(u.xp, 0) AS lifetime
       FROM (${PERIOD_SCORES}) s JOIN users u ON u.uid = s.uid
      WHERE ${DISCOVERABLE}
      ORDER BY s.score DESC, lifetime DESC, u.created_at ASC, u.uid ASC LIMIT ? OFFSET ?`,
  ).bind(range.startDay, range.endDay, limit, offset).all<any>();
  return (rows.results ?? []).map((r, i) => toRow(r, offset + i + 1));
}

/** The caller's own position under the same ordering, or null when unranked. */
export async function myRank(env: Env, uid: string, range: DayRange | null): Promise<{ rank: number | null; score: number }> {
  const me = await env.DB.prepare(`SELECT u.uid, COALESCE(u.xp, 0) AS xp, u.created_at, (${DISCOVERABLE}) AS visible FROM users u WHERE u.uid = ?`)
    .bind(uid).first<{ xp: number; created_at: number; visible: number }>();
  if (!me) return { rank: null, score: 0 };
  let score = Number(me.xp);
  if (range) {
    const s = await env.DB.prepare(
      `SELECT COALESCE(SUM(xp), 0) AS score FROM user_xp_daily WHERE uid = ? AND day BETWEEN ? AND ? AND action NOT IN (${PERIOD_EXCLUDED})`,
    ).bind(uid, range.startDay, range.endDay).first<{ score: number }>();
    score = Number(s?.score || 0);
  }
  if (!me.visible || score <= 0) return { rank: null, score };
  const ahead = `(s.score > ? OR (s.score = ? AND (lifetime > ? OR (lifetime = ? AND (u.created_at < ? OR (u.created_at = ? AND u.uid < ?))))))`;
  const args = [score, score, me.xp, me.xp, me.created_at, me.created_at, uid];
  const row = range
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM (${PERIOD_SCORES}) s JOIN users u ON u.uid = s.uid
          WHERE ${DISCOVERABLE} AND ${ahead.replace(/lifetime/g, "COALESCE(u.xp, 0)")}`,
      ).bind(range.startDay, range.endDay, ...args).first<{ n: number }>()
    : await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM users u WHERE ${DISCOVERABLE} AND COALESCE(u.xp, 0) > 0
           AND ${ahead.replace(/s\.score/g, "COALESCE(u.xp, 0)").replace(/lifetime/g, "COALESCE(u.xp, 0)")}`,
      ).bind(...args).first<{ n: number }>();
  return { rank: Number(row?.n || 0) + 1, score };
}

// ---------------------------------------------------------------------------
// Season lifecycle (hourly cron)
// ---------------------------------------------------------------------------

/**
 * Activate due seasons and finalize ended ones. Every step is idempotent:
 *
 *   1. CAS active -> finalizing (one run owns the finalize; a crashed run is
 *      resumed by the next, since `finalizing` is picked up again).
 *   2. Snapshot the ranking ONCE, in a single INSERT ... SELECT with
 *      ROW_NUMBER(), guarded by "no results yet" — so it is atomic and a
 *      re-run can never re-rank.
 *   3. Stamp each result with its reward band, grant items (INSERT OR IGNORE)
 *      and create claimable coin grants with deterministic ids
 *      (`season:<id>:<uid>`). Coins are paid later through the reward budget.
 *   4. CAS finalizing -> finalized, and notify the rewarded users once.
 *
 * Lifetime XP is never touched.
 */
export async function seasonTick(env: Env, ts = Date.now()): Promise<{ activated: number; finalized: string[] }> {
  const p = await getProgression(env);
  const today = rewardDayNumber(ts, p.settings.dayResetOffsetMinutes);
  const act = await env.DB.prepare(`UPDATE seasons SET status = 'active', updated_at = ? WHERE status = 'scheduled' AND start_day <= ? AND end_day >= ?`)
    .bind(ts, today, today).run();
  const due = await env.DB.prepare(`SELECT id FROM seasons WHERE status IN ('scheduled', 'active', 'finalizing') AND end_day < ? ORDER BY end_day LIMIT 5`)
    .bind(today).all<{ id: string }>();
  const finalized: string[] = [];
  for (const s of due.results ?? []) {
    if (await finalizeSeason(env, s.id, ts)) finalized.push(s.id);
  }
  return { activated: Number(act.meta?.changes || 0), finalized };
}

export async function finalizeSeason(env: Env, seasonId: string, ts = Date.now()): Promise<boolean> {
  const p = await getProgression(env);
  const today = rewardDayNumber(ts, p.settings.dayResetOffsetMinutes);
  await env.DB.prepare(`UPDATE seasons SET status = 'finalizing', updated_at = ? WHERE id = ? AND status IN ('scheduled', 'active') AND end_day < ?`)
    .bind(ts, seasonId, today).run();
  const season = await env.DB.prepare(`SELECT * FROM seasons WHERE id = ?`).bind(seasonId).first<SeasonRow>();
  if (!season || season.status !== "finalizing") return false;

  // 2. Ranking snapshot (atomic, once).
  await env.DB.prepare(
    `INSERT OR IGNORE INTO season_results (season_id, uid, rank, xp, rewards, reward_state, created_at)
     SELECT ?, uid, rnk, score, '[]', 'pending', ? FROM (
       SELECT s.uid, s.score,
              ROW_NUMBER() OVER (ORDER BY s.score DESC, COALESCE(u.xp, 0) DESC, u.created_at ASC, u.uid ASC) AS rnk
         FROM (${PERIOD_SCORES}) s JOIN users u ON u.uid = s.uid
        WHERE ${DISCOVERABLE}
     ) WHERE rnk <= ? AND NOT EXISTS (SELECT 1 FROM season_results WHERE season_id = ?)`,
  ).bind(seasonId, ts, season.start_day, season.end_day, season.top_n, seasonId).run();

  // 3. Rewards.
  const bands = parseSeasonRewards(season.rewards);
  const stmts: D1PreparedStatement[] = [];
  for (const b of bands) {
    stmts.push(
      env.DB.prepare(`UPDATE season_results SET rewards = ? WHERE season_id = ? AND rank BETWEEN ? AND ? AND reward_state = 'pending'`)
        .bind(JSON.stringify([b]), seasonId, b.fromRank, b.toRank),
    );
    if (b.itemId) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO user_inventory (uid, item_id, source, source_ref, acquired_at)
           SELECT r.uid, ?, 'season', ?, ? FROM season_results r
            WHERE r.season_id = ? AND r.rank BETWEEN ? AND ? AND r.reward_state = 'pending'
              AND EXISTS (SELECT 1 FROM reward_catalog WHERE id = ?)`,
        ).bind(b.itemId, seasonId, ts, seasonId, b.fromRank, b.toRank, b.itemId),
      );
    }
    if (b.coins > 0) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO reward_grants (id, uid, source_type, source_id, coins, status, note, created_at, updated_at)
           SELECT 'season:' || ? || ':' || r.uid, r.uid, 'season', ?, ?, 'claimable', ?, ?, ?
             FROM season_results r WHERE r.season_id = ? AND r.rank BETWEEN ? AND ? AND r.reward_state = 'pending'`,
        ).bind(seasonId, seasonId, b.coins, `${season.name}: ranks ${b.fromRank}-${b.toRank}`, ts, ts, seasonId, b.fromRank, b.toRank),
      );
    }
  }
  stmts.push(env.DB.prepare(`UPDATE season_results SET reward_state = 'delivered' WHERE season_id = ? AND reward_state = 'pending'`).bind(seasonId));
  await env.DB.batch(stmts);

  // 4. Close it, and announce once.
  const done = await env.DB.prepare(`UPDATE seasons SET status = 'finalized', finalized_at = ?, updated_at = ? WHERE id = ? AND status = 'finalizing'`)
    .bind(ts, ts, seasonId).run();
  if (Number(done.meta?.changes || 0) === 0) return false;
  const rewarded = await env.DB.prepare(`SELECT uid FROM season_results WHERE season_id = ? AND rewards <> '[]' LIMIT 1000`)
    .bind(seasonId).all<{ uid: string }>();
  const uids = (rewarded.results ?? []).map((r) => r.uid);
  if (uids.length) {
    await createNotificationsBulk(env, uids, {
      title: `${season.name} has ended 🏆`,
      body: "You finished in the rewarded ranks. Open Rewards to see your result.",
      type: "season_result",
      targetId: "rewards",
    }).catch((e) => console.error("[seasons] result notification failed", seasonId, e));
  }
  return true;
}

/** A user's archived result for a season, or null. */
export async function seasonResultFor(env: Env, seasonId: string, uid: string) {
  return env.DB.prepare(`SELECT rank, xp, rewards, reward_state FROM season_results WHERE season_id = ? AND uid = ?`)
    .bind(seasonId, uid).first<{ rank: number; xp: number; rewards: string; reward_state: string }>();
}

// ---------------------------------------------------------------------------
// Hall of Fame
// ---------------------------------------------------------------------------

/**
 * Public recognition: monthly Hall of Fame winners (existing, by monthly wins),
 * season champions (top 3 of finalized seasons), and Legends — the highest
 * lifetime XP accounts at or above the Hall of Fame milestone level.
 */
export async function hallOfFame(env: Env): Promise<{
  monthly: { period: string; rank: number; uid: string; username: string | null; profileImageUrl: string | null; verified: boolean }[];
  seasons: { seasonId: string; name: string; rank: number; uid: string; username: string | null; profileImageUrl: string | null; xp: number }[];
  legends: RankRow[];
  legendsMinLevel: number;
}> {
  const p = await getProgression(env);
  const monthly = await env.DB.prepare(
    `SELECT h.period, h.rank, u.uid, u.username, u.profile_image_url, u.verified
       FROM hall_of_fame_awards h JOIN users u ON u.uid = h.uid
      WHERE ${DISCOVERABLE} ORDER BY h.period DESC, h.rank ASC LIMIT 36`,
  ).all<any>();
  const seasons = await env.DB.prepare(
    `SELECT s.id AS season_id, s.name, r.rank, u.uid, u.username, u.profile_image_url, r.xp
       FROM season_results r JOIN seasons s ON s.id = r.season_id JOIN users u ON u.uid = r.uid
      WHERE s.status = 'finalized' AND r.rank <= 3 AND ${DISCOVERABLE}
      ORDER BY s.end_day DESC, r.rank ASC LIMIT 30`,
  ).all<any>();
  const legendsMinLevel = Math.min(featureLevel(p.cfg, "hall_of_fame") ?? 50, p.curve.maxLevel);
  const minXp = xpForLevel(legendsMinLevel, p.curve);
  const legends = await env.DB.prepare(
    `SELECT u.uid, u.username, u.full_name, u.profile_image_url, u.verified, u.xp AS score, u.xp AS lifetime
       FROM users u WHERE ${DISCOVERABLE} AND COALESCE(u.xp, 0) >= ?
      ORDER BY u.xp DESC, u.created_at ASC, u.uid ASC LIMIT 20`,
  ).bind(minXp).all<any>();
  return {
    monthly: (monthly.results ?? []).map((r) => ({
      period: r.period, rank: Number(r.rank), uid: r.uid, username: r.username ?? null, profileImageUrl: r.profile_image_url ?? null, verified: !!r.verified,
    })),
    seasons: (seasons.results ?? []).map((r) => ({
      seasonId: r.season_id, name: r.name, rank: Number(r.rank), uid: r.uid, username: r.username ?? null, profileImageUrl: r.profile_image_url ?? null, xp: Number(r.xp),
    })),
    legends: (legends.results ?? []).map((r, i) => toRow(r, i + 1)),
    legendsMinLevel,
  };
}
