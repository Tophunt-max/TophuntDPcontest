/**
 * XP / level / reward logic ported from utils/gamification.ts.
 * Settings come from the `gamification` settings row (KV-cached).
 */
import type { Env } from "../types";
import { getGamificationSettings as loadGamification } from "./settings";

interface Badge {
  level: number;
  name: string;
  icon: string;
}

export interface GamificationSettings {
  xpThreshold: number;
  xpIncrement: number;
  /** Coins for the first daily claim of a reward day. */
  dailyLoginReward: number;
  /** Extra coins per consecutive day, multiplied by the current streak. */
  dailyStreakBonus: number;
  /** Off: `claimDailyReward` refuses and the app hides the check-in track. */
  dailyLoginEnabled: boolean;
  /**
   * Fixed per-day amounts (day 1, day 2, …). When set, it replaces the
   * base + streak-bonus formula and repeats once the streak passes its end.
   */
  dailyRewardSchedule: number[];
  /**
   * When the reward day starts, as minutes ahead of UTC (330 = midnight IST).
   * Used by the daily check-in, daily tasks and the rewarded-ad cap.
   */
  dayResetOffsetMinutes: number;
  // NOTE: signupBonus and referralBonus deliberately do NOT live here any more.
  // Both are credited straight to a balance and are now sourced exclusively from
  // `appConfig.rewardSettings` via getRewardSettings() (settings.ts) — the same
  // row the admin's App Settings page writes. Keeping duplicates here was a dead
  // knob: the App Settings field wrote appConfig while crediting read this row.
  badges: Badge[];
  /** Coins for Hall of Fame ranks 1..3 at the monthly settlement (cron.ts). */
  hallOfFameRewards: number[];
}

const DEFAULT_SETTINGS: GamificationSettings = {
  xpThreshold: 500,
  xpIncrement: 500,
  dailyLoginReward: 10,
  dailyStreakBonus: 2,
  dailyLoginEnabled: true,
  dailyRewardSchedule: [],
  dayResetOffsetMinutes: 0,
  badges: [],
  hallOfFameRewards: [1000, 500, 250],
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** The streak bonus stops growing after this many days (formula mode). */
export const DAILY_STREAK_BONUS_MAX_DAYS = 30;
/** Longest fixed daily schedule an admin can save. */
export const DAILY_SCHEDULE_MAX_DAYS = 30;
/** Allowed day-reset offsets: UTC-12:00 to UTC+14:00. */
export const DAY_OFFSET_MIN = -720;
export const DAY_OFFSET_MAX = 840;
/** Days shown on the app's check-in track. */
export const DAILY_TRACK_DAYS = 7;

function clampOffset(minutes: unknown): number {
  const n = Number(minutes);
  return Number.isInteger(n) && n >= DAY_OFFSET_MIN && n <= DAY_OFFSET_MAX ? n : 0;
}

/** Reward-day number of `ts` (with offset 0 this is the UTC day number). */
export function rewardDayNumber(ts: number, offsetMinutes: number): number {
  return Math.floor((ts + clampOffset(offsetMinutes) * 60_000) / DAY_MS);
}

/** Epoch ms at which the reward day containing `ts` starts. */
export function rewardDayStart(ts: number, offsetMinutes: number): number {
  return rewardDayNumber(ts, offsetMinutes) * DAY_MS - clampOffset(offsetMinutes) * 60_000;
}

/** Coins for the claim that makes the streak `streak` days long (streak >= 1). */
export function dailyRewardFor(
  settings: Pick<GamificationSettings, "dailyLoginReward" | "dailyStreakBonus" | "dailyRewardSchedule">,
  streak: number,
): number {
  const s = Math.max(1, Math.floor(streak));
  const schedule = settings.dailyRewardSchedule || [];
  if (schedule.length) return schedule[(s - 1) % schedule.length];
  return settings.dailyLoginReward + Math.min(s, DAILY_STREAK_BONUS_MAX_DAYS) * settings.dailyStreakBonus;
}

export interface DailyRewardState {
  enabled: boolean;
  /** Streak shown to the user: 0 when it has already broken. */
  streak: number;
  claimedToday: boolean;
  /** Streak day today's claim counts as (claimed or not). */
  todayStreakDay: number;
  /** Coins today's claim pays (or paid). */
  todayReward: number;
  dayStartsAt: number;
  nextResetAt: number;
  track: { day: number; amount: number; status: "claimed" | "ready" | "upcoming" }[];
}

/**
 * Daily check-in state computed exactly the way `claimDailyReward` pays, so the
 * app never shows an amount the server would not credit.
 */
export function dailyRewardState(
  settings: GamificationSettings,
  user: { streak?: number | null; lastDailyClaim?: number | null },
  ts: number,
): DailyRewardState {
  const startOfToday = rewardDayStart(ts, settings.dayResetOffsetMinutes);
  const startOfYesterday = startOfToday - DAY_MS;
  const lastMs = user.lastDailyClaim ? Number(user.lastDailyClaim) : 0;
  const stored = Math.max(0, Number(user.streak) || 0);
  const claimedToday = lastMs >= startOfToday;
  const alive = claimedToday || (lastMs >= startOfYesterday && lastMs < startOfToday);
  const todayStreakDay = claimedToday ? Math.max(1, stored) : alive ? stored + 1 : 1;
  const windowStart = Math.floor((todayStreakDay - 1) / DAILY_TRACK_DAYS) * DAILY_TRACK_DAYS + 1;
  const track = Array.from({ length: DAILY_TRACK_DAYS }, (_, i) => {
    const day = windowStart + i;
    const status: "claimed" | "ready" | "upcoming" =
      day < todayStreakDay ? "claimed" : day === todayStreakDay ? (claimedToday ? "claimed" : "ready") : "upcoming";
    return { day, amount: dailyRewardFor(settings, day), status };
  });
  return {
    enabled: settings.dailyLoginEnabled,
    streak: alive ? stored : 0,
    claimedToday,
    todayStreakDay,
    todayReward: dailyRewardFor(settings, todayStreakDay),
    dayStartsAt: startOfToday,
    nextResetAt: startOfToday + DAY_MS,
    track,
  };
}

export interface DailyTaskDef {
  id: string;
  title: string;
  reward: number;
  target: number;
  type: "vote" | "share" | "contest" | "ad";
  /** Off: hidden and not claimable, but kept in the list. */
  enabled: boolean;
  /** Optional window (epoch ms) for limited-time tasks. */
  startsAt: number | null;
  endsAt: number | null;
}
export const DAILY_TASK_TYPES = ["vote", "share", "contest", "ad"] as const;
export const DEFAULT_DAILY_TASKS: DailyTaskDef[] = [
  { id: "vote5", title: "Vote in 5 battles", reward: 15, target: 5, type: "vote", enabled: true, startsAt: null, endsAt: null },
  { id: "share", title: "Share a battle", reward: 10, target: 1, type: "share", enabled: true, startsAt: null, endsAt: null },
  { id: "watch_ad", title: "Watch a video ad", reward: 5, target: 1, type: "ad", enabled: true, startsAt: null, endsAt: null },
];

const optionalMs = (v: unknown): number | null => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== "" && Number.isInteger(n) && n > 0 ? n : null;
};

/** Daily tasks from gamification settings (admin override) or defaults. */
export function getDailyTaskDefs(settings: any): DailyTaskDef[] {
  const custom = settings?.dailyTasks;
  if (Array.isArray(custom) && custom.length) {
    return custom.map((t: any) => ({
      id: String(t.id),
      title: String(t.title || t.id),
      reward: Number(t.reward || 0),
      target: Number(t.target || 1),
      type: ((DAILY_TASK_TYPES as readonly string[]).includes(t.type) ? t.type : "ad") as DailyTaskDef["type"],
      enabled: t.enabled !== false,
      startsAt: optionalMs(t.startsAt),
      endsAt: optionalMs(t.endsAt),
    }));
  }
  return DEFAULT_DAILY_TASKS;
}

/** Tasks a user can see and claim at `ts`: enabled and inside their window. */
export function activeDailyTasks(tasks: DailyTaskDef[], ts: number): DailyTaskDef[] {
  return tasks.filter((t) => t.enabled && (t.startsAt === null || ts >= t.startsAt) && (t.endsAt === null || ts < t.endsAt));
}

const MAX_REWARD = 1_000_000;
const wholeCoins = (v: unknown) => {
  const n = Number(v);
  return typeof v !== "boolean" && v !== null && v !== "" && Number.isInteger(n) && n >= 0 && n <= MAX_REWARD;
};

/**
 * Validate the coin-valued lists an admin can save on the gamification row:
 * `dailyTasks` (each credited straight to a balance) and `hallOfFameRewards`
 * (ranks 1..3). Throws a message naming the bad entry.
 */
export function validateGamificationCoinLists(body: any): void {
  if (body?.dailyTasks !== undefined) {
    if (!Array.isArray(body.dailyTasks) || body.dailyTasks.length > 20) {
      throw new Error("dailyTasks must be a list of at most 20 tasks.");
    }
    const ids = new Set<string>();
    for (const t of body.dailyTasks) {
      const id = String(t?.id ?? "").trim();
      if (!/^[a-z0-9_-]{2,40}$/i.test(id)) throw new Error("Every daily task needs an id (2-40 letters, digits, _ or -).");
      if (ids.has(id)) throw new Error(`Daily task id "${id}" is used twice.`);
      ids.add(id);
      if (!String(t?.title ?? "").trim() || String(t.title).length > 80) throw new Error(`Task "${id}": title is required (max 80 characters).`);
      if (!(DAILY_TASK_TYPES as readonly string[]).includes(t?.type)) throw new Error(`Task "${id}": type must be ${DAILY_TASK_TYPES.join(", ")}.`);
      if (!wholeCoins(t?.reward)) throw new Error(`Task "${id}": reward must be a whole number of coins between 0 and ${MAX_REWARD}.`);
      const target = Number(t?.target);
      if (!Number.isInteger(target) || target < 1 || target > 1000) throw new Error(`Task "${id}": target must be a whole number from 1 to 1000.`);
      if (t?.enabled !== undefined && typeof t.enabled !== "boolean") throw new Error(`Task "${id}": enabled must be true or false.`);
      for (const k of ["startsAt", "endsAt"] as const) {
        const v = t?.[k];
        if (v !== undefined && v !== null && optionalMs(v) === null) throw new Error(`Task "${id}": ${k} must be empty or a date.`);
      }
      const s = optionalMs(t?.startsAt);
      const e = optionalMs(t?.endsAt);
      if (s !== null && e !== null && e <= s) throw new Error(`Task "${id}": the end must be after the start.`);
    }
  }
  if (body?.dailyLoginEnabled !== undefined && typeof body.dailyLoginEnabled !== "boolean") {
    throw new Error("dailyLoginEnabled must be true or false.");
  }
  if (body?.dailyRewardSchedule !== undefined) {
    const s = body.dailyRewardSchedule;
    if (!Array.isArray(s) || s.length > DAILY_SCHEDULE_MAX_DAYS || !s.every(wholeCoins)) {
      throw new Error(`dailyRewardSchedule must be up to ${DAILY_SCHEDULE_MAX_DAYS} whole coin amounts (empty = use the streak formula).`);
    }
  }
  if (body?.dayResetOffsetMinutes !== undefined) {
    const n = Number(body.dayResetOffsetMinutes);
    if (typeof body.dayResetOffsetMinutes === "boolean" || !Number.isInteger(n) || n < DAY_OFFSET_MIN || n > DAY_OFFSET_MAX) {
      throw new Error(`dayResetOffsetMinutes must be a whole number of minutes from ${DAY_OFFSET_MIN} to ${DAY_OFFSET_MAX}.`);
    }
  }
  if (body?.hallOfFameRewards !== undefined) {
    const r = body.hallOfFameRewards;
    if (!Array.isArray(r) || r.length !== 3 || !r.every(wholeCoins)) {
      throw new Error(`hallOfFameRewards must be three whole coin amounts (rank 1, 2, 3) between 0 and ${MAX_REWARD}.`);
    }
  }
}

// REMOVED from this interface: contestJoinReward, matchWinReward, voteReward,
// voteRewardXP, contestJoinXP.
//
// Every one of them was read ONLY by the deleted `awardReward` below, which had
// no callers — so they have never affected a balance. Leaving them in the
// defaults would keep advertising five knobs that do nothing, and `POST
// /admin/rewards` merges arbitrary keys, so an admin setting one would have had
// no way to tell.
//
// Where those rewards actually come from today:
//   * a match win  -> the contest's own `rewardCoins`, capped by the entry-fee
//                     pot and snapshotted per match (lib/contestSettlement.ts)
//   * a vote       -> a flat VOTE_XP constant in voteCounter.ts (XP only, no coins)
//   * joining      -> nothing; joining costs an entry fee rather than paying one

/** Coin-valued settings keys. These reach a real balance, so they are sanitised.
 *  (signupBonus/referralBonus moved to appConfig.rewardSettings — see settings.ts.) */
const COIN_KEYS = ["dailyLoginReward", "dailyStreakBonus"] as const;
/** Integer-valued but non-monetary keys. */
const XP_KEYS = ["xpThreshold", "xpIncrement"] as const;

/**
 * Clamp a settings-derived amount to a safe whole number.
 *
 * `POST /admin/rewards` merges whatever JSON it is given into this row, and these
 * values are then added straight to `users.dpcoin`. A fractional
 * `dailyLoginReward` would therefore quietly break the "coins are whole numbers"
 * invariant for every user who claimed it, and a negative one would silently
 * DEBIT them. The write path now rejects bad input outright
 * (routes/admin.ts POST /rewards), and this is the second line of defence for
 * values that were already stored before that check existed.
 *
 * Floors rather than rounds, so a bad value can never pay out more than intended.
 */
function sanitizeAmount(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export async function getSettings(env: Env): Promise<GamificationSettings> {
  const data = (await loadGamification(env)) || {};
  const merged: any = {
    ...DEFAULT_SETTINGS,
    ...data,
    // `dailyBaseReward` is the legacy key name for the same value.
    dailyLoginReward: data.dailyLoginReward ?? data.dailyBaseReward ?? DEFAULT_SETTINGS.dailyLoginReward,
    badges: Array.isArray(data.badges) ? data.badges : [],
    hallOfFameRewards:
      Array.isArray(data.hallOfFameRewards) && data.hallOfFameRewards.length === 3
        ? data.hallOfFameRewards.map((v: unknown, i: number) => sanitizeAmount(v, DEFAULT_SETTINGS.hallOfFameRewards[i]))
        : DEFAULT_SETTINGS.hallOfFameRewards,
    dailyLoginEnabled: data.dailyLoginEnabled !== false,
    dailyRewardSchedule: Array.isArray(data.dailyRewardSchedule)
      ? data.dailyRewardSchedule.slice(0, DAILY_SCHEDULE_MAX_DAYS).map((v: unknown) => sanitizeAmount(v, 0))
      : [],
    dayResetOffsetMinutes: clampOffset(data.dayResetOffsetMinutes),
  };
  for (const key of COIN_KEYS) merged[key] = sanitizeAmount(merged[key], DEFAULT_SETTINGS[key]);
  for (const key of XP_KEYS) {
    // A zero XP threshold would make the level formula loop forever.
    merged[key] = Math.max(1, sanitizeAmount(merged[key], DEFAULT_SETTINGS[key]));
  }
  return merged as GamificationSettings;
}

/** Level from cumulative XP with escalating thresholds (unchanged formula). */
export function calculateLevel(xp: number, threshold: number, increment: number): number {
  let level = 1;
  let currentThreshold = threshold;
  let accumulatedXp = 0;
  while (xp >= accumulatedXp + currentThreshold) {
    accumulatedXp += currentThreshold;
    level++;
    currentThreshold += increment;
  }
  return level;
}

/**
 * The level a given cumulative XP maps to — DERIVED, never stored.
 *
 * XP is the single source of truth: it is incremented atomically (`xp = xp + N`)
 * wherever it is earned (votes, match results, the daily reward, …) and the level
 * is computed from it on read. The old `awardXp` that ALSO wrote `users.level`
 * was removed — it had no callers and did a non-atomic read-modify-write, and its
 * absence is exactly why every account's stored `level` sat frozen at its seeded
 * value while XP climbed. Deriving on read means the level can never drift from
 * the XP behind it, and there is no write to race.
 */
export function levelForXp(
  xp: number,
  settings: Pick<GamificationSettings, "xpThreshold" | "xpIncrement">,
): number {
  const n = Number(xp);
  const safeXp = Number.isFinite(n) && n > 0 ? n : 0;
  return calculateLevel(safeXp, settings.xpThreshold, settings.xpIncrement);
}

// ---------------------------------------------------------------------------
// REMOVED: awardReward()
//
// It credited coins with a bare `UPDATE users SET dpcoin = dpcoin + ?` — no
// ledger row, no idempotency claim, no `assertCoinAmount`, and no conditional
// gate. That is the exact opposite of the money invariant the rest of this
// codebase enforces ("a balance can never move without a matching ledger
// entry"), so a single call would have produced coins the ledger could not
// explain and the platform-liability report could not reconcile.
//
// It had no call sites — only a stale import in routes/api.ts — so it was
// removed rather than repaired, for the same reason the second admin middleware
// was removed in middleware/auth.ts: keeping one correct path beats keeping two
// where one is quietly wrong.
//
// If per-action coin rewards are wanted again, route them through
// `adjustUserWallet` in lib/money.ts (positive whole amount + `direction`, plus a
// `claimKey` so a retry cannot double-pay), which gives the ledger row and the
// replay protection for free. `awardXp` above is unaffected — XP is not money.
// ---------------------------------------------------------------------------
