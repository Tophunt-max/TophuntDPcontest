import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp } from 'firebase/app';
import { callApi, readApi, readApiWithCursor } from '../api';
import { live } from '../realtime';
import { ANDROID_CHANNEL_ID, type NotificationType } from './notificationMeta';

/**
 * Mirror of the worker's `NotificationPrefs` (lib/notificationPrefs.ts).
 *
 * Note these gate PUSH only — the in-app notification row is always written, so
 * muting a category never creates a gap in the notifications list.
 */
export interface NotificationPrefs {
  social: boolean;
  contest: boolean;
  wallet: boolean;
  admin: boolean;
  /** Master push switch. */
  push: boolean;
  /** Local hour 0-23 when quiet hours begin (inclusive), or null. */
  quietStart: number | null;
  /** Local hour 0-23 when quiet hours end (exclusive), or null. */
  quietEnd: number | null;
  utcOffsetMinutes: number;
}

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

/** Where this device's push token is cached so logout can detach it. */
const PUSH_TOKEN_KEY = 'push::deviceToken';

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
    /** True once shown in the list; `read` means actually opened. */
    seen?: boolean;
    /** Most recent actor — use their avatar for the row when present. */
    actorId?: string | null;
    /**
     * A few recent actors on a grouped notification. May list fewer than
     * `actorCount` — that field is the authoritative total.
     */
    actors?: { uid: string; username: string | null; avatarUrl: string | null }[] | null;
    /** Distinct actors folded into this row; 1 when ungrouped. */
    actorCount?: number;
    /**
     * For collapsible types this is the LAST ACTIVITY time, not the first — the
     * server bumps it when a new actor is folded in so the notification returns
     * to the top of the list.
     */
    createdAt: number; // epoch ms (was Firestore Timestamp)
}

class NotificationService {

    /**
     * Create one Android channel per notification category.
     *
     * Previously there was a single "default" channel, which made OS-level
     * muting all-or-nothing: a user who wanted to stop like notifications had to
     * silence everything, including payout confirmations. Separate channels let
     * Android's own notification settings mute one category at a time.
     *
     * The ids must match `ANDROID_CHANNEL` in the worker's lib/notify.ts, since
     * the worker stamps `channel_id` onto each FCM message. Importance is tuned
     * per category — money and announcements should not vibrate the same way a
     * like does.
     */
    async configureAndroidChannels(): Promise<void> {
        if (Platform.OS !== 'android') return;
        const { AndroidImportance } = Notifications;
        const channels: {
            id: string;
            name: string;
            importance: number;
            vibrate: boolean;
        }[] = [
            { id: ANDROID_CHANNEL_ID.social, name: 'Likes, comments & follows', importance: AndroidImportance.DEFAULT, vibrate: true },
            { id: ANDROID_CHANNEL_ID.contest, name: 'Contests & battles', importance: AndroidImportance.HIGH, vibrate: true },
            { id: ANDROID_CHANNEL_ID.wallet, name: 'Coins & payouts', importance: AndroidImportance.HIGH, vibrate: true },
            { id: ANDROID_CHANNEL_ID.admin, name: 'Announcements', importance: AndroidImportance.DEFAULT, vibrate: false },
        ];

        try {
            for (const ch of channels) {
                await Notifications.setNotificationChannelAsync(ch.id, {
                    name: ch.name,
                    importance: ch.importance,
                    vibrationPattern: ch.vibrate ? [0, 250, 250, 250] : undefined,
                    lightColor: '#FF4D67',
                });
            }
            // Keep a 'default' channel so any message sent WITHOUT a channel_id
            // (older Worker builds, or a type we forgot to map) still lands
            // somewhere instead of being dropped by Android.
            await Notifications.setNotificationChannelAsync('default', {
                name: 'Other',
                importance: AndroidImportance.DEFAULT,
                vibrationPattern: [0, 250, 250, 250],
                lightColor: '#FF4D67',
            });
        } catch (e) {
            console.warn('[notifications] channel setup failed:', e);
        }
    }

    /** Current notification preferences, fully resolved by the server. */
    async getPreferences(): Promise<NotificationPrefs> {
        const res = (await callApi('getNotificationPrefs', {})) as { prefs: NotificationPrefs };
        return res.prefs;
    }

    /**
     * Patch preferences. Only the keys provided change, so a single toggle does
     * not need to re-send the whole object.
     *
     * Sends the device's real UTC offset alongside any quiet-hours change so the
     * server can resolve "10pm" in the user's own timezone rather than UTC.
     */
    async updatePreferences(patch: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
        const withOffset =
            patch.quietStart !== undefined || patch.quietEnd !== undefined
                ? { ...patch, utcOffsetMinutes: -new Date().getTimezoneOffset() }
                : patch;
        const res = (await callApi('updateNotificationPrefs', { prefs: withOffset })) as {
            prefs: NotificationPrefs;
        };
        return res.prefs;
    }

    // 1. Register for Push Notifications
    async registerForPushNotificationsAsync(userId: string) {
        if (!userId) return;

        let token;

        await this.configureAndroidChannels();

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
        // Remember it locally so sign-out can detach exactly this device's token.
        // Re-deriving it at logout is unreliable: the permission may have been
        // revoked, or the provider may hand back a different token.
        try {
            await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
        } catch {
            /* non-fatal — unregisterPushToken just becomes a no-op */
        }
    }

    /**
     * Detach this device's push token from the signed-in account.
     *
     * MUST run before Firebase sign-out, while the ID token is still valid.
     * Without this the token stays on the user row forever, so a shared or
     * resold phone keeps receiving the previous account's notifications.
     *
     * Best-effort by design: a failure here must never block the user from
     * logging out. `registerFcmToken` also steals the token from any previous
     * owner, which covers the cases this cannot reach (app killed, uninstall).
     */
    async unregisterPushToken(): Promise<void> {
        let token: string | null = null;
        try {
            token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
        } catch {
            return;
        }
        if (!token) return;

        try {
            await callApi('unregisterFcmToken', { token });
        } catch (e) {
            console.warn('[notifications] could not detach push token on logout:', e);
        } finally {
            try {
                await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
            } catch {
                /* ignore */
            }
        }
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
     * Mark everything currently in the list as SEEN. This is what clears the
     * bell badge, and it is what the notifications screen calls on open.
     *
     * Distinct from markAllAsRead: `seen` means "was in the list when you last
     * opened it", `read` means "you tapped through to it". Opening the screen
     * used to mark everything read, which meant `read` told us nothing about
     * what the user had actually engaged with.
     */
    async markAllAsSeen() {
        try { await callApi('markAllNotificationsSeen', {}); } catch { /* best-effort */ }
    }

    /**
     * Push the unseen count onto the OS app-icon badge.
     *
     * The worker sends the correct number with each push, but nothing was
     * clearing it locally — so the badge showed the right value and then never
     * went down. Driving it from the live unseen count keeps the two in step.
     */
    async syncBadgeCount(count: number): Promise<void> {
        if (Platform.OS === 'web') return;
        try {
            await Notifications.setBadgeCountAsync(Math.max(0, count));
        } catch {
            /* badge is cosmetic — never surface a failure */
        }
    }

    /**
     * Clear notifications already delivered to the OS tray.
     *
     * Called when the user opens the in-app list: they are looking at the same
     * information, so leaving a stack of alerts in the shade is just noise.
     */
    async clearDeliveredNotifications(): Promise<void> {
        if (Platform.OS === 'web') return;
        try {
            await Notifications.dismissAllNotificationsAsync();
        } catch {
            /* best-effort */
        }
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
