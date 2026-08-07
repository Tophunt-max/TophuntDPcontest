import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getApp } from 'firebase/app';
import { callApi, readApi } from '../api';
import { live } from '../realtime';

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
    createdAt: number; // epoch ms (was Firestore Timestamp)
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
            if (finalStatus !== 'granted') return;
            try {
                const tokenData = await Notifications.getDevicePushTokenAsync();
                token = tokenData.data;
            } catch (e) {
                console.log("Error getting device token:", e);
            }
        }

        if (token) {
            await this.saveTokenToDatabase(userId, token);
        }
    }

    // FCM token registration -> Worker (was updateDoc arrayUnion on users/{uid})
    async saveTokenToDatabase(_userId: string, token: string) {
        await callApi('registerFcmToken', { token });
    }

    // 2. Real-time unread count — instant via the user's WebSocket channel.
    subscribeToUnreadCount(userId: string, callback: (count: number) => void): () => void {
        return live(
            `user:${userId}`,
            () => readApi('/read/notifications/unread-count'),
            (res: any) => callback(res?.count ?? 0),
            { filter: (e) => e.type === 'notification' },
        );
    }

    // 3. Notifications list — instant via the user's WebSocket channel.
    subscribeToNotifications(userId: string, limitCount: number = 50, callback: (items: NotificationItem[]) => void): () => void {
        return live(
            `user:${userId}`,
            () => readApi('/read/notifications', { limit: limitCount }),
            (items: NotificationItem[]) => callback(items || []),
            { filter: (e) => e.type === 'notification' },
        );
    }

    // 4. Mark as read -> Worker (was Firestore writeBatch)
    async markAsRead(_userId: string, notificationIds: string[]) {
        if (!notificationIds.length) return;
        await callApi('markNotificationsRead', { notificationIds });
    }
}

export const notificationService = new NotificationService();
