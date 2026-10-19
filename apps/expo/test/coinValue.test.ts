/**
 * Coin value (₹ per coin) and the live coin-package catalog.
 */
import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

vi.mock('@/src/services/api', () => ({ readApiLive: async () => [] }));
vi.mock('@/src/services/appSettings', () => ({ useAppConfig: () => ({ config: null }) }));

import { coinRate, coinsInInr, formatInr, markBestValue, selectedPackageChange, type CoinPackage } from '@/src/lib/coinValue';
import { applyCoinPackages, COIN_PACKAGES_QUERY_KEY } from '@/src/hooks/useCoinPackages';

const pkg = (id: string, totalCoins: number, priceInr: number): CoinPackage => ({ id, coins: totalCoins, bonusCoins: 0, totalCoins, priceInr });

describe('coin value', () => {
  it('reads the admin rate, and shows nothing when it is unset or invalid', () => {
    expect(coinRate({ withdrawal: { conversionRate: 0.1 } })).toBe(0.1);
    expect(coinRate({ withdrawal: { conversionRate: 0 } })).toBeNull();
    expect(coinRate({})).toBeNull();
    expect(coinsInInr(1250, null)).toBeNull();
  });
  it('formats rupees the Indian way', () => {
    expect(coinsInInr(1250, 0.1)).toBe('≈ ₹125');
    expect(coinsInInr(125000, 1)).toBe('≈ ₹1,25,000');
    expect(formatInr(12.5)).toBe('₹12.50');
  });
});

describe('coin packages', () => {
  it('flags exactly one best-value package', () => {
    const rows = markBestValue([pkg('a', 100, 100), pkg('b', 550, 500), pkg('c', 1200, 1000)]);
    expect(rows.filter((r) => r.popular).map((r) => r.id)).toEqual(['c']);
    expect(markBestValue([])).toEqual([]);
  });

  it('tells the deposit screen when the package being paid for changed', () => {
    const before = [pkg('a', 100, 99)];
    expect(selectedPackageChange(before, [pkg('a', 100, 79)], 'a')).toBe('price');
    expect(selectedPackageChange(before, [], 'a')).toBe('gone');
    expect(selectedPackageChange(before, [pkg('a', 100, 99)], 'a')).toBeNull();
    expect(selectedPackageChange(before, [pkg('b', 1, 1)], null)).toBeNull();
  });

  it('a pushed catalog replaces the cached one; an older push is ignored', () => {
    const qc = new QueryClient();
    applyCoinPackages(qc, [pkg('a', 100, 99)], 2000);
    expect(qc.getQueryData<CoinPackage[]>(COIN_PACKAGES_QUERY_KEY)?.[0].priceInr).toBe(99);
    applyCoinPackages(qc, [pkg('a', 100, 79)], 3000);
    expect(qc.getQueryData<CoinPackage[]>(COIN_PACKAGES_QUERY_KEY)?.[0].priceInr).toBe(79);
    applyCoinPackages(qc, [pkg('a', 100, 99)], 2500);
    expect(qc.getQueryData<CoinPackage[]>(COIN_PACKAGES_QUERY_KEY)?.[0].priceInr).toBe(79);
    applyCoinPackages(qc, 'junk', 4000);
    expect(qc.getQueryData<CoinPackage[]>(COIN_PACKAGES_QUERY_KEY)).toHaveLength(1);
  });
});
