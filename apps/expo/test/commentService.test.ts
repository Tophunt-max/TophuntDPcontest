import { describe, it, expect, vi, beforeEach } from 'vitest';

const live = vi.fn(() => () => {});
const poll = vi.fn(() => () => {});

vi.mock('@/src/services/realtime', () => ({ live: (...a: any[]) => live(...a) }));
vi.mock('@/src/services/api', () => ({
  callApi: vi.fn(),
  readApi: vi.fn(async () => []),
  poll: (...a: any[]) => poll(...a),
}));

beforeEach(() => {
  live.mockClear();
  poll.mockClear();
});

describe('commentService.subscribeToComments', () => {
  it('uses the match WebSocket channel for contest matches (instant)', async () => {
    const { commentService } = await import('@/src/services/comments/commentService');
    commentService.subscribeToComments('m1', () => {}, 'contestMatches');

    expect(poll).not.toHaveBeenCalled();
    expect(live).toHaveBeenCalledTimes(1);
    const [channel, _fetcher, _cb, opts] = live.mock.calls[0] as any[];
    expect(channel).toBe('match:m1');
    // Only reacts to comment events, not votes/likes.
    expect(opts.filter({ type: 'comment' })).toBe(true);
    expect(opts.filter({ type: 'vote' })).toBe(false);
  });

  it('falls back to polling for posts (no realtime channel)', async () => {
    const { commentService } = await import('@/src/services/comments/commentService');
    commentService.subscribeToComments('p1', () => {}, 'posts');

    expect(live).not.toHaveBeenCalled();
    expect(poll).toHaveBeenCalledTimes(1);
    // Second arg to poll is the interval (ms).
    expect(poll.mock.calls[0][2]).toBe(6000);
  });
});
