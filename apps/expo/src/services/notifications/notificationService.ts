import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getApp } from 'firebase/app';
import { callApi, readApi, readApiWithCursor } from '../api';
import { live } from '../realtime';
import type { NotificationType } from './notificationMeta';

// Configure notifications handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    // Required by newer expo-notifications NotificationBehavior.
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export interface NotificationItem {
    id: string;
    title: string;
    body: string;
    /** Real backend type strings (follow, match_like, contest-win, purchase, admin, ...). */
    type: NotificationType;
    read: boolean;
    targetId?: string;
    image?: string;
    /** 128px server-side variant of `image` (smaller R2/CDN bytes for the row). */
    imageThumb?: string;
    /** Optional payload; `data.url` is an admin deep-link that wins over type routing. */
    data?: { url?: string; [k: string]: any } | null;
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
    /** Record that the current user viewed another user's profile (best-effort). */
    async notifyProfileVisit(targetId: string) {
        try { await callApi('profileVisit', { targetId }); } catch { /* best-effort */ }
    }

    async markAsRead(_userId: string, notificationIds: string[]) {
        if (!notificationIds.length) return;
        await callApi('markNotificationsRead', { notificationIds });
    }

    /**
     * Mark ALL unread notifications read in one server-side write. Preferred on
     * screen-open over markAsRead(ids): no id array on the wire, one indexed
     * UPDATE. Best-effort — a failure just leaves them unread for next time.
     */
    async markAllAsRead() {
        try { await callApi('markAllNotificationsRead', {}); } catch { /* best-effort */ }
    }

    /**
     * Fetch ONE older page for infinite scroll. Cursor is the `createdAt` of the
     * oldest row already shown; omit for the first page. Returns the items plus
     * the next cursor (null = no more). This is a plain paginated GET — the live
     * socket keeps the HEAD of the list fresh; this only loads the TAIL.
     */
    async fetchNotificationsPage(
        cursor?: number | string | null,
        limit: number = 20,
    ): Promise<{ items: NotificationItem[]; nextCursor: string | null }> {
        const { data, nextCursor } = await readApiWithCursor<NotificationItem[]>(
            '/read/notifications',
            { limit, cursor: cursor ?? undefined },
        );
        return { items: data || [], nextCursor };
    }
}

export const notificationService = new NotificationService();
