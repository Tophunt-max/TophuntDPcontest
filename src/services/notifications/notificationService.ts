import { 
  collection, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  updateDoc, 
  doc, 
  writeBatch,
  getDocs,
  limit,
  Timestamp
} from 'firebase/firestore';
import { firestore as db } from '../firebase/initFirebase';

export interface Notification {
  id: string;
  type: 'like' | 'follow' | 'comment' | 'mention' | 'system';
  senderId: string;
  senderName: string;
  senderAvatar: string;
  receiverId: string;
  postId?: string;
  postImage?: string;
  commentText?: string;
  isRead: boolean;
  createdAt: any;
}

export const notificationService = {
  // Subscribe to real-time notifications
  subscribeToNotifications: (userId: string, callback: (notifications: Notification[]) => void) => {
    const q = query(
      collection(db, 'notifications'),
      where('receiverId', '==', userId),
      orderBy('createdAt', 'desc'),
      limit(50)
    );

    return onSnapshot(q, (snapshot) => {
      const notifications = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Notification[];
      callback(notifications);
    });
  },

  // Mark a single notification as read
  markAsRead: async (notificationId: string) => {
    try {
      const notificationRef = doc(db, 'notifications', notificationId);
      await updateDoc(notificationRef, { isRead: true });
    } catch (error) {
      console.error('Error marking notification as read:', error);
    }
  },

  // Mark all notifications as read for a user
  markAllAsRead: async (userId: string) => {
    try {
      const q = query(
        collection(db, 'notifications'),
        where('receiverId', '==', userId),
        where('isRead', '==', false)
      );
      
      const querySnapshot = await getDocs(q);
      const batch = writeBatch(db);
      
      querySnapshot.forEach((document) => {
        batch.update(doc(db, 'notifications', document.id), { isRead: true });
      });
      
      await batch.commit();
    } catch (error) {
      console.error('Error marking all notifications as read:', error);
    }
  },

  // Delete a notification
  deleteNotification: async (notificationId: string) => {
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, 'notifications', notificationId));
      await batch.commit();
    } catch (error) {
      console.error('Error deleting notification:', error);
    }
  }
};
