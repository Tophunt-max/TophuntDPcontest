import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, StyleSheet, RefreshControl, Text, useColorScheme } from 'react-native';
import { Image } from 'expo-image';
import { Stack } from 'expo-router';
import { useAuth } from '@/src/hooks/useAuth';
import { notificationService, NotificationItem } from '@/src/services/notifications/notificationService';
import { Colors } from '@/constants/theme';
import { NotificationSkeleton } from '@/src/components/notifications/NotificationSkeleton';
import { getOptimizedMediaUrl } from '@/src/utils/media';
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

        const unsubscribe = notificationService.subscribeToNotifications(user.uid, 50, (items) => {
            setNotifications(items);
            setLoading(false);
            setRefreshing(false);
            
            // Mark unread as read
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
        setTimeout(() => setRefreshing(false), 1000);
    };

    const renderItem = ({ item }: { item: NotificationItem }) => {
        const isRead = item.read;
        const backgroundColor = isRead 
            ? (isDark ? Colors.dark.background : Colors.light.background)
            : (isDark ? '#2A2A2A' : '#F0F5FF');

        const imageUri = getOptimizedMediaUrl(item.image || '');

        return (
            <View style={[styles.itemContainer, { backgroundColor }]}>
                <View style={styles.avatarContainer}>
                    <Image 
                        source={item.image ? { uri: imageUri } : require('@/assets/images/icon.png')} 
                        style={styles.avatar} 
                        contentFit="cover"
                        cachePolicy="memory-disk"
                        transition={200}
                    />
                </View>
                <View style={styles.textContainer}>
                    <Text style={[styles.bodyText, { color: isDark ? '#fff' : '#000' }]}>
                        {item.title} {item.body}
                    </Text>
                    <Text style={styles.timeText}>
                        {item.createdAt ? dayjs(item.createdAt.toDate()).fromNow() : 'Just now'}
                    </Text>
                </View>
                {item.type !== 'follow' && item.type !== 'admin' && item.image && (
                     <Image 
                        source={{ uri: imageUri }} 
                        style={styles.postThumb} 
                        contentFit="cover"
                        cachePolicy="memory-disk"
                     />
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
                    {[1,2,3,4,5,6,7,8].map(i => <NotificationSkeleton key={i} isDark={isDark} />)}
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
