/**
 * Coin value (₹ per Dpcoin) and the coin-package catalog, as the app shows them.
 *
 * The rate is the admin's withdrawal conversion rate (App Control → Withdrawal
 * Settings → "Coin → ₹ rate"), the same number the server pays out at. Live: a
 * change arrives with the pushed app config.
 */

/** ₹ per coin, or null when not configured / invalid (then nothing is shown). */
export function coinRate(config: any): number | null {
  const r = Number(config?.withdrawal?.conversionRate);
  return Number.isFinite(r) && r > 0 ? r : null;
}

/** "₹1,250" / "₹12.50" (paise only when there are any). */
export function formatInr(amount: number): string {
  const n = Math.max(0, Number(amount) || 0);
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  return `₹${n.toLocaleString('en-IN', whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "≈ ₹125" for a coin amount, or null when the rate is unknown. */
export function coinsInInr(coins: number, rate: number | null): string | null {
  if (rate === null) return null;
  return `≈ ${formatInr((Number(coins) || 0) * rate)}`;
}

export interface CoinPackage {
  id: string;
  name?: string | null;
  coins: number;
  bonusCoins: number;
  /** Base coins × the admin's buy rate (bonus free), computed by the Worker. */
  priceInr: number;
  /** False when under ₹1, or when it would pay out more than it costs: shown, not sold. */
  purchasable?: boolean;
  /** The bonus is a platform promo: play-only coins, spendable on contests, never withdrawable. */
  bonusLocked?: boolean;
  totalCoins: number;
  popular?: boolean;
}

/** Flag the best value (most coins per rupee) for the store badge. Pure. */
export function markBestValue(rows: CoinPackage[] | null | undefined): CoinPackage[] {
  if (!Array.isArray(rows) || !rows.length) return [];
  let best = -1;
  let bestRatio = 0;
  rows.forEach((p, i) => {
    const ratio = p.priceInr > 0 ? p.totalCoins / p.priceInr : 0;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = i;
    }
  });
  return rows.map((p, i) => ({ ...p, popular: i === best }));
}

/**
 * What changed for a package the user has selected, between two catalogs:
 * 'gone' (removed / deactivated), 'price' (price or coins changed), or null.
 */
export function selectedPackageChange(
  before: CoinPackage[] | null | undefined,
  after: CoinPackage[] | null | undefined,
  id: string | null,
): 'gone' | 'price' | null {
  if (!id || !before || !after) return null;
  const a = before.find((p) => p.id === id);
  if (!a) return null;
  const b = after.find((p) => p.id === id);
  if (!b) return 'gone';
  return a.priceInr !== b.priceInr || a.totalCoins !== b.totalCoins ? 'price' : null;
}
