import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp } from 'firebase/app';
import { callApi, readApi, readApiWithCursor, readApiWithHeaders } from '../api';
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

/**
 * Safety-net poll interval for the two notification subscriptions, in ms.
 *
 * `live()` refetches instantly on every socket event, so this timer only fires
 * when the socket missed an event or is down — it is a backstop, not the delivery
 * mechanism. Its default is 60s (services/realtime.ts), and BOTH the header bell
 * (subscribeToUnreadCount) and the notifications screen (subscribeToNotifications)
 * subscribe to `user:<uid>`, so a foregrounded-but-idle app was paying two authed
 * GETs a minute — `/read/notifications` + `/read/notifications/unread-count`, each
 * of which also costs a D1 auth-row read. On Cloudflare's D1 free tier that idle
 * baseline, multiplied across every active user, is a real fraction of the daily
 * rows-read budget for zero user benefit.
 *
 * 180s matches what PostCard already uses (components/home/PostCard.tsx) and cuts
 * that idle baseline 3x without touching delivery latency: a real notification
 * still arrives instantly over the socket. See D1_R2_LOAD_AUDIT.md §5.
 */
const NOTIFICATION_FALLBACK_MS = 180_000;

/**
 * Shared per-account badge state.
 *
 * The bell (HeartNotificationIcon, on Home) and the open notifications screen
 * both subscribe to the same `user:<uid>` channel with the same filter. They
 * already share ONE WebSocket (realtime.ts multiplexes per channel), but each
 * `notification` event made each of them fetch — two requests, two auth checks,
 * two block/mute lookups for one change. While the list is open, its fetch now
 * asks for the count too (`withUnread=1` → `X-Unread-Count`) and hands it to the
 * bell, which skips its own refresh. Against a Worker that predates the header
 * the bell simply keeps fetching for itself (`headerSupported` stays false).
 *
 * Keyed by uid, so one account's count can never reach another account's bell;
 * the entry is dropped when its last subscriber leaves.
 */
interface BadgeState {
    count: number | null;
    at: number;
    /**
     * Bumped when a mark-all-seen starts and again when it finishes. A list fetch
     * publishes its count only if this did not move while it was in flight, so a
     * response computed before the mark cannot repaint the dot after the 0.
     */
    markEpoch: number;
    markInFlight: number;
    headerSupported: boolean;
    listSubscribers: number;
    listeners: Set<(count: number) => void>;
}
const badgeStates = new Map<string, BadgeState>();
/** A count published by the list within this window satisfies a bell refresh. */
const SHARED_COUNT_MAX_AGE_MS = 15_000;

function badgeState(uid: string): BadgeState {
    let st = badgeStates.get(uid);
    if (!st) {
        st = { count: null, at: 0, markEpoch: 0, markInFlight: 0, headerSupported: false, listSubscribers: 0, listeners: new Set() };
        badgeStates.set(uid, st);
    }
    return st;
}

function releaseBadgeState(uid: string): void {
    const st = badgeStates.get(uid);
    if (st && st.listeners.size === 0 && st.listSubscribers === 0) badgeStates.delete(uid);
}

function publishBadgeCount(uid: string, count: number): void {
    const st = badgeStates.get(uid);
    if (!st) return;
    st.count = count;
    st.at = Date.now();
    for (const fn of st.listeners) fn(count);
}

/** The list is open and is delivering the count: the bell need not fetch. */
function listCarriesCount(st: BadgeState): boolean {
    return st.listSubscribers > 0 && st.headerSupported;
}

/** Test hook. */
export function __resetBadgeStateForTests(): void {
    badgeStates.clear();
}

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
            { id: ANDROID_CHANNEL_ID.wallet, name: 'Diamond, DP coin & payouts', importance: AndroidImportance.HIGH, vibrate: true },
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
            await this.forgetLocalPushToken();
        }
    }

    /**
     * Drop this device's cached token WITHOUT calling the server.
     *
     * For sign-outs where the account is already out of service — a deletion
     * request, or a purge that has already removed the Firebase login. The
     * authenticated detach call cannot succeed then, and letting it fail on a
     * near-expired token makes the API layer announce "Your session expired"
     * over the top of whatever the user was actually doing. The server clears
     * `fcmTokens` on both of those paths anyway, so only the local copy is left
     * to deal with.
     */
    async forgetLocalPushToken(): Promise<void> {
        try {
            await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
        } catch {
            /* ignore */
        }
    }

    // 2. Real-time unread count — instant via the user's WebSocket channel.
    subscribeToUnreadCount(userId: string, callback: (count: number) => void): () => void {
        const st = badgeState(userId);
        st.listeners.add(callback);
        const unsubscribe = live(
            `user:${userId}`,
            async () => {
                // A fresh count from the open list's fetch answers this refresh.
                if (listCarriesCount(st) && st.count != null && Date.now() - st.at < SHARED_COUNT_MAX_AGE_MS) {
                    return { count: st.count, shared: true };
                }
                return readApi('/read/notifications/unread-count');
            },
            (res: any) => {
                // A shared count was already published to the bells that existed
                // then — but THIS one may have subscribed since (e.g. a Header
                // mounting while the list is open), so tell it directly.
                if (res?.shared) callback(Number(res.count ?? 0));
                else publishBadgeCount(userId, Number(res?.count ?? 0));
            },
            {
                filter: (e) => e.type === 'notification',
                fallbackMs: NOTIFICATION_FALLBACK_MS,
                // The list's own refresh for this same event will deliver the count.
                shouldRefresh: () => !listCarriesCount(st),
            },
        );
        return () => {
            st.listeners.delete(callback);
            unsubscribe();
            releaseBadgeState(userId);
        };
    }

    // 3. Notifications list — instant via the user's WebSocket channel.
    //
    // `onError` is forwarded so the screen can distinguish "no data yet" from "the
    // fetch failed". Without it the list callback fired only on success, and the
    // notifications screen cleared its loading flag only inside that callback — so
    // one failed fetch left the skeleton animating with no way out.
    subscribeToNotifications(
        userId: string,
        limitCount: number = 50,
        callback: (items: NotificationItem[]) => void,
        onError?: (reason: 'fetch_failed' | 'backgrounded', error?: unknown) => void,
    ): () => void {
        const st = badgeState(userId);
        st.listSubscribers += 1;
        const unsubscribe = live(
            `user:${userId}`,
            async () => {
                const epoch = st.markEpoch;
                const { data, headers } = await readApiWithHeaders<NotificationItem[]>('/read/notifications', {
                    limit: limitCount,
                    withUnread: 1,
                });
                const raw = headers?.get?.('X-Unread-Count');
                const n = raw == null ? NaN : Number(raw);
                if (Number.isFinite(n)) {
                    st.headerSupported = true;
                    // Skip a count that may predate a mark-all-seen (see markEpoch).
                    if (st.markInFlight === 0 && epoch === st.markEpoch) publishBadgeCount(userId, n);
                }
                return data;
            },
            (items: NotificationItem[]) => callback(items || []),
            { filter: (e) => e.type === 'notification', fallbackMs: NOTIFICATION_FALLBACK_MS, onError },
        );
        return () => {
            st.listSubscribers = Math.max(0, st.listSubscribers - 1);
            unsubscribe();
            releaseBadgeState(userId);
        };
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
        const states = [...badgeStates.values()];
        for (const st of states) {
            st.markEpoch += 1;
            st.markInFlight += 1;
        }
        try {
            await callApi('markAllNotificationsSeen', {});
            // The server count is now 0; tell the bell without another request.
            // (Previously it kept showing the dot until the next event or the
            // 3-minute safety-net poll.)
            for (const uid of badgeStates.keys()) publishBadgeCount(uid, 0);
        } catch { /* best-effort */ } finally {
            for (const st of states) {
                st.markEpoch += 1;
                st.markInFlight = Math.max(0, st.markInFlight - 1);
            }
        }
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
     * Fetch ONE older page for infinite scroll. Cursor is the previous page's
     * `nextCursor` (`<createdAt>_<id>`), or that pair for the oldest row shown;
     * omit for the first page. Returns the items plus
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
