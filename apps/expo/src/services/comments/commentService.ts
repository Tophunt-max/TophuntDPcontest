import { 
    collection, 
    addDoc, 
    query, 
    where, 
    orderBy, 
    onSnapshot, 
    serverTimestamp, 
    doc, 
    updateDoc, 
    increment,
    deleteDoc,
    getDoc,
    setDoc,
    runTransaction
} from 'firebase/firestore';
import { firestore } from '../firebase/initFirebase';
import { callApi } from '../api';

export interface Comment {
  id: string;
  postId: string;
  userId: string;
  username: string;
  userAvatar: string;
  text: string;
  createdAt: any;
  likes: number;
  replyTo?: string; // ID of the comment being replied to
  replyToUser?: string; // Username of the user being replied to
}

export const commentService = {
  addComment: async (
    postId: string, 
    userId: string, 
    username: string, 
    userAvatar: string, 
    text: string, 
    collectionName: string = 'posts',
    replyTo?: string,
    replyToUser?: string
  ) => {
    const commentData: any = {
      postId,
      userId,
      username,
      userAvatar,
      text,
      createdAt: serverTimestamp(),
      likes: 0
    };

    if (replyTo) {
        commentData.replyTo = replyTo;
        commentData.replyToUser = replyToUser;
    }

    const commentRef = await addDoc(collection(firestore, collectionName, postId, 'comments'), commentData);

    const ref = doc(firestore, collectionName, postId);
    await updateDoc(ref, {
      commentCount: increment(1)
    });

    // --- NOTIFICATION LOGIC ---
    try {
        const postDoc = await getDoc(ref);
        if (postDoc.exists()) {
            const postData = postDoc.data();
            const ownerId = postData.userId || postData.userA?.uid;
            
            // Notify post owner
            if (ownerId && ownerId !== userId) {
                await callApi('notificationApi', {
                    type: 'COMMENT',
                    data: {
                        targetId: postId,
                        authorId: ownerId,
                        commenterId: userId,
                        text: text,
                        image: postData.mediaUrl || postData.userA?.mediaUrl || null
                    }
                });
            }

            // Also notify the person being replied to
            if (replyTo) {
                const parentCommentDoc = await getDoc(doc(firestore, collectionName, postId, 'comments', replyTo));
                if (parentCommentDoc.exists()) {
                    const parentData = parentCommentDoc.data();
                    if (parentData.userId !== userId && parentData.userId !== ownerId) {
                         await callApi('notificationApi', {
                            type: 'COMMENT_REPLY',
                            data: {
                                targetId: postId,
                                authorId: parentData.userId,
                                commenterId: userId,
                                text: text,
                                image: postData.mediaUrl || postData.userA?.mediaUrl || null
                            }
                        });
                    }
                }
            }
        }
    } catch (e) {
        console.warn("Notification failed, but comment was saved:", e);
    }

    return commentRef.id;
  },

  subscribeToComments: (postId: string, callback: (comments: Comment[]) => void, collectionName: string = 'posts') => {
    const q = query(
      collection(firestore, collectionName, postId, 'comments'),
      orderBy('createdAt', 'asc')
    );

    return onSnapshot(q, (snapshot) => {
      const comments = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Comment[];
      callback(comments);
    });
  },

  deleteComment: async (postId: string, commentId: string, collectionName: string = 'posts') => {
    await deleteDoc(doc(firestore, collectionName, postId, 'comments', commentId));
    const ref = doc(firestore, collectionName, postId);
    await updateDoc(ref, {
      commentCount: increment(-1)
    });
  },

  toggleLikeComment: async (postId: string, commentId: string, userId: string, collectionName: string = 'posts') => {
    const likeRef = doc(firestore, collectionName, postId, 'comments', commentId, 'likes', userId);
    const commentRef = doc(firestore, collectionName, postId, 'comments', commentId);

    try {
        const likeDoc = await getDoc(likeRef);
        if (likeDoc.exists()) {
            await deleteDoc(likeRef);
            await updateDoc(commentRef, { likes: increment(-1) });
            return false;
        } else {
            await setDoc(likeRef, { userId, createdAt: serverTimestamp() });
            await updateDoc(commentRef, { likes: increment(1) });
            return true;
        }
    } catch (e) {
        console.error("Error toggling comment like:", e);
        throw e;
    }
  },

  checkIfLiked: async (postId: string, commentId: string, userId: string, collectionName: string = 'posts') => {
      const likeRef = doc(firestore, collectionName, postId, 'comments', commentId, 'likes', userId);
      const snap = await getDoc(likeRef);
      return snap.exists();
  }
};
