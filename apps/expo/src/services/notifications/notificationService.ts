import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { firestore as db } from '../firebase/initFirebase';
import { 
    collection, doc, updateDoc, arrayUnion, 
    query, orderBy, limit, onSnapshot, 
    where, writeBatch, Timestamp, Unsubscribe,
    addDoc, serverTimestamp 
} from 'firebase/firestore';
import { getApp } from 'firebase/app';

// Configure notifications handler
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data;
    const isCall = data?.type === 'call';
    
    return {
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      priority: isCall ? Notifications.AndroidNotificationPriority.MAX : Notifications.AndroidNotificationPriority.DEFAULT,
    };
  },
});

/**
 * Register Call Categories for Interactive Notifications
 * Works on iOS and Android to show Accept/Decline buttons.
 * Note: Web does not support interactive notification buttons.
 */
export async function registerNotificationCategories() {
    if (Platform.OS === 'web') return;

    await Notifications.setNotificationCategoryAsync('incoming_call', [
        {
            identifier: 'ACCEPT_CALL',
            buttonTitle: 'Accept ✅',
            options: { opensAppToForeground: true },
        },
        {
            identifier: 'DECLINE_CALL',
            buttonTitle: 'Decline ❌',
            options: { opensAppToForeground: false, isDestructive: true },
        },
    ]);
}

export interface NotificationItem {
    id: string;
    title: string;
    body: string;
    type: "like" | "comment" | "follow" | "contest" | "admin" | "message" | "call" | "profile_visit";
    read: boolean;
    targetId?: string;
    image?: string;
    createdAt: Timestamp;
}

class NotificationService {
    
    async registerForPushNotificationsAsync(userId: string) {
        if (!userId) return;

        let token;
        
        if (Platform.OS === 'android') {
            await Notifications.setNotificationChannelAsync('default', {
                name: 'Default',
                importance: Notifications.AndroidImportance.MAX,
                vibrationPattern: [0, 250, 250, 250],
                lightColor: '#FF231F7C',
            });

            await Notifications.setNotificationChannelAsync('calls', {
                name: 'Calls',
                importance: Notifications.AndroidImportance.MAX,
                vibrationPattern: [0, 500, 500, 500],
                lightColor: '#FF4D67',
                sound: 'default', 
                enableVibration: true,
                lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
            });
        }

        // Always try to register categories on native platforms
        await registerNotificationCategories();

        if (Platform.OS === 'web') {
            try {
                const { getMessaging, getToken } = await import('firebase/messaging');
                const messaging = getMessaging(getApp());
                token = await getToken(messaging, { 
                    vapidKey: process.env.EXPO_PUBLIC_VAPID_KEY || ""
                });
            } catch (e) { console.log("Web Push Error:", e); }
        } else {
            const { status: existingStatus } = await Notifications.getPermissionsAsync();
            let finalStatus = existingStatus;
            
            if (existingStatus !== 'granted') {
                const { status } = await Notifications.requestPermissionsAsync();
                finalStatus = status;
            }
            
            if (finalStatus !== 'granted') return;

            try {
                const tokenData = await Notifications.getDevicePushTokenAsync();
                token = tokenData.data;
            } catch (e) { console.log("Error getting device token:", e); }
        }

        if (token) {
            await this.saveTokenToDatabase(userId, token);
        }
    }

    async saveTokenToDatabase(userId: string, token: string) {
        const userRef = doc(db, "users", userId);
        await updateDoc(userRef, {
            fcmTokens: arrayUnion(token)
        });
    }

    async notifyProfileVisit(targetUserId: string) {
        try {
            const { auth } = await import('../firebase/initFirebase');
            const currentUser = auth.currentUser;
            if (!currentUser || currentUser.uid === targetUserId) return;

            const notificationsRef = collection(db, "notifications", targetUserId, "items");
            await addDoc(notificationsRef, {
                title: "Profile Visited",
                body: `${currentUser.displayName || 'Someone'} viewed your profile`,
                type: "profile_visit",
                read: false,
                targetId: currentUser.uid,
                createdAt: serverTimestamp()
            });
        } catch (error) {
            console.error("Error notifying profile visit:", error);
        }
    }

    subscribeToUnreadCount(userId: string, callback: (count: number) => void): Unsubscribe {
        const q = query(
            collection(db, "notifications", userId, "items"),
            where("read", "==", false)
        );
        return onSnapshot(q, (snapshot) => {
            callback(snapshot.size);
        });
    }

    subscribeToNotifications(userId: string, limitCount: number = 50, callback: (items: NotificationItem[]) => void): Unsubscribe {
        const q = query(
            collection(db, "notifications", userId, "items"),
            orderBy("createdAt", "desc"),
            limit(limitCount)
        );

        return onSnapshot(q, (snapshot) => {
            const items = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            } as NotificationItem));
            callback(items);
        });
    }

    async markAsRead(userId: string, notificationIds: string[]) {
        if (notificationIds.length === 0) return;
        const batch = writeBatch(db);
        notificationIds.forEach(id => {
            const ref = doc(db, "notifications", userId, "items", id);
            batch.update(ref, { read: true });
        });
        await batch.commit();
    }
}

export const notificationService = new NotificationService();
