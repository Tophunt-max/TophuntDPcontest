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

import { contestPrize, describePrize, isProductPrize } from '@/src/lib/contestPrize';

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
