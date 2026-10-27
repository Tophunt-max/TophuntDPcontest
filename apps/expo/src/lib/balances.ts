/**
 * The two balances a user sees (worker lib/diamonds.ts).
 *
 *   Diamond  play-only. The only way to pay a contest entry fee. Comes from
 *            coin packages and free rewards. Never withdrawable.
 *   DP coin  contest prizes. The only balance that can be withdrawn.
 *
 * The server stores one total (`dpcoin`, mapped to `Dpcoin` on the profile) and
 * the Diamond part of it (`lockedCoins`), so both are derived here.
 */
export interface Balances {
  dpcoin: number;
  diamonds: number;
}

export function balancesOf(profile: { Dpcoin?: unknown; dpcoin?: unknown; lockedCoins?: unknown } | null | undefined): Balances {
  const total = Math.max(0, Number(profile?.Dpcoin ?? profile?.dpcoin ?? 0) || 0);
  const diamonds = Math.min(total, Math.max(0, Number(profile?.lockedCoins ?? 0) || 0));
  return { dpcoin: total - diamonds, diamonds };
}

/** How a ledger row splits across the two balances (`lockedDelta` is its Diamond part). */
export function splitTransaction(amount: number, lockedDelta: number): Balances {
  const diamonds = Number(lockedDelta) || 0;
  return { diamonds, dpcoin: (Number(amount) || 0) - diamonds };
}
