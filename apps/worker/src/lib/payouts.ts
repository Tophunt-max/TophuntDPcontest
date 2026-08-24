import { httpsError } from "./http";

/**
 * Payout destination validation.
 *
 * `withdrawals.account_details` was a free-text string that reached the admin
 * panel — and eventually a real bank transfer — completely unvalidated. A typo'd
 * UPI id or a malformed IFSC is only discovered when the transfer fails or, worse,
 * lands somewhere else. These are cheap, deterministic checks that catch the
 * common cases before a payout is ever queued.
 */

export const PAYOUT_METHODS = ["upi", "bank", "paytm"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

// NPCI virtual payment addresses: <local>@<handle>. Deliberately permissive on
// the local part (banks allow a lot, including single characters) but strict on
// shape — validation should reject malformed input, not unusual-but-valid input.
const UPI_RE = /^[a-zA-Z0-9.\-_]{1,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/;
// Indian mobile numbers, optionally +91 prefixed.
const MOBILE_RE = /^(?:\+?91)?[6-9]\d{9}$/;
// RBI IFSC: 4 letters, a 0, then 6 alphanumerics.
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_RE = /^\d{9,18}$/;

export interface PayoutDestination {
  method: PayoutMethod;
  /** Normalised, human-readable destination stored on the withdrawal row. */
  accountDetails: string;
  /** Masked form safe to show in lists/notifications. */
  masked: string;
}

function maskTail(value: string, keep = 4): string {
  const clean = value.replace(/\s+/g, "");
  if (clean.length <= keep) return "*".repeat(clean.length);
  return `${"*".repeat(clean.length - keep)}${clean.slice(-keep)}`;
}

export function assertPayoutMethod(method: unknown): PayoutMethod {
  if (typeof method !== "string" || !(PAYOUT_METHODS as readonly string[]).includes(method)) {
    throw httpsError("invalid-argument", `Payout method must be one of: ${PAYOUT_METHODS.join(", ")}.`);
  }
  return method as PayoutMethod;
}

/**
 * Validate and normalise a payout destination.
 *
 * Accepts either a plain string (UPI id / mobile number) or, for bank
 * transfers, an object `{ accountNumber, ifsc, holderName }`. Bank details may
 * also arrive as a single string for backwards compatibility, in which case the
 * IFSC and account number are extracted and validated.
 */
export function parsePayoutDestination(method: unknown, raw: unknown): PayoutDestination {
  const payoutMethod = assertPayoutMethod(method);

  if (payoutMethod === "upi") {
    const upi = String(raw ?? "").trim();
    if (!UPI_RE.test(upi)) {
      throw httpsError("invalid-argument", "Enter a valid UPI ID, for example name@bank.");
    }
    return { method: payoutMethod, accountDetails: upi.toLowerCase(), masked: maskTail(upi.split("@")[0]) + "@" + upi.split("@")[1] };
  }

  if (payoutMethod === "paytm") {
    const mobile = String(raw ?? "").replace(/[\s-]/g, "").trim();
    if (!MOBILE_RE.test(mobile)) {
      throw httpsError("invalid-argument", "Enter the 10-digit mobile number registered with Paytm.");
    }
    return { method: payoutMethod, accountDetails: mobile.replace(/^\+?91/, ""), masked: maskTail(mobile) };
  }

  // Bank transfer.
  let accountNumber = "";
  let ifsc = "";
  let holderName = "";

  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    accountNumber = String(obj.accountNumber ?? obj.account ?? "").replace(/\s+/g, "");
    ifsc = String(obj.ifsc ?? obj.IFSC ?? "").replace(/\s+/g, "").toUpperCase();
    holderName = String(obj.holderName ?? obj.name ?? "").trim();
  } else {
    const text = String(raw ?? "");
    const ifscMatch = text.toUpperCase().match(IFSC_RE) || text.toUpperCase().match(/[A-Z]{4}0[A-Z0-9]{6}/);
    ifsc = ifscMatch ? ifscMatch[0] : "";
    const accountMatch = text.replace(/\s+/g, " ").match(/\b\d{9,18}\b/);
    accountNumber = accountMatch ? accountMatch[0] : "";
    holderName = text
      .replace(ifsc, "")
      .replace(accountNumber, "")
      .replace(/[^a-zA-Z\s.]/g, "")
      .trim();
  }

  if (!ACCOUNT_RE.test(accountNumber)) {
    throw httpsError("invalid-argument", "Enter a valid bank account number (9–18 digits).");
  }
  if (!IFSC_RE.test(ifsc)) {
    throw httpsError("invalid-argument", "Enter a valid IFSC code, for example HDFC0001234.");
  }
  if (holderName.length < 2 || holderName.length > 100) {
    throw httpsError("invalid-argument", "Enter the account holder's name as printed on the bank account.");
  }

  return {
    method: payoutMethod,
    accountDetails: `${holderName} | A/C ${accountNumber} | IFSC ${ifsc}`,
    masked: `${holderName} | A/C ${maskTail(accountNumber)} | IFSC ${ifsc}`,
  };
}

export interface WithdrawalPolicy {
  enabled: boolean;
  payoutsFrozen: boolean;
  minAmount: number;
  /** Largest single request. 0 = unlimited (not recommended). */
  maxAmount: number;
  /** Largest total requested in a rolling 24h window. 0 = unlimited. */
  maxPerDay: number;
  conversionRate: number;
}

/**
 * Withdrawal limits from admin App Control, with defensive defaults.
 *
 * `maxAmount` and `maxPerDay` did not exist: the only brake on draining an
 * entire balance in one request was a 5-per-hour rate limit. Defaults are
 * generous rather than restrictive so existing behaviour is not silently
 * tightened, but they are now expressible and enforced.
 */
export function readWithdrawalPolicy(cfg: any): WithdrawalPolicy {
  const w = (cfg?.withdrawal as any) || {};
  const num = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    enabled: w.enabled !== false,
    payoutsFrozen: w.payoutsFrozen === true,
    minAmount: num(w.minAmount, 0),
    maxAmount: num(w.maxAmount, 0),
    maxPerDay: num(w.maxPerDay, 0),
    conversionRate: Number.isFinite(Number(w.conversionRate)) ? Number(w.conversionRate) : 1,
  };
}
