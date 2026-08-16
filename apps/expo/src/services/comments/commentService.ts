import { callApi, readApi } from '../api';
import { subscribeChannel } from '../realtime';

export interface Comment {
  id: string;
  postId: string;
  userId: string;
  username: string;
  userAvatar: string;
  text: string;
  createdAt: any;
  likes: number;
  likedByMe?: boolean;
  /** Marks a locally-inserted comment that hasn't been confirmed by the server. */
  pending?: boolean;
}

export interface CommentPage {
  items: Comment[];
  nextCursor: string | null;
}

/** Simple client dedup token so a retried post never double-creates. */
const clientToken = (): string =>
  `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Comments live in D1 (post_comments / match_comments) behind the Worker.
 * `collectionName` maps to targetType: 'posts' | 'matches' | 'contestMatches'.
 * The list is cursor-paginated (Instagram-style "load older on scroll").
 */
export const commentService = {
  /** Fetch one page. `cursor` = null for the first (newest) page. */
  getComments: async (
    postId: string,
    collectionName: string = 'posts',
    cursor: string | null = null,
    limit: number = 20,
  ): Promise<CommentPage> => {
    const res: any = await readApi('/read/comments', {
      targetType: collectionName,
      targetId: postId,
      cursor: cursor || undefined,
      limit,
    });
    // Tolerate both the paginated shape and a legacy bare array.
    if (Array.isArray(res)) return { items: res as Comment[], nextCursor: null };
    return { items: (res?.items as Comment[]) || [], nextCursor: res?.nextCursor ?? null };
  },

  /**
   * Post a comment. Pass a stable `clientId` (generated once per attempt) so a
   * network retry is idempotent on the server. Returns the server comment id.
   */
  addComment: async (
    postId: string,
    text: string,
    collectionName: string = 'posts',
    clientId?: string,
  ): Promise<string> => {
    const res: any = await callApi('addComment', {
      targetType: collectionName,
      targetId: postId,
      text,
      clientId: clientId || clientToken(),
    });
    return res.commentId as string;
  },

  deleteComment: async (postId: string, commentId: string, collectionName: string = 'posts') => {
    await callApi('deleteComment', { targetType: collectionName, targetId: postId, commentId });
  },

  /**
   * Toggle a like on a single comment. Returns the new liked state and the
   * authoritative like count so the UI can reconcile its optimistic update.
   */
  likeComment: async (
    commentId: string,
    collectionName: string = 'posts',
  ): Promise<{ liked: boolean; likeCount: number }> => {
    const res: any = await callApi('likeComment', { commentId, targetType: collectionName });
    return { liked: !!res.liked, likeCount: Number(res.likeCount ?? 0) };
  },

  /** Report a comment for moderation. */
  reportComment: async (
    commentId: string,
    _collectionName: string = 'posts',
    reason: string = 'Inappropriate comment',
  ) => {
    await callApi('createReport', { targetType: 'comment', targetId: commentId, reason });
  },

  /**
   * Fire `onBump` whenever a new comment arrives so the caller can refresh the
   * first page. Matches push instantly over their WebSocket channel; posts have
   * no channel yet, so they fall back to a light interval.
   */
  onCommentEvent: (
    postId: string,
    collectionName: string,
    onBump: () => void,
  ): (() => void) => {
    const isMatch = collectionName === 'matches' || collectionName === 'contestMatches';
    if (isMatch) {
      return subscribeChannel(`match:${postId}`, (e) => {
        if (e.type === 'comment') onBump();
      });
    }
    let active = true;
    const timer = setInterval(() => { if (active) onBump(); }, 8000);
    return () => { active = false; clearInterval(timer); };
  },

  clientToken,
};
