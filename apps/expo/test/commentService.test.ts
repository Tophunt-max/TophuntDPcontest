import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const subscribeChannel = vi.fn(() => () => {});
const readApi = vi.fn(async () => [] as any);
const callApi = vi.fn(async () => ({} as any));

vi.mock('@/src/services/realtime', () => ({
  subscribeChannel: (...a: any[]) => (subscribeChannel as any)(...a),
}));
vi.mock('@/src/services/api', () => ({
  callApi: (...a: any[]) => (callApi as any)(...a),
  readApi: (...a: any[]) => (readApi as any)(...a),
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


/**
 * The `blog` target crosses a seam no other test covers.
 *
 * `targetType` is an untyped string that the client hands to the Worker, and the
 * Worker branches on it for EVERY operation — add, delete, like, read — with
 * `posts` as the fallthrough. So a typo or a dropped argument on this side does
 * not fail: it writes `post_comments` instead of `blog_comments`, bumps a social
 * post's `comment_count`, and returns 200. The article would just never show the
 * comment.
 *
 * The Worker side of the same contract is pinned in
 * apps/worker/test/blogComments.test.ts, which accepts exactly the bodies
 * asserted here. Together they cover the request end to end without needing a
 * signed-in browser session against production.
 */
describe('commentService: the blog target contract', () => {
  it('addComment sends targetType "blog" verbatim, with the idempotency token', async () => {
    callApi.mockResolvedValueOnce({ commentId: 'srv-blog-1' });
    const { commentService } = await import('@/src/services/comments/commentService');

    const id = await commentService.addComment('article-1', 'great read', 'blog', 'tok-1');

    expect(id).toBe('srv-blog-1');
    const [action, payload] = callApi.mock.calls[0] as any[];
    expect(action).toBe('addComment');
    expect(payload).toEqual({
      targetType: 'blog',
      targetId: 'article-1',
      text: 'great read',
      clientId: 'tok-1',
    });
  });

  it('addComment still generates a clientId when the caller omits one', async () => {
    callApi.mockResolvedValueOnce({ commentId: 'srv-blog-2' });
    const { commentService } = await import('@/src/services/comments/commentService');

    await commentService.addComment('article-1', 'hi', 'blog');

    const [, payload] = callApi.mock.calls[0] as any[];
    // Without this the server cannot dedupe a retried submit, and a flaky
    // connection double-posts on a public page.
    expect(typeof payload.clientId).toBe('string');
    expect(payload.clientId.length).toBeGreaterThan(0);
  });

  it('getComments requests the blog thread and surfaces the total', async () => {
    readApi.mockResolvedValueOnce({ items: [{ id: 'c1' }], nextCursor: null, total: 42 });
    const { commentService } = await import('@/src/services/comments/commentService');

    const page = await commentService.getComments('article-1', 'blog', null, 20);

    const [path, query] = readApi.mock.calls[0] as any[];
    expect(path).toBe('/read/comments');
    expect(query).toMatchObject({ targetType: 'blog', targetId: 'article-1', limit: 20 });
    // The heading count comes from here, not from items.length.
    expect(page.total).toBe(42);
  });

  it('getComments leaves total undefined when the server does not send one', async () => {
    readApi.mockResolvedValueOnce({ items: [{ id: 'c1' }], nextCursor: null });
    const { commentService } = await import('@/src/services/comments/commentService');

    const page = await commentService.getComments('p1', 'posts');

    // Must be absent rather than 0, so a caller can tell "no count available"
    // from "an empty thread".
    expect(page.total).toBeUndefined();
  });

  it('deleteComment and likeComment carry the blog target through', async () => {
    const { commentService } = await import('@/src/services/comments/commentService');

    callApi.mockResolvedValueOnce({ success: true });
    await commentService.deleteComment('article-1', 'c1', 'blog');
    expect(callApi.mock.calls[0]).toEqual([
      'deleteComment',
      { targetType: 'blog', targetId: 'article-1', commentId: 'c1' },
    ]);

    callApi.mockResolvedValueOnce({ liked: true, likeCount: 3 });
    const res = await commentService.likeComment('c1', 'blog');
    expect(callApi.mock.calls[1]).toEqual(['likeComment', { commentId: 'c1', targetType: 'blog' }]);
    expect(res).toEqual({ liked: true, likeCount: 3 });
  });

  it('does not open an 8-second poll for a blog article', async () => {
    // `onCommentEvent` degrades to an interval for any non-match target. An
    // article can sit open in a tab for an hour, so BlogComments deliberately
    // does not use it — this pins the behaviour that made that decision.
    vi.useFakeTimers();
    try {
      const { commentService } = await import('@/src/services/comments/commentService');
      const onBump = vi.fn();
      const unsub = commentService.onCommentEvent('article-1', 'blog', onBump);

      expect(subscribeChannel).not.toHaveBeenCalled();
      vi.advanceTimersByTime(8000);
      expect(onBump).toHaveBeenCalledTimes(1); // it WOULD poll, hence the choice
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });
});
