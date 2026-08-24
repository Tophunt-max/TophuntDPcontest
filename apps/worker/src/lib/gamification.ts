/**
 * XP / level / reward logic ported from utils/gamification.ts.
 * Settings come from the `gamification` settings row (KV-cached).
 */
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { getGamificationSettings as loadGamification } from "./settings";
import { sendPushNotification } from "./notify";

interface Badge {
  level: number;
  name: string;
  icon: string;
}

export interface GamificationSettings {
  xpThreshold: number;
  xpIncrement: number;
  /** Coins for the first daily claim of a UTC day. */
  dailyLoginReward: number;
  /** Extra coins per consecutive day, multiplied by the current streak. */
  dailyStreakBonus: number;
  signupBonus: number;
  referralBonus: number;
  badges: Badge[];
}

const DEFAULT_SETTINGS: GamificationSettings = {
  xpThreshold: 500,
  xpIncrement: 500,
  dailyLoginReward: 10,
  dailyStreakBonus: 2,
  signupBonus: 100,
  referralBonus: 50,
  badges: [],
};

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

/** Coin-valued settings keys. These reach a real balance, so they are sanitised. */
const COIN_KEYS = ["dailyLoginReward", "dailyStreakBonus", "signupBonus", "referralBonus"] as const;
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

/** Award XP (and handle level-up + badges). */
export async function awardXp(env: Env, userId: string, amount: number): Promise<void> {
  const settings = await getSettings(env);
  const db = getDb(env);
  const user = await db
    .select({ xp: schema.users.xp, level: schema.users.level, badges: schema.users.badges })
    .from(schema.users)
    .where(eq(schema.users.uid, userId))
    .get();
  if (!user) return;

  const newXp = (user.xp || 0) + amount;
  const newLevel = calculateLevel(newXp, settings.xpThreshold, settings.xpIncrement);
  const leveledUp = newLevel > (user.level || 1);

  let badges = (user.badges as unknown as Badge[]) || [];
  if (leveledUp) {
    const badge = settings.badges.find((b) => b.level === newLevel);
    if (badge && !badges.some((b) => b.name === badge.name)) badges = [...badges, badge];
  }

  await db
    .update(schema.users)
    .set({ xp: newXp, level: newLevel, badges: badges as any, updatedAt: Date.now() })
    .where(eq(schema.users.uid, userId));

  if (leveledUp) {
    await sendPushNotification(env, userId, "Level Up! 🌟", `You reached Level ${newLevel}.`, "level_up");
  }
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
