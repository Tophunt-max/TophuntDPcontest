import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, StyleSheet, RefreshControl, Text, Image, useColorScheme } from 'react-native';
import { Stack } from 'expo-router';
import { useAuth } from '@/src/hooks/useAuth';
import { notificationService, NotificationItem } from '@/src/services/notifications/notificationService';
import { Colors } from '@/constants/theme';
import { NotificationSkeleton } from '@/src/components/notifications/NotificationSkeleton';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

export default function NotificationsScreen() {
    const { user } = useAuth();
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const colorScheme = useColorScheme();
    const isDark = colorScheme === 'dark';

    const loadNotifications = useCallback(() => {
        if (!user?.uid) return;

        // No need to set loading true here if it's already loaded once, 
        // to avoid flickering on refresh.
        const unsubscribe = notificationService.subscribeToNotifications(user.uid, 50, (items) => {
            setNotifications(items);
            setLoading(false);
            setRefreshing(false);
            
            // Mark unread as read (Requirement: Mark when screen opens)
            const unreadIds = items.filter(n => !n.read).map(n => n.id);
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
        setRefreshing(true);
        // The listener is already active, so we just simulate refresh 
        // or re-trigger if needed. But with onSnapshot, it's auto-updating.
        // We can just timeout to stop spinner.
        setTimeout(() => setRefreshing(false), 1000);
    };

    const renderItem = ({ item }: { item: NotificationItem }) => {
        const isRead = item.read;
        const backgroundColor = isRead 
            ? (isDark ? Colors.dark.background : Colors.light.background)
            : (isDark ? '#2A2A2A' : '#E8F1FF');

        return (
            <View style={[styles.itemContainer, { backgroundColor }]}>
                <View style={styles.avatarContainer}>
                    <Image 
                        source={item.image ? { uri: item.image } : require('@/assets/images/icon.png')} 
                        style={styles.avatar} 
                        resizeMode="cover"
                    />
                </View>
                <View style={styles.textContainer}>
                    <Text style={[styles.bodyText, { color: isDark ? '#fff' : '#000' }]}>
                        {item.title} {item.body}
                    </Text>
                    <Text style={styles.timeText}>
                        {item.createdAt ? dayjs((item.createdAt as any)?.toDate ? (item.createdAt as any).toDate() : item.createdAt).fromNow() : 'Just now'}
                    </Text>
                </View>
                {item.type !== 'follow' && item.type !== 'admin' && item.image && (
                     <Image source={{ uri: item.image }} style={styles.postThumb} />
                )}
            </View>
        );
    };

    return (
        <View style={[styles.container, { backgroundColor: isDark ? Colors.dark.background : Colors.light.background }]}>
            <Stack.Screen 
                options={{ 
                    title: 'Notifications', 
                    headerShadowVisible: false,
                    headerStyle: { backgroundColor: isDark ? Colors.dark.background : Colors.light.background },
                    headerTintColor: isDark ? '#fff' : '#000',
                }} 
            />
            
            {loading && notifications.length === 0 ? (
                <View style={{ padding: 0 }}>
                    <NotificationSkeleton isDark={isDark} /> 
                    <NotificationSkeleton isDark={isDark} />
                    <NotificationSkeleton isDark={isDark} />
                    <NotificationSkeleton isDark={isDark} />
                    <NotificationSkeleton isDark={isDark} />
                    <NotificationSkeleton isDark={isDark} />
                    <NotificationSkeleton isDark={isDark} />
                    <NotificationSkeleton isDark={isDark} />
                </View>
            ) : (
                <FlatList
                    data={notifications}
                    keyExtractor={(item) => item.id}
                    renderItem={renderItem}
                    refreshControl={
                        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={isDark ? "#fff" : "#000"} />
                    }
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Text style={[styles.emptyText, { color: isDark ? '#888' : '#666' }]}>No notifications yet</Text>
                        </View>
                    }
                    contentContainerStyle={{ paddingBottom: 20 }}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    itemContainer: {
        flexDirection: 'row',
        padding: 14,
        alignItems: 'center',
        // borderBottomWidth: StyleSheet.hairlineWidth,
        // borderBottomColor: '#333',
    },
    avatarContainer: {
        marginRight: 12,
    },
    avatar: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: '#eee'
    },
    textContainer: {
        flex: 1,
        marginRight: 8,
    },
    bodyText: {
        fontSize: 14,
        lineHeight: 20,
        fontWeight: '400',
    },
    timeText: {
        fontSize: 12,
        color: 'gray',
        marginTop: 2,
    },
    postThumb: {
        width: 44,
        height: 44,
        borderRadius: 4,
        backgroundColor: '#eee'
    },
    emptyContainer: {
        padding: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        fontSize: 16,
    }
});
