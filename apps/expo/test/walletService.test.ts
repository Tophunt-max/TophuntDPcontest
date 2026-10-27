import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the action + payload sent to the worker.
const callApi = vi.fn(async () => ({ ok: true }));
vi.mock('@/src/services/api', () => ({
  callApi: (...args: any[]) => (callApi as any)(...args),
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

  it('claimDailyBonus calls claimDailyReward and sends nothing (the server decides the day)', async () => {
    const { walletService } = await import('@/src/services/wallet/walletService');
    await walletService.claimDailyBonus();
    expect(callApi).toHaveBeenCalledWith('claimDailyReward', {});
  });

  it('getDailyReward reads the server check-in track', async () => {
    const { walletService } = await import('@/src/services/wallet/walletService');
    await walletService.getDailyReward();
    expect(callApi).toHaveBeenCalledWith('getDailyReward', {});
  });

  it('claimAdReward calls the claimAdReward action', async () => {
    const { walletService } = await import('@/src/services/wallet/walletService');
    await walletService.claimAdReward();
    expect(callApi).toHaveBeenCalledWith('claimAdReward', {});
  });
});
