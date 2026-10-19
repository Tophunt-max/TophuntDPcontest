/**
 * Coin package pricing: price = BASE coins × coin value (₹ per coin).
 *
 * The admin's coin value (App Control → Withdrawal → "Coin → ₹ rate",
 * `appConfig.withdrawal.conversionRate`) is now the ONE number that prices every
 * package. Bonus coins are free: they are never part of the price.
 *
 *   15 coins + 5 bonus at ₹0.50/coin  ->  ₹7.50, credits 20 coins
 *
 * Before this, each package carried its own stored `price_inr`, so changing the
 * coin value moved every "≈ ₹" estimate in the app but left every price where it
 * was. The stored column is now only a snapshot written for reference.
 *
 * Every path that SHOWS or CHARGES a price uses this module — the public catalog
 * (`coinCatalog.ts`), Razorpay `createOrder` and the manual `requestDeposit` — so
 * the price a user sees is the price they are charged. An order or deposit
 * records its amount when it is created, so a rate change never alters one that
 * is already in flight.
 */
import { httpsError } from "./http";

/** Smallest amount Razorpay (and UPI) will accept. */
export const MIN_PACKAGE_PRICE_INR = 1;

/**
 * The coin value that prices packages, or null when it is unusable.
 *
 * Mirrors the withdrawal policy (lib/payouts.ts readWithdrawalPolicy): an unset
 * rate keeps the historical default of 1, while an explicitly configured rate
 * that is zero, negative or non-numeric is treated as unusable (null). That makes
 * every package unpurchasable rather than guessing at a price.
 */
export function coinValueFromConfig(cfg: any): number | null {
  const raw = cfg?.withdrawal?.conversionRate;
  if (raw === undefined || raw === null || raw === "") return 1;
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Price in rupees for a package, rounded to the paisa. Bonus coins are free. */
export function packagePriceInr(baseCoins: number, rate: number | null): number {
  const coins = Number(baseCoins) || 0;
  if (!rate || coins <= 0) return 0;
  return Math.round(coins * rate * 100) / 100;
}

export interface PricedPackage {
  baseCoins: number;
  bonusCoins: number;
  totalCoins: number;
  priceInr: number;
  /** False when the price is below MIN_PACKAGE_PRICE_INR or the coin value is unusable. */
  purchasable: boolean;
}

export function pricePackage(pkg: { coins?: unknown; bonusCoins?: unknown }, rate: number | null): PricedPackage {
  const baseCoins = Number(pkg.coins) || 0;
  const bonusCoins = Number(pkg.bonusCoins) || 0;
  const priceInr = packagePriceInr(baseCoins, rate);
  return {
    baseCoins,
    bonusCoins,
    totalCoins: baseCoins + bonusCoins,
    priceInr,
    purchasable: priceInr >= MIN_PACKAGE_PRICE_INR,
  };
}

/** Price a package for a real charge, or refuse with a message the user can act on. */
export function chargeablePackage(pkg: { coins?: unknown; bonusCoins?: unknown }, cfg: any): PricedPackage {
  const rate = coinValueFromConfig(cfg);
  if (rate === null) throw httpsError("failed-precondition", "Coin purchases are paused right now. Please try again later.");
  const priced = pricePackage(pkg, rate);
  if (priced.totalCoins <= 0 || priced.baseCoins <= 0) {
    throw httpsError("failed-precondition", "This coin package is misconfigured.");
  }
  if (!priced.purchasable) {
    throw httpsError("failed-precondition", `This package costs less than ₹${MIN_PACKAGE_PRICE_INR} and can't be paid for. Please pick a bigger one.`);
  }
  return priced;
}
