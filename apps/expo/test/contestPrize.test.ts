/**
 * A contest can award coins or a physical product, and the product half keeps
 * `rewardCoins` at 0 on the server. So every card that reads only the coin figure
 * advertises "WINNER GETS 0 Coins" for the most valuable prizes in the app — which
 * is exactly what the three contest cards did before `contestPrize` existed.
 *
 * These lock the resolution rules, especially the DEGRADE paths, because those are
 * the ones no manual test exercises: a 60s-cached payload served across the deploy
 * that added the fields, and a product row whose title did not survive.
 */
import { describe, it, expect } from 'vitest';

import { contestPrize, describePrize, isProductPrize, matchPrize } from '@/src/lib/contestPrize';

describe('contestPrize', () => {
  it('reads a coin contest from either reward alias', () => {
    expect(contestPrize({ prizeType: 'coins', rewardCoins: 500 })).toEqual({
      type: 'coins',
      coins: 500,
      product: null,
    });
    expect(contestPrize({ winningCoins: 250 }).coins).toBe(250);
  });

  it('reads a product contest', () => {
    const prize = contestPrize({
      prizeType: 'product',
      prizeProductTitle: 'boAt Airdopes 141',
      prizeProductImageUrl: 'https://cdn.example/x.jpg',
      prizeProductValue: 1299,
      prizeProductDescription: 'Black, 42h playback',
      rewardCoins: 0,
    });
    expect(prize).toEqual({
      type: 'product',
      coins: 0,
      product: {
        title: 'boAt Airdopes 141',
        imageUrl: 'https://cdn.example/x.jpg',
        value: 1299,
        description: 'Black, 42h playback',
      },
    });
  });

  it('pays no coins for a product even if the coin column is populated', () => {
    // The server forces rewardCoins to 0, but a stale cached row could still carry
    // an old value. A product prize must never also promise coins.
    const prize = contestPrize({
      prizeType: 'product',
      prizeProductTitle: 'Phone',
      rewardCoins: 9999,
    });
    expect(prize.type).toBe('product');
    expect(prize.coins).toBe(0);
  });

  it('degrades to coins when the payload predates product prizes', () => {
    // No prizeType at all: a pre-0042 contest, or a cached response served across
    // the deploy. Both really are coin contests.
    expect(contestPrize({ rewardCoins: 100 })).toEqual({ type: 'coins', coins: 100, product: null });
    expect(contestPrize({ prizeType: null, rewardCoins: 100 }).type).toBe('coins');
    expect(contestPrize({ prizeType: 'something-new', rewardCoins: 100 }).type).toBe('coins');
  });

  it('degrades to coins when a product prize has no usable title', () => {
    // Without a name there is nothing to show, so claiming "you win a product"
    // would promise something the app cannot then display.
    expect(contestPrize({ prizeType: 'product', prizeProductTitle: '   ' }).type).toBe('coins');
    expect(contestPrize({ prizeType: 'product', prizeProductTitle: null }).type).toBe('coins');
  });

  it('never reports a negative or non-numeric declared value', () => {
    expect(contestPrize({ prizeType: 'product', prizeProductTitle: 'X', prizeProductValue: -5 }).product?.value).toBe(0);
    expect(
      contestPrize({ prizeType: 'product', prizeProductTitle: 'X', prizeProductValue: null }).product?.value,
    ).toBe(0);
    expect(
      contestPrize({ prizeType: 'product', prizeProductTitle: 'X', prizeProductValue: 1299.6 }).product?.value,
    ).toBe(1300);
  });

  it('treats a blank image or description as absent rather than empty string', () => {
    const prize = contestPrize({
      prizeType: 'product',
      prizeProductTitle: 'X',
      prizeProductImageUrl: '',
      prizeProductDescription: '   ',
    });
    expect(prize.product?.imageUrl).toBeNull();
    expect(prize.product?.description).toBeNull();
  });

  it('handles a missing contest without claiming a prize', () => {
    expect(contestPrize(null)).toEqual({ type: 'coins', coins: 0, product: null });
    expect(isProductPrize(undefined)).toBe(false);
  });
});

describe('describePrize', () => {
  it('names the product and its worth, never as coins', () => {
    const spoken = describePrize(
      contestPrize({ prizeType: 'product', prizeProductTitle: 'Phone', prizeProductValue: 12000 }),
    );
    expect(spoken).toBe('winner gets Phone, worth ₹12000');
    expect(spoken).not.toContain('coin');
  });

  it('omits the worth when none was declared', () => {
    expect(describePrize(contestPrize({ prizeType: 'product', prizeProductTitle: 'Phone' }))).toBe(
      'winner gets Phone',
    );
  });

  it('says nothing at all for a contest with no prize to speak of', () => {
    expect(describePrize(contestPrize({ rewardCoins: 0 }))).toBeNull();
  });
});


/**
 * `matchPrize` — what a BATTLE pays, as opposed to what a contest template awards.
 *
 * These pin the bug the feed card shipped: it rendered `item.entryFee * 1.8`.
 * `entryFee` on a match is the pot BOTH players funded, so that advertised 180% of
 * the money that existed against a server payout hard-capped at the pot; it had no
 * rounding, so a 7-coin pot displayed "12.6" for a whole-number currency; and it
 * showed a coin figure even when the prize was a physical product. Explore printed
 * the raw pot for the same battle, so the two surfaces disagreed.
 *
 * The reason a match needs its own resolver at all is that `/read/matches` carries
 * its coin figure as `rewardAmount`/`prizeCoins` (the snapshot frozen at creation),
 * NOT as `rewardCoins` — so `contestPrize` alone reports 0 for every coin battle.
 */
describe('matchPrize', () => {
  /** A match payload shaped like one from /read/matches. */
  const match = (extra: Record<string, unknown> = {}) => ({
    id: 'm1',
    entryFee: 100, // the POT, both players
    prizeType: 'coins',
    ...extra,
  });

  it('reads the coin prize from the match snapshot, not from entryFee', () => {
    // rewardAmount is the snapshot; entryFee is the pot and must not be used.
    expect(matchPrize(match({ rewardAmount: 100 }))).toEqual({
      type: 'coins',
      coins: 100,
      product: null,
    });
  });

  it('never exceeds the pot the two players funded', () => {
    // The server clamps the snapshot to the pot at creation; the card reads the
    // snapshot, so it cannot advertise more than was collected. The old
    // `entryFee * 1.8` produced 180.
    const prize = matchPrize(match({ entryFee: 100, rewardAmount: 100 }));
    expect(prize.coins).toBe(100);
    expect(prize.coins).toBeLessThanOrEqual(100);
  });

  it('falls back to prizeCoins when rewardAmount is absent', () => {
    expect(matchPrize(match({ rewardAmount: null, prizeCoins: 60 })).coins).toBe(60);
  });

  it('never renders a fractional coin amount', () => {
    // The regression: a 7-coin pot rendered 7 * 1.8 = 12.6. Coins are whole
    // numbers — apps/worker/src/lib/money.ts refuses to store a fraction — so a
    // card must never promise one.
    const prize = matchPrize(match({ entryFee: 7, rewardAmount: 6.5 }));
    expect(Number.isInteger(prize.coins)).toBe(true);
    expect(prize.coins).toBe(6);
  });

  it('reports a product prize as a product, with no coin figure', () => {
    // The old badge showed `entryFee * 1.8` coins for a phone.
    const prize = matchPrize(
      match({
        prizeType: 'product',
        prizeProductTitle: 'Redmi Note 13',
        prizeProductValue: 15999,
        rewardAmount: 0,
      }),
    );
    expect(prize.type).toBe('product');
    expect(prize.coins).toBe(0);
    expect(prize.product?.title).toBe('Redmi Note 13');
  });

  it('shows no prize rather than a wrong one when the snapshot is missing', () => {
    // A legacy match with no prize columns must not fall back to the pot.
    expect(matchPrize(match({ rewardAmount: null, prizeCoins: null })).coins).toBe(0);
    expect(matchPrize(null).coins).toBe(0);
    expect(matchPrize(undefined).coins).toBe(0);
  });

  it('is never negative', () => {
    expect(matchPrize(match({ rewardAmount: -50 })).coins).toBe(0);
  });
});
