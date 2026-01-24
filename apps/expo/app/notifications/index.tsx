import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, FlatList, StyleSheet, RefreshControl, Text, useColorScheme, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { Stack, useRouter } from 'expo-router';
import { useAuth } from '@/src/hooks/useAuth';
import { notificationService, NotificationItem } from '@/src/services/notifications/notificationService';
import { Colors } from '@/constants/theme';
import { NotificationSkeleton } from '@/src/components/notifications/NotificationSkeleton';
import { getOptimizedMediaUrl } from '@/src/utils/media';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Ionicons } from '@expo/vector-icons';
import { useToggleFollow, useProfile } from '@/src/hooks/useProfileData';

dayjs.extend(relativeTime);

export default function NotificationsScreen() {
    const { user } = useAuth();
    const router = useRouter();
    const [notifications, setNotifications] = useState<NotificationItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const colorScheme = useColorScheme();
    const isDark = colorScheme === 'dark';

    const toggleFollowMutation = useToggleFollow();
    const { data: currentUserProfile } = useProfile(user?.uid || '');

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

    const handleNotificationClick = (item: NotificationItem) => {
        if (!item.targetId) return;

        switch (item.type) {
            case 'follow':
            case 'profile_visit':
                router.push({
                    pathname: '/profile/[id]',
                    params: { id: item.targetId }
                });
                break;
            case 'like':
            case 'comment':
                // Assuming targetId is post ID for these types
                // Navigate to post detail if exists
                break;
            case 'message':
                router.push(`/messages/chat/${item.targetId}`);
                break;
            case 'contest':
                router.push('/contest/joined');
                break;
            default:
                break;
        }
    };

    const groupedNotifications = useMemo(() => {
        const today: NotificationItem[] = [];
        const yesterday: NotificationItem[] = [];
        const lastWeek: NotificationItem[] = [];

        notifications.forEach(item => {
            if (!item.createdAt) {
                today.push(item);
                return;
            }
            const date = dayjs(item.createdAt.toDate());
            const now = dayjs();

            if (now.isSame(date, 'day')) {
                today.push(item);
            } else if (now.subtract(1, 'day').isSame(date, 'day')) {
                yesterday.push(item);
            } else {
                lastWeek.push(item);
            }
        });

        return [
            { title: 'Today', data: today },
            { title: 'Yesterday', data: yesterday },
            { title: 'Last Week', data: lastWeek },
        ].filter(group => group.data.length > 0);
    }, [notifications]);

    const renderNotificationItem = (item: NotificationItem) => {
        const imageUri = getOptimizedMediaUrl(item.image || '');
        const isFollowing = currentUserProfile?.following?.includes(item.targetId || '');

        return (
            <TouchableOpacity 
                key={item.id} 
                style={styles.itemContainer} 
                activeOpacity={0.7}
                onPress={() => handleNotificationClick(item)}
            >
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
                    <Text style={[styles.userName, { color: isDark ? '#fff' : '#000' }]}>
                        {item.title || 'User'}
                    </Text>
                    <Text style={[styles.bodyText, { color: isDark ? '#CCC' : '#666' }]} numberOfLines={2}>
                        {item.body}
                    </Text>
                </View>

                {item.type === 'follow' ? (
                    <TouchableOpacity 
                        style={[
                            styles.followButton, 
                            isFollowing && { backgroundColor: isDark ? '#333' : '#EEE' }
                        ]}
                        onPress={(e) => {
                            e.stopPropagation();
                            if (item.targetId) toggleFollowMutation.mutate(item.targetId);
                        }}
                        disabled={toggleFollowMutation.isPending}
                    >
                        {toggleFollowMutation.isPending && toggleFollowMutation.variables === item.targetId ? (
                            <ActivityIndicator size="small" color={isFollowing ? '#FF4D67' : '#FFF'} />
                        ) : (
                            <Text style={[styles.followButtonText, isFollowing && { color: isDark ? '#FFF' : '#000' }]}>
                                {isFollowing ? 'Following' : 'Follow Back'}
                            </Text>
                        )}
                    </TouchableOpacity>
                ) : item.image ? (
                    <Image 
                        source={{ uri: imageUri }} 
                        style={styles.postThumb} 
                        contentFit="cover"
                        cachePolicy="memory-disk"
                    />
                ) : null}
            </TouchableOpacity>
        );
    };

    return (
        <View style={[styles.container, { backgroundColor: isDark ? Colors.dark.background : Colors.light.background }]}>
            <Stack.Screen 
                options={{ 
                    title: 'Activity', 
                    headerShown: true,
                    headerShadowVisible: false,
                    headerStyle: { backgroundColor: isDark ? Colors.dark.background : Colors.light.background },
                    headerTintColor: isDark ? '#fff' : '#000',
                    headerTitleStyle: {
                        fontFamily: 'Urbanist-Bold',
                        fontSize: 22,
                    },
                    headerLeft: () => (
                        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8, marginLeft: -8 }}>
                            <Ionicons name="arrow-back" size={26} color={isDark ? '#fff' : '#000'} />
                        </TouchableOpacity>
                    ),
                    headerRight: () => (
                        <TouchableOpacity style={{ padding: 8, marginRight: -8 }}>
                            <Ionicons name="ellipsis-horizontal-circle-outline" size={26} color={isDark ? '#fff' : '#000'} />
                        </TouchableOpacity>
                    ),
                }} 
            />
            
            {loading && notifications.length === 0 ? (
                <View style={{ padding: 16 }}>
                    {[1,2,3,4,5,6,7,8].map(i => <NotificationSkeleton key={i} isDark={isDark} />)}
                </View>
            ) : (
                <FlatList
                    data={groupedNotifications}
                    keyExtractor={(item) => item.title}
                    renderItem={({ item }) => (
                        <View>
                            <Text style={[styles.sectionTitle, { color: isDark ? '#fff' : '#000' }]}>
                                {item.title}
                            </Text>
                            {item.data.map(renderNotificationItem)}
                        </View>
                    )}
                    refreshControl={
                        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FF4D67" />
                    }
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Text style={[styles.emptyText, { color: isDark ? '#888' : '#666' }]}>No activity yet</Text>
                        </View>
                    }
                    contentContainerStyle={{ paddingBottom: 20, paddingHorizontal: 16 }}
                />
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    sectionTitle: {
        fontSize: 18,
        fontFamily: 'Urbanist-Bold',
        marginTop: 20,
        marginBottom: 15,
    },
    itemContainer: {
        flexDirection: 'row',
        paddingVertical: 12,
        alignItems: 'center',
    },
    avatarContainer: {
        marginRight: 12,
    },
    avatar: {
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: '#eee'
    },
    textContainer: {
        flex: 1,
        marginRight: 8,
    },
    userName: {
        fontSize: 16,
        fontFamily: 'Urbanist-Bold',
        marginBottom: 2,
    },
    bodyText: {
        fontSize: 14,
        fontFamily: 'Urbanist-Medium',
        lineHeight: 18,
    },
    followButton: {
        backgroundColor: '#FF4D67',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 20,
        minWidth: 100,
        alignItems: 'center',
        justifyContent: 'center',
    },
    followButtonText: {
        color: '#fff',
        fontSize: 14,
        fontFamily: 'Urbanist-Bold',
    },
    postThumb: {
        width: 56,
        height: 56,
        borderRadius: 8,
        backgroundColor: '#eee'
    },
    emptyContainer: {
        padding: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        fontSize: 16,
        fontFamily: 'Urbanist-Medium',
    }
});
