/**
 * Withdrawal platform fee — the app's copy of the Worker's formula
 * (apps/worker/src/lib/withdrawalFee.ts), for the live "you'll receive" preview.
 *
 *   gross = coins × payout rate
 *   fee   = gross × feePercent% + feeFlat, clamped to [feeMin, feeMax] (max 0 = no cap),
 *           never more than gross
 *   net   = gross − fee
 *
 * The server is the authority: it recomputes, and refuses the request if the fee
 * it would charge differs from `feeInr` here (the app sends it as `quotedFee`),
 * so the user is never charged an amount they did not see. Both copies are
 * tested against the same vectors. Pure, Node-testable.
 */

export const MIN_NET_PAYOUT_INR = 1;

export interface WithdrawalFeeRule {
  feePercent: number;
  feeFlat: number;
  feeMin: number;
  feeMax: number;
}

export interface WithdrawalQuote {
  grossInr: number;
  feeInr: number;
  netInr: number;
}

const paise = (n: number) => Math.round((Number(n) || 0) * 100 + 1e-9) / 100;
const nonNeg = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** The fee rule from the public app config's `withdrawal` section. */
export function feeRuleFromWithdrawalConfig(w: any): WithdrawalFeeRule {
  return {
    feePercent: Math.min(50, nonNeg(w?.feePercent)),
    feeFlat: nonNeg(w?.feeFlat),
    feeMin: nonNeg(w?.feeMin),
    feeMax: nonNeg(w?.feeMax),
  };
}

export function hasFee(rule: WithdrawalFeeRule): boolean {
  return rule.feePercent > 0 || rule.feeFlat > 0 || rule.feeMin > 0;
}

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
  return { grossInr, feeInr, netInr: paise(grossInr - feeInr) };
}

/** "5% + ₹2 (min ₹1, max ₹50)" — the rule in one line, for the screen. Empty when there is no fee. */
export function describeFeeRule(rule: WithdrawalFeeRule): string {
  if (!hasFee(rule)) return '';
  const parts: string[] = [];
  if (rule.feePercent > 0) parts.push(`${rule.feePercent}%`);
  if (rule.feeFlat > 0) parts.push(`₹${rule.feeFlat}`);
  let s = parts.join(' + ') || `₹${rule.feeMin}`;
  const caps: string[] = [];
  if (rule.feeMin > 0 && parts.length) caps.push(`min ₹${rule.feeMin}`);
  if (rule.feeMax > 0) caps.push(`max ₹${rule.feeMax}`);
  if (caps.length) s += ` (${caps.join(', ')})`;
  return s;
}
