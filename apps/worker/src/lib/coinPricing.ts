/**
 * Coin package pricing — two rates, and one rule that keeps them honest.
 *
 *   BUY rate    `appConfig.coinPricing.buyRate`         ₹ per coin when BUYING
 *   PAYOUT rate `appConfig.withdrawal.conversionRate`   ₹ per coin when WITHDRAWING
 *
 *   price = BASE coins × buy rate        (bonus coins are free)
 *
 * The rule: **no package may pay out more than it costs.** Every coin it credits
 * (base + bonus) can be withdrawn at the payout rate, so
 *
 *   base × buyRate  >=  (base + bonus) × payoutRate
 *
 * Without it, a ₹1 package of 10 coins + 5 bonus at a ₹0.10 payout rate could be
 * bought for ₹1 and withdrawn for ₹1.50 — with one rate for both, every bonus
 * coin was money handed out. The rule is enforced when an admin saves either
 * rate or a package (the save is refused, naming the minimum safe buy rate), and
 * again at charge time, so a package that breaks it is never sold.
 *
 * PROMO PACKAGES. A package linked to a promo budget (`budget_id`,
 * lib/promoBudget.ts) credits its bonus as LOCKED coins: playable, never
 * withdrawable. Only the base coins can be cashed out, so for those packages the
 * rule becomes `base × buyRate >= base × payoutRate` — the bonus is a budgeted
 * platform expense, not a payout risk.
 *
 * Until a buy rate is set, the buy rate falls back to the payout rate (the
 * previous single-rate behaviour) — which the rule then blocks for any package
 * with bonus coins, telling the admin exactly what to set.
 *
 * Every path that SHOWS or CHARGES a price uses this module — the public catalog,
 * Razorpay `createOrder` and the manual `requestDeposit` — so the price a user
 * sees is the price they are charged. An order or deposit records its amount
 * when it is created, so a rate change never alters one already in flight.
 */
import { httpsError } from "./http";

/** Smallest amount Razorpay (and UPI) will accept. */
export const MIN_PACKAGE_PRICE_INR = 1;
const MAX_RATE = 1000;
/** Half a paisa: price and payout are each rounded to the paisa. */
const EPS = 0.005;

const validRate = (raw: unknown): number | null => {
  if (raw === undefined || raw === null || raw === "") return null;
  const r = Number(raw);
  return Number.isFinite(r) && r > 0 && r <= MAX_RATE ? r : null;
};

/**
 * The PAYOUT rate (₹ per coin withdrawn), or null when unusable.
 *
 * Mirrors the withdrawal policy (lib/payouts.ts readWithdrawalPolicy): an unset
 * rate keeps the historical default of 1, while an explicitly configured rate
 * that is zero, negative or non-numeric is unusable (null).
 */
export function coinValueFromConfig(cfg: any): number | null {
  const raw = cfg?.withdrawal?.conversionRate;
  if (raw === undefined || raw === null || raw === "") return 1;
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** True when the admin has set an explicit buy rate. */
export function hasExplicitBuyRate(cfg: any): boolean {
  return validRate(cfg?.coinPricing?.buyRate) !== null;
}

/** The BUY rate (₹ per base coin bought). Falls back to the payout rate until set. */
export function buyRateFromConfig(cfg: any): number | null {
  return validRate(cfg?.coinPricing?.buyRate) ?? coinValueFromConfig(cfg);
}

const paise = (n: number) => Math.round(n * 100) / 100;

/** Price in rupees for a package, rounded to the paisa. Bonus coins are free. */
export function packagePriceInr(baseCoins: number, buyRate: number | null): number {
  const coins = Number(baseCoins) || 0;
  if (!buyRate || coins <= 0) return 0;
  return paise(coins * buyRate);
}

type PackageLike = { coins?: unknown; bonusCoins?: unknown; budgetId?: unknown };

/** True when the bonus is budget-funded and credited as locked (play-only) coins. */
export function hasLockedBonus(pkg: PackageLike): boolean {
  return typeof pkg.budgetId === "string" && pkg.budgetId.length > 0;
}

/** Coins of this package that can be WITHDRAWN once credited. */
function withdrawableCoins(pkg: PackageLike): number {
  const base = Number(pkg.coins) || 0;
  return hasLockedBonus(pkg) ? base : base + (Number(pkg.bonusCoins) || 0);
}

/** The lowest buy rate at which this package does not pay out more than it costs. */
export function minSafeBuyRate(pkg: PackageLike, payoutRate: number | null): number {
  const base = Number(pkg.coins) || 0;
  const total = withdrawableCoins(pkg);
  if (!payoutRate || base <= 0) return 0;
  // Rounded UP to the paisa, so the suggested rate always passes the rule.
  return Math.ceil(((payoutRate * total) / base) * 100 - 1e-9) / 100;
}

export type NotPurchasableReason = "below_minimum" | "pays_out_more" | "no_rate";

export interface PricedPackage {
  baseCoins: number;
  bonusCoins: number;
  totalCoins: number;
  priceInr: number;
  /** What the WITHDRAWABLE credited coins are worth at the payout rate. */
  payoutInr: number;
  /** The bonus is budget-funded and credited as locked (play-only) coins. */
  bonusLocked: boolean;
  purchasable: boolean;
  reason?: NotPurchasableReason;
}

export interface Rates {
  buyRate: number | null;
  payoutRate: number | null;
}

export function ratesFromConfig(cfg: any): Rates {
  return { buyRate: buyRateFromConfig(cfg), payoutRate: coinValueFromConfig(cfg) };
}

export function pricePackage(pkg: PackageLike, rates: Rates): PricedPackage {
  const baseCoins = Number(pkg.coins) || 0;
  const bonusCoins = Number(pkg.bonusCoins) || 0;
  const totalCoins = baseCoins + bonusCoins;
  const bonusLocked = hasLockedBonus(pkg) && bonusCoins > 0;
  const priceInr = packagePriceInr(baseCoins, rates.buyRate);
  const payoutInr = rates.payoutRate ? paise(withdrawableCoins(pkg) * rates.payoutRate) : 0;
  let reason: NotPurchasableReason | undefined;
  if (!rates.buyRate) reason = "no_rate";
  else if (priceInr < MIN_PACKAGE_PRICE_INR) reason = "below_minimum";
  else if (rates.payoutRate && priceInr + EPS < payoutInr) reason = "pays_out_more";
  return { baseCoins, bonusCoins, totalCoins, priceInr, payoutInr, bonusLocked, purchasable: !reason, ...(reason ? { reason } : {}) };
}

/** Price a package for a real charge, or refuse with a message the user can act on. */
export function chargeablePackage(pkg: PackageLike, cfg: any): PricedPackage {
  const priced = pricePackage(pkg, ratesFromConfig(cfg));
  if (priced.baseCoins <= 0 || priced.totalCoins <= 0) {
    throw httpsError("failed-precondition", "This coin package is misconfigured.");
  }
  if (priced.reason === "below_minimum") {
    throw httpsError("failed-precondition", `This package costs less than ₹${MIN_PACKAGE_PRICE_INR} and can't be paid for. Please pick a bigger one.`);
  }
  if (priced.reason) {
    // no_rate / pays_out_more: an admin pricing problem, never the buyer's fault.
    throw httpsError("failed-precondition", "This package isn't available right now. Please try again later.");
  }
  return priced;
}

/**
 * Admin-side check of the rule for a set of packages under the given rates.
 * Throws a message naming the first offending package and the minimum safe buy
 * rate, so the admin knows exactly what to change. Inactive packages are skipped:
 * they cannot be bought, and are checked again when re-activated.
 */
export function assertPackagesSafe(
  packages: { name?: string | null; coins?: unknown; bonusCoins?: unknown; active?: unknown; budgetId?: unknown }[],
  rates: Rates,
): void {
  if (!rates.payoutRate || !rates.buyRate) return;
  let worst: { name: string; need: number } | null = null;
  for (const p of packages) {
    if (p.active === false || p.active === 0) continue;
    const priced = pricePackage(p, rates);
    if (priced.reason !== "pays_out_more") continue;
    const need = minSafeBuyRate(p, rates.payoutRate);
    if (!worst || need > worst.need) worst = { name: p.name || "Untitled", need };
  }
  if (worst) {
    throw httpsError(
      "invalid-argument",
      // Diamonds are not withdrawn, but two players can turn them into prize
      // DP coins between themselves, so a Diamond sold below the DP coin
      // payout rate is a cash-out at a loss.
      `Nuksaan wala daam: package "${worst.name}" ke Diamond (bonus milake) contest jeet kar DP coin ban sakte hain, aur unka payout (₹${rates.payoutRate}/DP coin) package ke daam se zyada ho jayega. ` +
        `Buy rate kam se kam ₹${worst.need}/Diamond rakho, ya bonus kam karo, ` +
        `ya bonus ko ek "package_bonus" promo budget se jodo (platform ka kharcha budget me dikhega).`,
    );
  }
}

/** Validate an admin `coinPricing` patch in place. */
export function validateCoinPricingPatch(cp: any): void {
  if (!cp || typeof cp !== "object") throw httpsError("invalid-argument", "coinPricing must be an object.");
  if (cp.buyRate !== undefined) {
    const r = Number(cp.buyRate);
    if (!Number.isFinite(r) || r <= 0 || r > MAX_RATE) throw httpsError("invalid-argument", "Buy rate must be more than 0 (₹ per coin).");
    if (Math.round(r * 10000) !== Number((r * 10000).toFixed(4))) throw httpsError("invalid-argument", "Buy rate: at most 4 decimal places.");
    cp.buyRate = r;
  }
}
