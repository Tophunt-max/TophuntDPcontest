/**
 * What a contest awards: coins, or one physical product. Never both.
 *
 * Client mirror of the Worker's `publicPrize` (apps/worker/src/lib/prizes.ts),
 * which spreads these five fields into every contest `/read/contests` returns.
 *
 * ---------------------------------------------------------------------------
 * Why this is not just a big `rewardCoins`
 * ---------------------------------------------------------------------------
 * A product prize keeps `rewardCoins` at 0 on the server, because coin rewards are
 * capped at the entry-fee pot the two players funded and a phone has no coin value
 * to cap. So a product contest read through `rewardCoins()` alone reports 0 — which
 * is how a card ends up advertising "WINNER GETS 0 Coins" for a contest whose prize
 * is a phone. Every surface that shows a prize has to go through here instead.
 *
 * ---------------------------------------------------------------------------
 * Everything unrecognised degrades to coins
 * ---------------------------------------------------------------------------
 * That is the safe direction, and it matters twice over:
 *
 *  - `/read/contests` is cached for 60s, so for a minute after the deploy that
 *    added these fields the app is served payloads without them;
 *  - contests created before the feature existed have no `prizeType` at all.
 *
 * In both cases the contest really is a coin contest, and `coins` is also the
 * claim we can actually honour — describing a prize as a product we have no name
 * for would promise the user something the app cannot then show them.
 */
import { rewardCoins, type ContestPricingInput } from './contestPricing';

export type PrizeType = 'coins' | 'product';

export interface ProductPrize {
  title: string;
  imageUrl: string | null;
  /**
   * Declared retail value in rupees. DISPLAY ONLY — it is never credited and never
   * spendable, so it must never be rendered as coins or added to a balance.
   */
  value: number;
  description: string | null;
}

/** A resolved prize. Exactly one of `coins` / `product` is meaningful. */
export type ContestPrize =
  | { type: 'coins'; coins: number; product: null }
  | { type: 'product'; coins: 0; product: ProductPrize };

/** Anything shaped like a contest template carrying the prize columns. */
export interface ContestPrizeInput extends ContestPricingInput {
  prizeType?: string | null;
  prizeProductTitle?: string | null;
  prizeProductImageUrl?: string | null;
  prizeProductValue?: number | null;
  prizeProductDescription?: string | null;
}

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/**
 * Resolve what this contest awards.
 *
 * A product prize with no surviving title falls back to coins, matching the
 * Worker's `resolveMatchPrize`: without a name there is nothing to show, and the
 * coin figure at least leaves the user no worse off than a coin contest would.
 */
export function contestPrize(contest: ContestPrizeInput | null | undefined): ContestPrize {
  const coins = rewardCoins(contest);
  if (!contest || contest.prizeType !== 'product') {
    return { type: 'coins', coins, product: null };
  }

  const title = text(contest.prizeProductTitle);
  if (!title) return { type: 'coins', coins, product: null };

  const rawValue = Number(contest.prizeProductValue ?? 0);
  return {
    type: 'product',
    coins: 0,
    product: {
      title,
      imageUrl: text(contest.prizeProductImageUrl),
      value: Number.isFinite(rawValue) && rawValue > 0 ? Math.round(rawValue) : 0,
      description: text(contest.prizeProductDescription),
    },
  };
}

/** True when this contest ships a physical item rather than crediting coins. */
export function isProductPrize(contest: ContestPrizeInput | null | undefined): boolean {
  return contestPrize(contest).type === 'product';
}

/**
 * The prize a MATCH pays, resolved from the match's own snapshot.
 *
 * A match payload is not a contest template, and reading it as one is how surfaces
 * ended up inventing their own arithmetic. `/read/matches` spreads `publicPrize`
 * (so `prizeType` and the product fields are present) but carries its coin figure
 * as `rewardAmount`/`prizeCoins` — the snapshot frozen at creation — NOT as
 * `rewardCoins`. So `contestPrize(match)` alone reports 0 coins for every coin
 * battle, and the feed card worked around that with `item.entryFee * 1.8`: the
 * both-player pot multiplied by a guess, which advertised 180% of the money that
 * existed, disagreed with Explore's figure for the same battle, rendered a coin
 * amount for product-prize battles, and produced fractions (a 7-coin pot showed
 * "12.6") for a currency the server refuses to store fractionally.
 *
 * This is the pattern `src/lib/vsStory.ts` already used, lifted out so every
 * surface shares one answer. Reading the snapshot also means a card shows what the
 * battle actually pays, not what its template pays today.
 */
export function matchPrize(match: (ContestPrizeInput & { rewardAmount?: number | null; prizeCoins?: number | null }) | null | undefined): ContestPrize {
  if (!match) return { type: 'coins', coins: 0, product: null };
  const resolved = contestPrize(match);
  if (resolved.type === 'product') return resolved;
  // Snapshot first, then the template alias, then the generic fields. `Math.floor`
  // because coins are whole numbers — the server never credits a fraction, so a
  // card must never promise one.
  const snapshot = Number(match.rewardAmount ?? match.prizeCoins ?? 0);
  const coins = Number.isFinite(snapshot) && snapshot > 0 ? Math.floor(snapshot) : resolved.coins;
  return { type: 'coins', coins: Math.max(0, Math.floor(coins)), product: null };
}

/**
 * One line describing the prize, for accessibility labels and any single-line
 * summary. Kept here so the cards cannot each invent their own phrasing.
 */
export function describePrize(prize: ContestPrize): string | null {
  if (prize.type === 'product') {
    return prize.product.value > 0
      ? `winner gets ${prize.product.title}, worth ₹${prize.product.value}`
      : `winner gets ${prize.product.title}`;
  }
  return prize.coins > 0 ? `winner gets ${prize.coins} coins` : null;
}
