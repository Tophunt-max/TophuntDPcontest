import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const subscribeChannel = vi.fn(() => () => {});
const readApi = vi.fn(async () => [] as any);
const callApi = vi.fn(async () => ({} as any));

vi.mock('@/src/services/realtime', () => ({
  subscribeChannel: (...a: any[]) => subscribeChannel(...a),
}));
vi.mock('@/src/services/api', () => ({
  callApi: (...a: any[]) => callApi(...a),
  readApi: (...a: any[]) => readApi(...a),
}));

beforeEach(() => {
  subscribeChannel.mockClear();
  readApi.mockClear();
  callApi.mockClear();
});

describe('commentService.onCommentEvent', () => {
  it('matches: subscribes to the match WS channel and bumps only on comment events', async () => {
    const { commentService } = await import('@/src/services/comments/commentService');
    const onBump = vi.fn();
    commentService.onCommentEvent('m1', 'contestMatches', onBump);

    expect(subscribeChannel).toHaveBeenCalledTimes(1);
    const [channel, handler] = subscribeChannel.mock.calls[0] as any[];
    expect(channel).toBe('match:m1');

    handler({ type: 'comment' });
    expect(onBump).toHaveBeenCalledTimes(1);
    handler({ type: 'vote' }); // unrelated event must be ignored
    expect(onBump).toHaveBeenCalledTimes(1);
  });

  it('posts: falls back to an interval bump (no WS channel)', async () => {
    vi.useFakeTimers();
    try {
      const { commentService } = await import('@/src/services/comments/commentService');
      const onBump = vi.fn();
      const unsub = commentService.onCommentEvent('p1', 'posts', onBump);

      expect(subscribeChannel).not.toHaveBeenCalled();
      vi.advanceTimersByTime(8000);
      expect(onBump).toHaveBeenCalledTimes(1);

      unsub();
      vi.advanceTimersByTime(8000); // stopped after unsubscribe
      expect(onBump).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('commentService.getComments', () => {
  it('returns { items, nextCursor } from the paginated shape', async () => {
    readApi.mockResolvedValueOnce({ items: [{ id: 'c1' }], nextCursor: 5 });
    const { commentService } = await import('@/src/services/comments/commentService');
    const page = await commentService.getComments('m1', 'contestMatches');
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(5);
  });

  it('tolerates a legacy bare array (nextCursor = null)', async () => {
    readApi.mockResolvedValueOnce([{ id: 'c2' }]);
    const { commentService } = await import('@/src/services/comments/commentService');
    const page = await commentService.getComments('m1', 'contestMatches');
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });
});

describe('commentService.addComment', () => {
  it('sends a clientId for idempotency and returns the server id', async () => {
    callApi.mockResolvedValueOnce({ commentId: 'srv1' });
    const { commentService } = await import('@/src/services/comments/commentService');
    const id = await commentService.addComment('m1', 'hi', 'contestMatches', 'client-xyz');
    expect(id).toBe('srv1');
    const [action, payload] = callApi.mock.calls[0] as any[];
    expect(action).toBe('addComment');
    expect(payload.clientId).toBe('client-xyz');
    expect(payload.targetId).toBe('m1');
  });
});
