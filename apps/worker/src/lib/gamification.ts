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
  /** Coins for the first daily claim of a UTC day. */
  dailyLoginReward: number;
  /** Extra coins per consecutive day, multiplied by the current streak. */
  dailyStreakBonus: number;
  // NOTE: signupBonus and referralBonus deliberately do NOT live here any more.
  // Both are credited straight to a balance and are now sourced exclusively from
  // `appConfig.rewardSettings` via getRewardSettings() (settings.ts) — the same
  // row the admin's App Settings page writes. Keeping duplicates here was a dead
  // knob: the App Settings field wrote appConfig while crediting read this row.
  badges: Badge[];
}

const DEFAULT_SETTINGS: GamificationSettings = {
  xpThreshold: 500,
  xpIncrement: 500,
  dailyLoginReward: 10,
  dailyStreakBonus: 2,
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
