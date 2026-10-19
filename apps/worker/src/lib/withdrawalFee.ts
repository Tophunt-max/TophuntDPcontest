/**
 * Withdrawal platform fee — how real-money apps charge it (Dream11 / MPL / WinZO
 * style "platform / processing fee", and marketplaces like Upwork / Fiverr):
 *
 *   gross = coins × payout rate                         (what the coins are worth)
 *   fee   = gross × feePercent% + feeFlat               (percent + fixed)
 *           then clamped to [feeMin, feeMax]            (feeMax 0 = no cap)
 *           and never more than gross
 *   net   = gross − fee                                 (what is actually sent)
 *
 *  - The fee is DEDUCTED FROM THE PAYOUT, in rupees. The user's coins are
 *    escrowed exactly as requested; nothing extra is taken from the balance.
 *  - It is quoted before the user confirms, and LOCKED on the withdrawal row at
 *    request time (gross, fee, net and the fee rule used), so a later settings
 *    change never alters a request already made. A request whose quote no longer
 *    matches the live fee is refused rather than silently charged differently.
 *  - A rejected withdrawal refunds every coin; no fee is kept.
 *  - A payout below MIN_NET_PAYOUT_INR after the fee is refused (a ₹0.40 UPI
 *    transfer costs more to process than it is worth).
 *
 * All amounts are rupees rounded to the paisa. The Expo app carries an identical
 * copy for the live preview (apps/expo/src/lib/withdrawalFee.ts); the server is
 * the authority and both are tested against the same vectors.
 */
import { httpsError } from "./http";

export const MIN_NET_PAYOUT_INR = 1;

export interface WithdrawalFeeRule {
  /** Percent of the gross payout, 0–50. */
  feePercent: number;
  /** Fixed ₹ per withdrawal. */
  feeFlat: number;
  /** Lowest fee charged, ₹ (0 = none). */
  feeMin: number;
  /** Highest fee charged, ₹ (0 = no cap). */
  feeMax: number;
}

export interface WithdrawalQuote {
  coins: number;
  rate: number;
  grossInr: number;
  feeInr: number;
  netInr: number;
  rule: WithdrawalFeeRule;
}

const paise = (n: number) => Math.round((Number(n) || 0) * 100 + 1e-9) / 100;
const nonNeg = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** The fee rule from `appConfig.withdrawal`. Missing / invalid values are 0 (no fee). */
export function feeRuleFromConfig(cfg: any): WithdrawalFeeRule {
  const w = cfg?.withdrawal || {};
  return {
    feePercent: Math.min(50, nonNeg(w.feePercent)),
    feeFlat: nonNeg(w.feeFlat),
    feeMin: nonNeg(w.feeMin),
    feeMax: nonNeg(w.feeMax),
  };
}

export function hasFee(rule: WithdrawalFeeRule): boolean {
  return rule.feePercent > 0 || rule.feeFlat > 0 || rule.feeMin > 0;
}

/** Pure quote. Never throws. */
export function quoteWithdrawal(coins: number, rate: number, rule: WithdrawalFeeRule): WithdrawalQuote {
  const grossInr = paise(Math.max(0, Number(coins) || 0) * Math.max(0, Number(rate) || 0));
  let fee = 0;
  if (hasFee(rule) && grossInr > 0) {
    fee = (grossInr * rule.feePercent) / 100 + rule.feeFlat;
    if (rule.feeMin > 0) fee = Math.max(fee, rule.feeMin);
    if (rule.feeMax > 0) fee = Math.min(fee, rule.feeMax);
    fee = Math.min(paise(fee), grossInr);
  }
  const feeInr = paise(fee);
  return { coins: Number(coins) || 0, rate: Number(rate) || 0, grossInr, feeInr, netInr: paise(grossInr - feeInr), rule };
}

/** Quote for a real request: refuses a payout that would be under the minimum after the fee. */
export function chargeableWithdrawal(coins: number, rate: number, rule: WithdrawalFeeRule): WithdrawalQuote {
  const q = quoteWithdrawal(coins, rate, rule);
  if (q.netInr < MIN_NET_PAYOUT_INR) {
    throw httpsError(
      "failed-precondition",
      `Platform fee ₹${q.feeInr.toFixed(2)} ke baad aapko ₹${q.netInr.toFixed(2)} milte — kam se kam ₹${MIN_NET_PAYOUT_INR} hona chahiye. Zyada coins withdraw karo.`,
    );
  }
  return q;
}

/** Validate the fee keys of an admin `withdrawal` patch, in place, against the merged result. */
export function validateWithdrawalFeePatch(w: any, existing: any): void {
  const bad = (m: string): never => {
    throw httpsError("invalid-argument", m);
  };
  const money = (k: string, max: number, label: string) => {
    if (w[k] === undefined) return;
    const n = Number(w[k]);
    if (w[k] === "" || w[k] === null || !Number.isFinite(n) || n < 0 || n > max) bad(`${label} must be between 0 and ${max}.`);
    if (Math.round(n * 100) !== Number((n * 100).toFixed(4))) bad(`${label}: at most 2 decimal places.`);
    w[k] = n;
  };
  money("feePercent", 50, "Platform fee %");
  money("feeFlat", 10_000, "Flat fee (₹)");
  money("feeMin", 10_000, "Minimum fee (₹)");
  money("feeMax", 100_000, "Maximum fee (₹)");
  const merged = { ...(existing?.withdrawal || {}), ...w };
  const min = Number(merged.feeMin) || 0;
  const max = Number(merged.feeMax) || 0;
  if (max > 0 && min > max) bad("Minimum fee cannot be more than the maximum fee.");
}
