import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { 
  doc, 
  setDoc, 
  collection, 
  addDoc, 
  serverTimestamp, 
  query, 
  where, 
  getDocs, 
  limit, 
  Timestamp,
  onSnapshot,
  orderBy
} from 'firebase/firestore';
import { firestore, auth } from '@/src/services/firebase/initFirebase';

// Notification Type Definition
export interface Notification {
  id: string;
  type: 'like' | 'follow' | 'comment' | 'message' | 'battle_start' | 'contest_win' | 'profile_visit' | 'share' | 'bookmark';
  senderName: string;
  senderAvatar: string;
  createdAt: any;
  postImage?: string;
  commentText?: string;
  battleId?: string;
  chatId?: string;
  title?: string;
  body?: string;
}

/**
 * Enhanced registerForPushNotificationsAsync
 */
export async function registerForPushNotificationsAsync() {
  let token;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') {
      console.warn('Failed to get push token for push notification!');
      return;
    }
    
    try {
      const projectId = 
        Constants?.expoConfig?.extra?.eas?.projectId ?? 
        Constants?.easConfig?.projectId;
      
      if (!projectId) {
        throw new Error('Project ID not found');
      }

      token = (await Notifications.getExpoPushTokenAsync({
        projectId,
      })).data;
    } catch (e) {
      console.error('Error getting push token:', e);
    }
  } else {
    console.warn('Must use physical device for Push Notifications');
  }

  if (token) {
    const userId = auth.currentUser?.uid;
    if (userId) {
        const userDocRef = doc(firestore, 'users', userId);
        await setDoc(userDocRef, { pushToken: token }, { merge: true });
    }
  }

  return token;
}

/**
 * NAYA LOGIC (Additional Functions)
 */
export const notificationService = {
  // Track profile visit and notify the target user
  notifyProfileVisit: async (targetUserId: string) => {
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.uid === targetUserId) return;

    try {
      const notificationsRef = collection(firestore, `users/${targetUserId}/notifications`);
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      
      const q = query(
        notificationsRef,
        where('type', '==', 'profile_visit'),
        where('senderId', '==', currentUser.uid),
        where('createdAt', '>', Timestamp.fromDate(oneDayAgo)),
        limit(1)
      );

      const existingSnap = await getDocs(q);
      if (!existingSnap.empty) return; 

      await addDoc(notificationsRef, {
        type: 'profile_visit',
        senderId: currentUser.uid,
        senderName: currentUser.displayName || 'Someone',
        senderAvatar: currentUser.photoURL || `https://ui-avatars.com/api/?name=${currentUser.displayName}`,
        createdAt: serverTimestamp(),
        read: false
      });
    } catch (error) {
      console.error("Error notifying profile visit:", error);
    }
  },

  // NEW: Notify Battle Actions (Share/Bookmark)
  notifyBattleAction: async (battleId: string, participantIds: string[], contestName: string, actionType: 'share' | 'bookmark') => {
    const currentUser = auth.currentUser;
    if (!currentUser) return;

    for (const targetId of participantIds) {
      if (targetId === currentUser.uid) continue; 
      try {
        await addDoc(collection(firestore, `users/${targetId}/notifications`), {
          type: actionType,
          senderId: currentUser.uid,
          senderName: currentUser.displayName || 'Someone',
          senderAvatar: currentUser.photoURL || `https://ui-avatars.com/api/?name=${currentUser.displayName}`,
          battleId,
          title: actionType === 'share' ? 'Battle Shared! 🚀' : 'Battle Bookmarked! 📌',
          body: `${currentUser.displayName || 'Someone'} ${actionType === 'share' ? 'shared' : 'bookmarked'} your battle in ${contestName}.`,
          createdAt: serverTimestamp(),
          read: false
        });
      } catch (e) { console.error(e); }
    }
  },

  // Real-time subscription to notifications
  subscribeToNotifications: (userId: string, callback: (data: any[]) => void) => {
    const q = query(
      collection(firestore, `users/${userId}/notifications`),
      orderBy('createdAt', 'desc'),
      limit(50)
    );
    return onSnapshot(q, (snapshot) => {
      const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      callback(data);
    });
  }
};
