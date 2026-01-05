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
    deleteDoc
} from 'firebase/firestore';
import { firestore } from '../firebase/initFirebase';

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
  // Add a new comment
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

    // 1. Add comment to subcollection
    const commentRef = await addDoc(collection(firestore, collectionName, postId, 'comments'), commentData);

    // 2. Increment comment count in post/match document
    const ref = doc(firestore, collectionName, postId);
    await updateDoc(ref, {
      commentCount: increment(1)
    });

    return commentRef.id;
  },

  // Subscribe to comments for a specific post/match
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

  // Delete a comment
  deleteComment: async (postId: string, commentId: string, collectionName: string = 'posts') => {
    await deleteDoc(doc(firestore, collectionName, postId, 'comments', commentId));
    
    // Decrement count
    const ref = doc(firestore, collectionName, postId);
    await updateDoc(ref, {
      commentCount: increment(-1)
    });
  }
};
