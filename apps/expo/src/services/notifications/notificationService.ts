import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { firestore as db } from '../firebase/initFirebase';
import { 
    collection, doc, updateDoc, arrayUnion, 
    query, orderBy, limit, onSnapshot, 
    where, writeBatch, Timestamp, Unsubscribe 
} from 'firebase/firestore';
import { getApp } from 'firebase/app';
import Constants from 'expo-constants';

// Configure notifications handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export interface NotificationItem {
    id: string;
    title: string;
    body: string;
    type: "like" | "comment" | "follow" | "contest" | "admin";
    read: boolean;
    targetId?: string;
    image?: string;
    createdAt: Timestamp;
}

class NotificationService {
    
    // 1. Register for Push Notifications
    async registerForPushNotificationsAsync(userId: string) {
        if (!userId) return;

        let token;
        
        if (Platform.OS === 'android') {
            await Notifications.setNotificationChannelAsync('default', {
                name: 'default',
                importance: Notifications.AndroidImportance.MAX,
                vibrationPattern: [0, 250, 250, 250],
                lightColor: '#FF231F7C',
            });
        }

        if (Platform.OS === 'web') {
            try {
                // Dynamic import to avoid breaking native bundle
                const { getMessaging, getToken } = await import('firebase/messaging');
                const messaging = getMessaging(getApp());
                
                token = await getToken(messaging, { 
                    vapidKey: process.env.EXPO_PUBLIC_VAPID_KEY || "YOUR_VAPID_KEY_HERE"
                });
            } catch (e) {
                console.log("Web Push Error:", e);
            }
        } else {
            const { status: existingStatus } = await Notifications.getPermissionsAsync();
            let finalStatus = existingStatus;
            
            if (existingStatus !== 'granted') {
                const { status } = await Notifications.requestPermissionsAsync();
                finalStatus = status;
            }
            
            if (finalStatus !== 'granted') {
                return;
            }

            // Get Device Token
            try {
                // For Development (Expo Go), use Expo Push Token (won't work with Firebase Admin direct FCM send without config)
                // For Production (Native Build), use Device Push Token (FCM for Android, APNs for iOS)
                
                // NOTE: Your backend (apps/functions/src/notifications/sender.ts) uses admin.messaging().sendEachForMulticast()
                // This expects valid FCM tokens (or APNs tokens if configured in Firebase Console).
                
                // Using getDevicePushTokenAsync gets the native token.
                // For Android, this is the FCM token directly if google-services.json is set up correctly in EAS.
                // For iOS, this is the APNs token. Firebase Admin can send to APNs token IF it is configured in Firebase Console.
                
                const tokenData = await Notifications.getDevicePushTokenAsync();
                token = tokenData.data;
                console.log("Device Push Token:", token);
            } catch (e) {
                console.log("Error getting device token:", e);
            }
        }

        if (token) {
            await this.saveTokenToDatabase(userId, token);
        }
    }

    async saveTokenToDatabase(userId: string, token: string) {
        const userRef = doc(db, "users", userId);
        // Using arrayUnion to avoid duplicates
        await updateDoc(userRef, {
            fcmTokens: arrayUnion(token)
        });
    }

    // 2. Real-time Unread Count
    subscribeToUnreadCount(userId: string, callback: (count: number) => void): Unsubscribe {
        const q = query(
            collection(db, "notifications", userId, "items"),
            where("read", "==", false)
        );

        return onSnapshot(q, (snapshot) => {
            callback(snapshot.size);
        });
    }

    // 3. Fetch Notifications (Real-time List)
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

    // 4. Mark as Read
    async markAsRead(userId: string, notificationIds: string[]) {
        if (notificationIds.length === 0) return;

        // Process in chunks of 500 (Firestore batch limit)
        const chunks = [];
        for (let i = 0; i < notificationIds.length; i += 500) {
            chunks.push(notificationIds.slice(i, i + 500));
        }

        for (const chunk of chunks) {
            const batch = writeBatch(db);
            chunk.forEach(id => {
                const ref = doc(db, "notifications", userId, "items", id);
                batch.update(ref, { read: true });
            });
            await batch.commit();
        }
    }
}

export const notificationService = new NotificationService();
