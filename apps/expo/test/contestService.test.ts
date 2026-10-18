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

describe('contestService.getMatchStoryStatus', () => {
  it('asks the server for the confirmed state and sends nothing but the match id', async () => {
    // No status, entry or fee travels with this call: the client can read the
    // VS Story state, never declare it.
    callApi.mockResolvedValueOnce({ storyStatus: 'preparing' } as any);
    const { contestService } = await import('@/src/services/contests/contestService');
    const res = await contestService.getMatchStoryStatus('m1');
    expect(callApi).toHaveBeenCalledWith('getMatchStoryStatus', { matchId: 'm1' });
    expect(res.storyStatus).toBe('preparing');
  });
});
