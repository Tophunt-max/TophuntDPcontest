/**
 * One answer to "what does this battle cost, and is it free?".
 *
 * `contests.totalEntryFee` is the pot for BOTH players and each player pays
 * half. Every screen used to work that out for itself and they disagreed:
 * Explore and the photo setup screen halved it, while the photo and video
 * contest lists showed the raw total — advertising exactly double the real
 * price. Free contests were worse: the badge was rendered only when the fee was
 * above zero, so a free battle displayed no pricing at all and looked
 * indistinguishable from a card that had failed to load its price.
 *
 * The Worker now sends `entryFeePerPlayer` and `isFree` directly
 * (routes/read.ts mapContest). The fallbacks below cover payloads that predate
 * that — a 60s cached response served across a deploy, or a screen handed a
 * contest object assembled elsewhere.
 */

/** Anything shaped like a contest template from /read/contests. */
export interface ContestPricingInput {
  entryFeePerPlayer?: number | null;
  totalEntryFee?: number | null;
  entryFishCoins?: number | null;
  entryDpcoin?: number | null;
  /**
   * Alias carried by MATCH objects (`/read/matches`). Like the others it is the
   * total for both players, so it is halved the same way — the setup screen is
   * handed either a contest template or a match to join.
   */
  entryFee?: number | null;
  isFree?: boolean | null;
  rewardCoins?: number | null;
  winningCoins?: number | null;
}

const num = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/** Coins ONE player is charged to enter. 0 means free. */
export function entryFeePerPlayer(contest: ContestPricingInput | null | undefined): number {
  if (!contest) return 0;
  // Trust the server's own figure when present — it is computed by the same
  // function the ledger charges with, including its rounding.
  if (contest.entryFeePerPlayer !== null && contest.entryFeePerPlayer !== undefined) {
    return num(contest.entryFeePerPlayer);
  }
  const total =
    num(contest.totalEntryFee) ||
    num(contest.entryFishCoins) ||
    num(contest.entryDpcoin) ||
    num(contest.entryFee);
  // Math.floor, matching the Worker's perPlayerEntryFee: a player is never
  // charged a fraction of a coin, and rounding up here would quote a price
  // higher than the one actually taken.
  return Math.floor(total / 2);
}

/**
 * True when neither player pays anything to enter.
 *
 * A missing contest is NOT free. Failing open would make a card whose data has
 * not loaded advertise free entry — the one direction a price must never be
 * wrong in.
 */
export function isFreeContest(contest: ContestPricingInput | null | undefined): boolean {
  if (!contest) return false;
  if (typeof contest.isFree === 'boolean') return contest.isFree;
  return entryFeePerPlayer(contest) <= 0;
}

/** Coins the winner takes. */
export function rewardCoins(contest: ContestPricingInput | null | undefined): number {
  if (!contest) return 0;
  return num(contest.rewardCoins) || num(contest.winningCoins);
}
