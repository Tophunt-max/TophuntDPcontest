import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the action + payload sent to the worker.
const callApi = vi.fn(async () => ({ ok: true }));
vi.mock('@/src/services/api', () => ({
  callApi: (...args: any[]) => callApi(...args),
  readApi: vi.fn(),
}));

beforeEach(() => callApi.mockClear());

describe('walletService', () => {
  it('createOrder sends only the packageId (server prices it)', async () => {
    const { walletService } = await import('@/src/services/wallet/walletService');
    await walletService.createOrder('pkg1');
    expect(callApi).toHaveBeenCalledWith('createOrder', { packageId: 'pkg1' });
  });

  it('confirmTopup forwards the Razorpay proof to topup', async () => {
    const { walletService } = await import('@/src/services/wallet/walletService');
    const proof = { paymentId: 'p1', orderId: 'o1', signature: 's1' };
    await walletService.confirmTopup(proof);
    expect(callApi).toHaveBeenCalledWith('topup', proof);
  });

  it('claimDailyBonus calls claimDailyReward with the day index', async () => {
    const { walletService } = await import('@/src/services/wallet/walletService');
    await walletService.claimDailyBonus('uid-1', 3);
    expect(callApi).toHaveBeenCalledWith('claimDailyReward', { dayIndex: 3 });
  });
});
