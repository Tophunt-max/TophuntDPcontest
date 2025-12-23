import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Image, TouchableOpacity, SafeAreaView, useColorScheme, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { Left_Arrow } from '@/assets/svgs';
import { NotificationSkeleton } from '@/src/components/notifications/NotificationSkeleton';
import { notificationService, Notification } from '@/src/services/notifications/notificationService';
import { useAuth } from '@/src/hooks/useAuth';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

export default function NotificationsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  const backgroundColor = isDark ? '#181A20' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const subTextColor = isDark ? '#BDBDBD' : '#616161';

  useEffect(() => {
    if (!user?.uid) return;

    const unsubscribe = notificationService.subscribeToNotifications(
      user.uid,
      (data) => {
        setNotifications(data);
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, [user?.uid]);

  const onRefresh = async () => {
    setIsRefreshing(true);
    // Logic for refresh if needed, though subscription handles it
    setTimeout(() => setIsRefreshing(false), 1000);
  };

  const formatTime = (timestamp: any) => {
    if (!timestamp) return '';
    try {
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return dayjs(date).fromNow(true)
        .replace(' seconds', 's')
        .replace(' second', 's')
        .replace(' minutes', 'm')
        .replace(' minute', 'm')
        .replace(' hours', 'h')
        .replace(' hour', 'h')
        .replace(' days', 'd')
        .replace(' day', 'd')
        .replace(' months', 'mo')
        .replace(' month', 'mo')
        .replace(' years', 'y')
        .replace(' year', 'y')
        .replace('a ', '1')
        .replace('an ', '1');
    } catch (e) {
      return '';
    }
  };

  const renderItem = ({ item }: { item: Notification }) => (
    <View style={styles.notificationItem}>
      <Image source={{ uri: item.senderAvatar || 'https://ui-avatars.com/api/?name=' + item.senderName }} style={styles.avatar} />
      <View style={styles.contentContainer}>
        <Text style={[styles.contentText, { color: textColor }]}>
          <Text style={styles.username}>{item.senderName}</Text>
          {item.type === 'like' && ' liked your post.'}
          {item.type === 'follow' && ' started following you.'}
          {item.type === 'comment' && ` commented: ${item.commentText}`}
          <Text style={[styles.timeText, { color: subTextColor }]}> {formatTime(item.createdAt)}</Text>
        </Text>
      </View>
      
      {item.type === 'follow' ? (
        <TouchableOpacity 
            style={[
                styles.followButton, 
                { backgroundColor: '#FF4D67' }
            ]}
        >
          <Text style={styles.followButtonText}>
            Follow
          </Text>
        </TouchableOpacity>
      ) : (
        item.postImage && <Image source={{ uri: item.postImage }} style={styles.postImage} />
      )}
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Left_Arrow width={24} height={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]}>Notifications</Text>
        <View style={{ width: 24 }} />
      </View>

      {isLoading ? (
        <View style={{ marginTop: 20 }}>
            {[1, 2, 3, 4, 5, 6].map(i => <NotificationSkeleton key={i} isDark={isDark} />)}
        </View>
      ) : (
        <FlatList
            data={notifications}
            renderItem={renderItem}
            keyExtractor={item => item.id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={<Text style={[styles.sectionTitle, { color: textColor }]}>This Week</Text>}
            refreshControl={
                <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor="#FF4D67" />
            }
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
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    height: 56,
  },
  backBtn: {
    padding: 4,
  },
  headerTitle: {
    fontFamily: 'Urbanist-Bold',
    fontSize: 20,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  sectionTitle: {
    fontFamily: 'Urbanist-Bold',
    fontSize: 18,
    marginVertical: 16,
  },
  notificationItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  contentContainer: {
    flex: 1,
    marginHorizontal: 12,
  },
  contentText: {
    fontFamily: 'Urbanist-Regular',
    fontSize: 14,
    lineHeight: 18,
  },
  username: {
    fontFamily: 'Urbanist-Bold',
  },
  timeText: {
    fontSize: 12,
  },
  postImage: {
    width: 44,
    height: 44,
    borderRadius: 4,
  },
  followButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    minWidth: 90,
    alignItems: 'center',
  },
  followingButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  followButtonText: {
    fontFamily: 'Urbanist-Bold',
    fontSize: 13,
    color: '#FFF',
  },
});
