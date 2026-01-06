
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Image, TouchableOpacity, SafeAreaView, useColorScheme, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { Left_Arrow } from '@/assets/svgs';
import { NotificationSkeleton } from '@/src/components/notifications/NotificationSkeleton';
import { notificationService, Notification } from '@/src/services/notifications/notificationService';
import { useAuth } from '@/src/hooks/useAuth';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Colors } from '@/constants/theme';

dayjs.extend(relativeTime);

export default function NotificationsScreen() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isLoading, setIsLoading] = useState(true); // Single loading state
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const subTextColor = isDark ? '#BDBDBD' : '#616161';

  useEffect(() => {
    // Agar authentication chal rahi hai, to loading state true rakhein
    if (authLoading) {
      setIsLoading(true);
      return;
    }

    // Agar user logged in nahi hai, to loading band karein aur khali screen dikhayein
    if (!user?.uid) {
      setIsLoading(false);
      return;
    }

    // User mil gaya, ab notifications fetch karein
    const unsubscribe = notificationService.subscribeToNotifications(user.uid, (data) => {
        setNotifications(data);
        setIsLoading(false); // Data aane ke baad loading band karein
    });

    return () => unsubscribe(); // Cleanup subscription
  }, [user, authLoading]); // Effect ko user aur authLoading par depend karein

  const onRefresh = () => {
    setIsRefreshing(true);
    // Real-time listener updates ko handle karta hai, isliye bas thodi der baad refreshing band karein
    setTimeout(() => setIsRefreshing(false), 1000);
  };

  const formatTime = (timestamp: any) => {
    if (!timestamp) return '';
    const date = timestamp?.toDate ? timestamp.toDate() : new Date(timestamp);
    return dayjs(date).fromNow(true);
  };
  
  // (renderItem and styles wahi rahenge, unmein koi change nahi hai)

  const renderItem = ({ item }: { item: Notification | any }) => {
    
    const getNotificationMessage = () => {
      switch (item.type) {
        case 'like': return 'liked your post.';
        case 'follow': return 'started following you.';
        case 'comment': return `commented: "${item.commentText || ''}"`;
        case 'message': return 'sent you a message.';
        case 'profile_visit': return 'visited your profile.';
        default: return item.body || 'sent you a notification.';
      }
    };
    
    const message = getNotificationMessage();

    const handlePress = () => {
      if (item.type === 'message' && item.chatId) router.push(`/messages/chat/${item.chatId}`);
      else if (['profile_visit', 'follow'].includes(item.type) && item.senderId) router.push({ pathname: '/profile', params: { userId: item.senderId } });
      else if (item.postId) router.push({ pathname: '/home', params: { postId: item.postId } });
      else router.push('/home');
    };
    
    const isRewardType = ['signup_bonus', 'daily_reward'].includes(item.type);
    const defaultAvatar = isRewardType 
      ? 'https://cdn-icons-png.flaticon.com/512/179/179386.png'
      : 'https://ui-avatars.com/api/?name=' + (item.senderName || 'S');

    return (
      <TouchableOpacity style={styles.notificationItem} activeOpacity={0.7} onPress={handlePress}>
        <Image source={{ uri: item.senderAvatar || defaultAvatar }} style={styles.avatar} />
        <View style={styles.contentContainer}>
          <Text style={[styles.contentText, { color: textColor }]} numberOfLines={2}>
            <Text style={styles.username}>{item.senderName || item.title || 'Someone'} </Text>
            {message}
          </Text>
          <Text style={[styles.timeText, { color: subTextColor }]}>{formatTime(item.createdAt)} ago</Text>
        </View>
        {item.postImage && item.type !== 'follow' ? (
          <Image source={{ uri: item.postImage }} style={styles.postImage} />
        ) : item.type === 'follow' ? (
           <TouchableOpacity style={[styles.followButton, { backgroundColor: '#FF4D67' }]}>
            <Text style={styles.followButtonText}>Follow Back</Text>
          </TouchableOpacity>
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Left_Arrow width={24} height={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]}>Notifications</Text>
        <View style={{ width: 40 }} />
      </View>

      {isLoading ? (
        <View style={{ marginTop: 20 }}>{[...Array(5)].map((_, i) => <NotificationSkeleton key={i} isDark={isDark} />)}</View>
      ) : (
        <FlatList
            data={notifications}
            renderItem={renderItem}
            keyExtractor={item => item.id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
            refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor="#FF4D67" />}
            ListEmptyComponent={
              <View style={styles.emptyComponent}>
                <Text style={{ color: subTextColor, fontFamily: 'Urbanist-Medium' }}>No notifications yet.</Text>
              </View>
            }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 56 },
  backBtn: { padding: 4, width: 40 },
  headerTitle: { fontFamily: 'Urbanist-Bold', fontSize: 20 },
  listContent: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 40 },
  notificationItem: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  avatar: { width: 48, height: 48, borderRadius: 24 },
  contentContainer: { flex: 1, marginHorizontal: 12, justifyContent: 'center' },
  contentText: { fontFamily: 'Urbanist-Regular', fontSize: 14, lineHeight: 18 },
  username: { fontFamily: 'Urbanist-Bold' },
  timeText: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 4 },
  postImage: { width: 48, height: 48, borderRadius: 8 },
  followButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, minWidth: 90, alignItems: 'center', justifyContent: 'center' },
  followButtonText: { fontFamily: 'Urbanist-Bold', fontSize: 12, color: '#FFF' },
  emptyComponent: { flex: 1, alignItems: 'center', justifyContent: 'center', marginTop: 150 }
});
