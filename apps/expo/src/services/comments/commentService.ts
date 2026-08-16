import { callApi, readApi, poll } from '../api';
import { live } from '../realtime';

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
}

/**
 * Comments now live in D1 (post_comments / match_comments) behind the Worker.
 * `collectionName` maps to targetType: 'posts' | 'matches'|'contestMatches'.
 */
export const commentService = {
  addComment: async (
    postId: string,
    _userId: string,
    _username: string,
    _userAvatar: string,
    text: string,
    collectionName: string = 'posts',
  ) => {
    const res: any = await callApi('addComment', { targetType: collectionName, targetId: postId, text });
    return res.commentId;
  },

  /**
   * Live comments.
   * - For contest matches, subscribe to the match's WebSocket channel so new
   *   comments appear instantly (with a slow safety-net refresh built into
   *   `live`). The server publishes `{ type: 'comment' }` on `match:<id>`.
   * - Posts have no realtime channel yet, so they keep a light poll. (Add a
   *   `post:<id>` channel on the worker to make these instant too.)
   */
  subscribeToComments: (
    postId: string,
    callback: (comments: Comment[]) => void,
    collectionName: string = 'posts',
  ) => {
    const fetcher = () => readApi('/read/comments', { targetType: collectionName, targetId: postId });
    const isMatch = collectionName === 'matches' || collectionName === 'contestMatches';

    if (isMatch) {
      return live<Comment[]>(
        `match:${postId}`,
        fetcher,
        (comments) => callback(comments || []),
        { filter: (e) => e.type === 'comment' },
      );
    }

    return poll<Comment[]>(fetcher, (comments) => callback(comments || []), 6000);
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
};
