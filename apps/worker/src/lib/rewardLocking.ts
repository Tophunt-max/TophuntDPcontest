/**
 * Which free rewards are credited as LOCKED (play-only) coins.
 *
 * Free rewards (there is no signup bonus any more) — the verification bonus, referral bonuses, the daily login
 * reward, rewarded ads and daily tasks — are coins nobody paid for. Credited as
 * withdrawable coins they are a cash-out path for anyone who can create
 * accounts: verify + refer + claim daily for a few days and the withdrawal
 * minimum is reached. Credited as locked coins (`users.locked_coins`, migration
 * 0068) they can be spent on contest entry fees, and a contest PRIZE won with
 * them is withdrawable — so a real player can still earn, but a farm of fake
 * accounts cannot cash out.
 *
 * Configured per reward in App Control (`appConfig.rewardLocking`). Every reward
 * defaults to LOCKED: a missing key means locked, so a config that never set it
 * is the safe one. The switch only affects coins credited from now on; balances
 * already earned keep their current withdrawable status.
 */
import { httpsError } from "./http";

export const REWARD_LOCK_KINDS = ["verification", "referral", "daily", "ads", "tasks"] as const;
export type RewardLockKind = (typeof REWARD_LOCK_KINDS)[number];

/** True when coins of this reward kind are credited as locked (play-only). Default: locked. */
export function rewardLocked(cfg: any, kind: RewardLockKind): boolean {
  return cfg?.rewardLocking?.[kind] !== false;
}

/** Locked-coin amount for a reward credit of `amount` coins. */
export function lockedPart(cfg: any, kind: RewardLockKind, amount: number): number {
  return rewardLocked(cfg, kind) && amount > 0 ? amount : 0;
}

/** Validate an App Control `rewardLocking` patch in place: booleans for known kinds only. */
export function validateRewardLockingPatch(patch: any): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw httpsError("invalid-argument", "rewardLocking must be an object.");
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!(REWARD_LOCK_KINDS as readonly string[]).includes(key)) {
      throw httpsError("invalid-argument", `rewardLocking.${key} is not a known reward (${REWARD_LOCK_KINDS.join(", ")}).`);
    }
    if (typeof value !== "boolean") {
      throw httpsError("invalid-argument", `rewardLocking.${key} must be true (sirf khelne ke liye) or false (withdraw ho sakta hai).`);
    }
  }
}
