/**
 * Diamonds and DP coins: the two balances a user sees.
 *
 *   Diamond   users.locked_coins. Play-only: the ONLY way to pay a contest
 *             entry fee. Comes from coin packages, signup / verification,
 *             daily rewards, tasks, ads, referrals and promo bonuses (each
 *             free reward can be switched to DP coin in App Control,
 *             appConfig.rewardLocking). Never withdrawable.
 *   DP coin   users.dpcoin - users.locked_coins. Contest prizes. The only
 *             balance a withdrawal can take.
 *
 * Storage is unchanged: `users.dpcoin` holds the total and `locked_coins` the
 * Diamond part of it, and every ledger row's `locked_delta` is its Diamond part,
 * so the ledger invariants (dpcoin = SUM(amount), locked_coins =
 * SUM(locked_delta)) cover both balances.
 */
import type { Env } from "../types";
import { httpsError } from "./http";

/** SQL (inside a `users` row filter): the user holds at least `?` Diamonds. Bind the fee once. */
export const DIAMONDS_COVER = "MIN(locked_coins, dpcoin) >= ?";

export const NOT_ENOUGH_DIAMONDS = "not_enough_diamonds";

export interface Balances {
  /** Withdrawable DP coins. */
  dpcoin: number;
  /** Play-only Diamonds. */
  diamonds: number;
}

/** Split a stored (total, locked) pair into the two balances. */
export function splitBalance(total: unknown, locked: unknown): Balances {
  const t = Math.max(0, Number(total) || 0);
  const d = Math.min(t, Math.max(0, Number(locked) || 0));
  return { dpcoin: t - d, diamonds: d };
}

/** The error for an entry fee the user's Diamonds do not cover. */
export async function notEnoughDiamonds(env: Env, uid: string, fee: number) {
  const row = await env.DB.prepare(`SELECT dpcoin, locked_coins FROM users WHERE uid = ?`)
    .bind(uid)
    .first<{ dpcoin: number; locked_coins: number }>()
    .catch(() => null);
  const have = splitBalance(row?.dpcoin, row?.locked_coins).diamonds;
  return httpsError(
    "failed-precondition",
    `Entry ke liye ${fee} Diamond chahiye, aapke paas ${have} hain. Diamond store se lo ya daily reward, tasks se kamao.`,
    NOT_ENOUGH_DIAMONDS,
  );
}
