import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  RefreshControl,
  Text,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppImage as Image } from '@/src/components/ui/AppImage';
import { Stack, useRouter } from 'expo-router';
import { useAuth } from '@/src/hooks/useAuth';
import { notificationService, NotificationItem } from '@/src/services/notifications/notificationService';
import { getNotificationDestination, getNotificationTag } from '@/src/services/notifications/notificationMeta';
import { Colors } from '@/constants/theme';
import { NotificationSkeleton } from '@/src/components/notifications/NotificationSkeleton';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

const HEAD_LIMIT = 30; // latest page kept fresh by the live socket
const PAGE_SIZE = 20; // older pages pulled in during infinite scroll
const FALLBACK_AVATAR = require('@/assets/images/icon.png');

/** Merge the realtime HEAD with the paginated TAIL, dedupe by id (head wins for
 *  freshness), and sort newest-first. */
function mergeNotifications(head: NotificationItem[], tail: NotificationItem[]): NotificationItem[] {
    const byId = new Map<string, NotificationItem>();
    for (const n of tail) byId.set(n.id, n);
    for (const n of head) byId.set(n.id, n); // head overrides tail (read state etc.)
    return Array.from(byId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// --- Row (memoized so unrelated state changes don't re-render every row) -----
type RowProps = {
    item: NotificationItem;
    isDark: boolean;
    onPress: (item: NotificationItem) => void;
};

const NotificationRow = React.memo(({ item, isDark, onPress }: RowProps) => {
    const bg = isDark ? Colors.dark.background : Colors.light.background;
    const unreadBg = isDark ? '#16202B' : '#EAF2FF';
    const textColor = isDark ? '#FFFFFF' : '#101014';
    const subTextColor = isDark ? '#9BA1A6' : '#6B7280';

    const tag = getNotificationTag(item.type);
    const showThumb = item.type !== 'follow' && item.type !== 'admin' && !!(item.imageThumb || item.image);
    // Prefer the most recent ACTOR's avatar on grouped notifications — for
    // "Asha and 4 others liked your post" the useful face is Asha's, not the
    // post thumbnail. Falls back to the notification image for ungrouped types.
    const actorAvatar = item.actors?.[0]?.avatarUrl || null;
    const avatarUri = actorAvatar || item.imageThumb || item.image;
    // Only surface a count once it actually means "more than one person".
    const groupCount = (item.actorCount ?? 1) > 1 ? item.actorCount! : 0;

    return (
        <TouchableOpacity
            activeOpacity={0.6}
            onPress={() => onPress(item)}
            // Highlight = not yet SEEN, i.e. new since the list was last
            // opened. `read` means the user actually tapped through, which is a
            // different thing and would leave rows highlighted forever.
            style={[styles.itemContainer, { backgroundColor: item.seen ? bg : unreadBg }]}
        >
            <View style={styles.avatarContainer}>
                <Image
                    source={avatarUri ? { uri: avatarUri } : FALLBACK_AVATAR}
                    style={styles.avatar}
                    contentFit="cover"
                    transition={150}
                />
                <View style={[styles.badge, { backgroundColor: tag.color }]}>
                    <Ionicons name={tag.icon} size={11} color="#FFFFFF" />
                </View>
                {groupCount > 1 && (
                    <View style={styles.groupCount}>
                        <Text style={styles.groupCountText}>
                            {groupCount > 9 ? '9+' : groupCount}
                        </Text>
                    </View>
                )}
            </View>

            <View style={styles.textContainer}>
                <View style={styles.tagRow}>
                    <View style={[styles.tagPill, { backgroundColor: tag.color + (isDark ? '33' : '22') }]}>
                        <Text style={[styles.tagText, { color: tag.color }]}>{tag.label}</Text>
                    </View>
                    {!item.seen && <View style={styles.unreadDot} />}
                </View>

                <Text style={[styles.bodyText, { color: textColor }]} numberOfLines={2}>
                    {item.title ? <Text style={styles.titleBold}>{item.title} </Text> : null}
                    {item.body}
                </Text>
                <Text style={[styles.timeText, { color: subTextColor }]}>
                    {item.createdAt ? dayjs(item.createdAt).fromNow() : 'Just now'}
                </Text>
            </View>

            {showThumb && (
                <Image
                    source={{ uri: item.imageThumb || item.image }}
                    style={styles.postThumb}
                    contentFit="cover"
                    transition={150}
                />
            )}
        </TouchableOpacity>
    );
});
NotificationRow.displayName = 'NotificationRow';

export default function NotificationsScreen() {
    const { user } = useAuth();
    const router = useRouter();
    const colorScheme = useColorScheme();
    const isDark = colorScheme === 'dark';

    const bg = isDark ? Colors.dark.background : Colors.light.background;
    const textColor = isDark ? '#FFFFFF' : '#101014';
    const subTextColor = isDark ? '#9BA1A6' : '#6B7280';
    const borderColor = isDark ? '#23262D' : '#EEF0F4';

    // Realtime HEAD (latest page) + paginated TAIL (older pages).
    const [head, setHead] = useState<NotificationItem[]>([]);
    const [tail, setTail] = useState<NotificationItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [reachedEnd, setReachedEnd] = useState(false);

    // Refs to read latest values inside callbacks without re-subscribing.
    const loadingMoreRef = useRef(false);
    const reachedEndRef = useRef(false);
    const markedRef = useRef(false);

    const notifications = useMemo(() => mergeNotifications(head, tail), [head, tail]);

    // Subscribe to the live head (WebSocket + safety-net poll).
    useEffect(() => {
        if (!user?.uid) return;
        const unsubscribe = notificationService.subscribeToNotifications(user.uid, HEAD_LIMIT, (items) => {
            setHead(items);
            setLoading(false);
            setRefreshing(false);

            // Mark everything SEEN once, the first time the screen has data.
            // This is what clears the bell badge. `read` is left alone — it is
            // set per row on tap, so it stays a real signal of engagement.
            if (!markedRef.current && items.some((n) => !n.seen)) {
                markedRef.current = true;
                notificationService.markAllAsSeen();
                // The OS tray holds the same information the user is now
                // looking at, so clear it rather than leaving a stack of alerts.
                void notificationService.clearDeliveredNotifications();
                // Reflect locally so the highlight clears immediately.
                setHead((prev) => prev.map((n) => ({ ...n, seen: true })));
                setTail((prev) => prev.map((n) => ({ ...n, seen: true })));
            }
        });
        return () => unsubscribe();
    }, [user?.uid]);

    /**
     * Pull-to-refresh.
     *
     * This was a 700ms setTimeout that spun and did nothing. The live socket does
     * keep the head current, but a user pulls precisely BECAUSE they suspect it
     * is stale — so fetch the newest page for real, and reset pagination so the
     * tail cannot end up overlapping a changed head.
     */
    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            const { items } = await notificationService.fetchNotificationsPage(undefined, HEAD_LIMIT);
            setHead(items);
            setTail([]);
            setReachedEnd(false);
            reachedEndRef.current = false;
        } catch (e) {
            reportError(e, { screen: 'notifications', action: 'refresh' });
            emitToast('Could not refresh notifications.', 'error');
        } finally {
            setRefreshing(false);
        }
    }, []);

    const loadMore = useCallback(async () => {
        if (loadingMoreRef.current || reachedEndRef.current) return;
        // Nothing loaded yet, or list shorter than one head page → no tail to load.
        const oldest = notifications[notifications.length - 1];
        if (!oldest) return;

        loadingMoreRef.current = true;
        setLoadingMore(true);
        try {
            const { items, nextCursor } = await notificationService.fetchNotificationsPage(oldest.createdAt, PAGE_SIZE);
            if (items.length > 0) {
                setTail((prev) => mergeNotifications([], [...prev, ...items]));
            }
            if (!nextCursor || items.length === 0) {
                reachedEndRef.current = true;
                setReachedEnd(true);
            }
        } catch {
            /* transient — user can scroll again to retry */
        } finally {
            loadingMoreRef.current = false;
            setLoadingMore(false);
        }
    }, [notifications]);

    const handlePress = useCallback((item: NotificationItem) => {
        if (!item.read) {
            setHead((prev) => prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)));
            setTail((prev) => prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)));
            if (user?.uid) notificationService.markAsRead(user.uid, [item.id]);
        }
        const dest = getNotificationDestination(item.type, item.targetId, item.data?.url);
        if (dest) {
            try {
                router.push(dest as any);
            } catch (e) {
                console.error('Notification navigation failed', e);
            }
        }
    }, [router, user?.uid]);

    const renderItem = useCallback(
        ({ item }: { item: NotificationItem }) => (
            <NotificationRow item={item} isDark={isDark} onPress={handlePress} />
        ),
        [isDark, handlePress],
    );

    const keyExtractor = useCallback((item: NotificationItem) => item.id, []);

    return (
        <SafeAreaView style={[styles.container, { backgroundColor: bg }]} edges={['top', 'left', 'right']}>
            {/* Navigator header stays off app-wide; this screen draws its own. */}
            <Stack.Screen options={{ headerShown: false }} />

            <View style={[styles.header, { borderBottomColor: borderColor }]}>
                <BackButton size={24} color={textColor} style={styles.backBtn} />
                <Text style={[styles.headerTitle, { color: textColor }]}>Notification</Text>
            </View>

            {loading && notifications.length === 0 ? (
                <NotificationSkeleton count={8} />
            ) : (
                <FlatList
                    data={notifications}
                    keyExtractor={keyExtractor}
                    renderItem={renderItem}
                    refreshControl={
                        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={textColor} />
                    }
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <View style={[styles.emptyIcon, { backgroundColor: isDark ? '#1C1C1E' : '#F2F2F7' }]}>
                                <Ionicons name="notifications-outline" size={30} color={subTextColor} />
                            </View>
                            <Text style={[styles.emptyText, { color: subTextColor }]}>No notifications yet</Text>
                            <Text style={[styles.emptySub, { color: subTextColor }]}>
                                Likes, comments, follows and contest results will show up here.
                            </Text>
                        </View>
                    }
                    ListFooterComponent={
                        loadingMore ? (
                            <View style={styles.footer}>
                                <ActivityIndicator size="small" color={subTextColor} />
                            </View>
                        ) : reachedEnd && notifications.length > 0 ? (
                            <Text style={[styles.footerText, { color: subTextColor }]}>You&apos;re all caught up</Text>
                        ) : null
                    }
                    contentContainerStyle={styles.listContent}
                    showsVerticalScrollIndicator={false}
                    // Infinite scroll
                    onEndReached={loadMore}
                    onEndReachedThreshold={0.4}
                    // Production perf: virtualize aggressively, drop offscreen rows.
                    initialNumToRender={12}
                    maxToRenderPerBatch={10}
                    windowSize={9}
                    removeClippedSubviews
                    updateCellsBatchingPeriod={50}
                />
            )}
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    backBtn: {
        marginRight: 2,
    },
    headerTitle: {
        fontSize: 20,
        fontFamily: 'Urbanist-Bold',
    },
    listContent: {
        paddingTop: 10,
        paddingBottom: 24,
    },
    itemContainer: {
        flexDirection: 'row',
        paddingVertical: 12,
        paddingHorizontal: 16,
        alignItems: 'center',
    },
    groupCount: {
        position: 'absolute',
        top: -2,
        left: -2,
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        paddingHorizontal: 4,
        backgroundColor: '#FF4D67',
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: '#FFFFFF',
    },
    groupCountText: {
        color: '#FFFFFF',
        fontSize: 9,
        fontFamily: 'Urbanist-Bold',
    },
    avatarContainer: {
        marginRight: 12,
    },
    avatar: {
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: '#eee',
    },
    badge: {
        position: 'absolute',
        right: -2,
        bottom: -2,
        width: 20,
        height: 20,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 2,
        borderColor: '#FFFFFF',
    },
    textContainer: {
        flex: 1,
        marginRight: 8,
    },
    tagRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    tagPill: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 6,
    },
    tagText: {
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 0.3,
        textTransform: 'uppercase',
    },
    unreadDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        marginLeft: 8,
        backgroundColor: '#3B82F6',
    },
    bodyText: {
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '400',
    },
    titleBold: {
        fontWeight: '700',
    },
    timeText: {
        fontSize: 12,
        marginTop: 3,
    },
    postThumb: {
        width: 48,
        height: 48,
        borderRadius: 6,
        backgroundColor: '#eee',
    },
    emptyContainer: {
        paddingTop: 100,
        paddingHorizontal: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyIcon: {
        width: 64,
        height: 64,
        borderRadius: 32,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 16,
    },
    emptyText: {
        fontSize: 16,
        fontWeight: '600',
    },
    emptySub: {
        fontSize: 13,
        textAlign: 'center',
        marginTop: 6,
        lineHeight: 18,
    },
    footer: {
        paddingVertical: 20,
        alignItems: 'center',
    },
    footerText: {
        textAlign: 'center',
        paddingVertical: 20,
        fontSize: 12,
    },
});
