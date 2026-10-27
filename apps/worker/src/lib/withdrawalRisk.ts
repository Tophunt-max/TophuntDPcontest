/**
 * Withdrawal risk review — computed when a payout is requested, shown to the
 * admin who approves it.
 *
 * Every payout is already approved by a person; this tells that person which
 * ones deserve a closer look. Nothing here blocks a request on its own.
 *
 * Flags:
 *   new_account        account younger than 7 days
 *   shared_device      another account was used from the same device
 *   mostly_free_coins  most coins this account ever received were free rewards
 *                      (verification, referral, daily, ads, tasks) rather than
 *                      purchases or contest prizes
 *   frequent           3+ payout requests in the last 7 days
 *   never_played       never bought coins and never won a contest
 *
 * Level: high = shared device, or 2+ flags · medium = 1 flag · low = none.
 */
import type { Env } from "../types";

export type RiskLevel = "low" | "medium" | "high";
export interface WithdrawalRisk {
  level: RiskLevel;
  flags: string[];
}

const DAY = 24 * 60 * 60 * 1000;
const FREE_TYPES = ["verification_bonus", "referral_bonus", "daily_reward", "ad_reward", "daily_task", "signup_bonus"];

export const RISK_FLAG_LABELS: Record<string, string> = {
  new_account: "Naya account (7 din se kam)",
  shared_device: "Same device par doosra account",
  mostly_free_coins: "Zyada tar balance free rewards se",
  frequent: "7 din me 3+ withdrawal request",
  never_played: "Na kabhi Diamond khareeda, na contest jeeta",
};

export async function assessWithdrawalRisk(env: Env, uid: string, ts = Date.now()): Promise<WithdrawalRisk> {
  const flags: string[] = [];
  try {
    const free = FREE_TYPES.map(() => "?").join(",");
    const row = await env.DB.prepare(
      `SELECT u.created_at AS created_at, u.device_id AS device_id,
              (SELECT COUNT(*) FROM users o WHERE o.device_id = u.device_id AND o.uid != u.uid) AS same_device,
              (SELECT COALESCE(SUM(amount), 0) FROM coin_transactions t WHERE t.uid = u.uid AND t.amount > 0
                 AND t.type IN (${free})) AS free_in,
              (SELECT COALESCE(SUM(amount), 0) FROM coin_transactions t WHERE t.uid = u.uid AND t.amount > 0
                 AND t.type NOT IN ('contest_refund', 'contest_entry_refund', 'withdrawal_refund', 'withdrawal_hold_release', 'opening')) AS all_in,
              (SELECT COUNT(*) FROM coin_transactions t WHERE t.uid = u.uid
                 AND ((t.type IN ('purchase', 'manual_deposit')) OR (t.type = 'contest_win_reward' AND t.amount > 0))) AS played,
              (SELECT COUNT(*) FROM withdrawals w WHERE w.user_id = u.uid AND w.created_at >= ? AND w.status != 'rejected') AS recent
         FROM users u WHERE u.uid = ?`,
    )
      .bind(...FREE_TYPES, ts - 7 * DAY, uid)
      .first<any>();
    if (!row) return { level: "low", flags };
    if (Number(row.created_at) > ts - 7 * DAY) flags.push("new_account");
    if (row.device_id && Number(row.same_device) > 0) flags.push("shared_device");
    const allIn = Number(row.all_in) || 0;
    if (allIn > 0 && (Number(row.free_in) || 0) / allIn >= 0.5) flags.push("mostly_free_coins");
    if (Number(row.recent) >= 3) flags.push("frequent");
    if (Number(row.played) === 0) flags.push("never_played");
  } catch (e) {
    // Never block a payout request on a failed probe; the admin still reviews it.
    console.error("[withdrawalRisk] assessment failed", uid, e);
  }
  const level: RiskLevel = flags.includes("shared_device") || flags.length >= 2 ? "high" : flags.length === 1 ? "medium" : "low";
  return { level, flags };
}
