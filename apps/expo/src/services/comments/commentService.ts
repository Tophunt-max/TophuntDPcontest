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
    getDoc
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
}

export const commentService = {
  addComment: async (postId: string, userId: string, username: string, userAvatar: string, text: string, collectionName: string = 'posts') => {
    const commentData = {
      postId,
      userId,
      username,
      userAvatar,
      text,
      createdAt: serverTimestamp(),
      likes: 0
    };

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
            if (postData.userId !== userId) {
                await callApi('notificationApi', {
                    type: 'COMMENT',
                    data: {
                        targetId: postId,
                        authorId: postData.userId,
                        commenterId: userId,
                        text: text,
                        image: postData.mediaUrl || null
                    }
                });
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
      orderBy('createdAt', 'desc')
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
  }
};
