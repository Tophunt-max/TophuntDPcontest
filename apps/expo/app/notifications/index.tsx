import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, StyleSheet, RefreshControl, Text, Image, useColorScheme, TouchableOpacity } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useAuth } from '@/src/hooks/useAuth';
import { notificationService, NotificationItem } from '@/src/services/notifications/notificationService';
import { getNotificationDestination, getNotificationTag } from '@/src/services/notifications/notificationMeta';
import { Colors } from '@/constants/theme';
import { NotificationSkeleton } from '@/src/components/notifications/NotificationSkeleton';
import { Ionicons } from '@/src/lib/icons';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

export default function NotificationsScreen() {
    const { user } = useAuth();
    const router = useRouter();
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const colorScheme = useColorScheme();
    const isDark = colorScheme === 'dark';

    const bg = isDark ? Colors.dark.background : Colors.light.background;
    const textColor = isDark ? '#FFFFFF' : '#101014';
    const subTextColor = isDark ? '#9BA1A6' : '#6B7280';
    const unreadBg = isDark ? '#16202B' : '#EAF2FF';
    const unreadDot = '#3B82F6';

    const loadNotifications = useCallback(() => {
        if (!user?.uid) return;

        // Real-time subscription (WebSocket-first with a safety-net poll). The
        // callback fires on connect and on every incoming notification event.
        const unsubscribe = notificationService.subscribeToNotifications(user.uid, 50, (items) => {
            setNotifications(items);
            setLoading(false);
            setRefreshing(false);

            // Opening the screen marks everything currently unread as read.
            const unreadIds = items.filter((n) => !n.read).map((n) => n.id);
            if (unreadIds.length > 0) {
                notificationService.markAsRead(user.uid, unreadIds);
            }
        });

        return unsubscribe;
    }, [user?.uid]);

    useEffect(() => {
        let unsubscribe: any;
        if (user?.uid) {
            unsubscribe = loadNotifications();
        }
        return () => {
            if (unsubscribe) unsubscribe();
        };
    }, [loadNotifications, user?.uid]);

    const onRefresh = () => {
        // The live socket auto-updates; a brief spinner acknowledges the pull.
        setRefreshing(true);
        setTimeout(() => setRefreshing(false), 800);
    };

    const handlePress = (item: NotificationItem) => {
        // Optimistically clear the unread highlight on tap.
        if (!item.read) {
            setNotifications((prev) => prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)));
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
    };

    const renderItem = ({ item }: { item: NotificationItem }) => {
        const isRead = item.read;
        const tag = getNotificationTag(item.type);
        const showThumb = item.type !== 'follow' && item.type !== 'admin' && !!item.image;

        return (
            <TouchableOpacity
                activeOpacity={0.6}
                onPress={() => handlePress(item)}
                style={[styles.itemContainer, { backgroundColor: isRead ? bg : unreadBg }]}
            >
                <View style={styles.avatarContainer}>
                    <Image
                        source={item.image ? { uri: item.image } : require('@/assets/images/icon.png')}
                        style={styles.avatar}
                        resizeMode="cover"
                    />
                    {/* Type icon badge on the avatar corner */}
                    <View style={[styles.badge, { backgroundColor: tag.color }]}>
                        <Ionicons name={tag.icon} size={11} color="#FFFFFF" />
                    </View>
                </View>

                <View style={styles.textContainer}>
                    {/* Tag pill */}
                    <View style={styles.tagRow}>
                        <View style={[styles.tagPill, { backgroundColor: tag.color + (isDark ? '33' : '22') }]}>
                            <Text style={[styles.tagText, { color: tag.color }]}>{tag.label}</Text>
                        </View>
                        {!isRead && <View style={[styles.unreadDot, { backgroundColor: unreadDot }]} />}
                    </View>

                    <Text style={[styles.bodyText, { color: textColor }]} numberOfLines={3}>
                        {item.title ? <Text style={styles.titleBold}>{item.title} </Text> : null}
                        {item.body}
                    </Text>
                    <Text style={[styles.timeText, { color: subTextColor }]}>
                        {item.createdAt ? dayjs(item.createdAt).fromNow() : 'Just now'}
                    </Text>
                </View>

                {showThumb && <Image source={{ uri: item.image }} style={styles.postThumb} />}
            </TouchableOpacity>
        );
    };

    return (
        <View style={[styles.container, { backgroundColor: bg }]}>
            <Stack.Screen
                options={{
                    title: 'Notifications',
                    headerShadowVisible: false,
                    headerStyle: { backgroundColor: bg },
                    headerTintColor: textColor,
                }}
            />

            {loading && notifications.length === 0 ? (
                <NotificationSkeleton count={8} />
            ) : (
                <FlatList
                    data={notifications}
                    keyExtractor={(item) => item.id}
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
                    contentContainerStyle={styles.listContent}
                    showsVerticalScrollIndicator={false}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    // Top gap so the first row doesn't butt against the header.
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
});
