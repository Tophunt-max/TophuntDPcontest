/**
 * The app's withdrawal-fee preview must match what the Worker charges. Same
 * vectors as apps/worker/test/withdrawalFee.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { describeFeeRule, feeRuleFromWithdrawalConfig, quoteWithdrawal } from '@/src/lib/withdrawalFee';

const VECTORS: { coins: number; rate: number; rule: any; gross: number; fee: number; net: number }[] = [
  { coins: 100, rate: 0.1, rule: {}, gross: 10, fee: 0, net: 10 },
  { coins: 100, rate: 0.1, rule: { feePercent: 5, feeFlat: 2 }, gross: 10, fee: 2.5, net: 7.5 },
  { coins: 200, rate: 0.1, rule: { feePercent: 2, feeMin: 3 }, gross: 20, fee: 3, net: 17 },
  { coins: 100000, rate: 0.1, rule: { feePercent: 10, feeMax: 50 }, gross: 10000, fee: 50, net: 9950 },
  { coins: 333, rate: 0.1, rule: { feePercent: 2.5 }, gross: 33.3, fee: 0.83, net: 32.47 },
  { coins: 10, rate: 0.1, rule: { feeFlat: 5 }, gross: 1, fee: 1, net: 0 },
];

describe('withdrawal fee preview', () => {
  for (const v of VECTORS) {
    it(`${v.coins} coins with ${JSON.stringify(v.rule)}`, () => {
      const q = quoteWithdrawal(v.coins, v.rate, feeRuleFromWithdrawalConfig(v.rule));
      expect([q.grossInr, q.feeInr, q.netInr]).toEqual([v.gross, v.fee, v.net]);
    });
  }
  it('describes the rule in one line', () => {
    expect(describeFeeRule(feeRuleFromWithdrawalConfig({ feePercent: 5, feeFlat: 2, feeMin: 1, feeMax: 50 }))).toBe('5% + ₹2 (min ₹1, max ₹50)');
    expect(describeFeeRule(feeRuleFromWithdrawalConfig({}))).toBe('');
  });
});
