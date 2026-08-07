import { callApi, readApi, poll } from '../api';

export interface Comment {
  id: string;
  postId: string;
  userId: string;
  username: string;
  userAvatar: string;
  text: string;
  createdAt: any;
  likes: number;
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

  // Realtime via polling (was Firestore onSnapshot).
  subscribeToComments: (
    postId: string,
    callback: (comments: Comment[]) => void,
    collectionName: string = 'posts',
  ) => {
    return poll<Comment[]>(
      () => readApi('/read/comments', { targetType: collectionName, targetId: postId }),
      (comments) => callback(comments || []),
      6000,
    );
  },

  deleteComment: async (postId: string, commentId: string, collectionName: string = 'posts') => {
    await callApi('deleteComment', { targetType: collectionName, targetId: postId, commentId });
  },
};
