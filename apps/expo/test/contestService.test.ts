import { describe, it, expect, vi, beforeEach } from 'vitest';

const callApi = vi.fn(async () => ({ success: true }));
vi.mock('@/src/services/api', () => ({
  callApi: (...args: any[]) => (callApi as any)(...args),
  readApi: vi.fn(async () => []),
}));

// Stable device id from the shared util.
vi.mock('@/src/lib/deviceId', () => ({ getDeviceId: vi.fn(async () => 'dev-abc') }));

beforeEach(() => callApi.mockClear());

describe('contestService.voteOnMatch', () => {
  it('uses the stable device id when none is provided', async () => {
    const { contestService } = await import('@/src/services/contests/contestService');
    await contestService.voteOnMatch('m1', 'u2');
    expect(callApi).toHaveBeenCalledWith('submitVote', {
      matchId: 'm1',
      votedForUid: 'u2',
      deviceId: 'dev-abc',
    });
  });
});
