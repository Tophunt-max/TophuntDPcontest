import React, { useEffect, useState } from "react";
import {
  View,
  StyleSheet,
  Pressable,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useRouter } from 'expo-router';
import { HeartIcon_Light, HeartIcon_Dark } from '@/assets/svgs';
import { notificationService } from "@/src/services/notifications/notificationService";
import { useAuth } from "@/src/hooks/useAuth";

export const HeartNotificationIcon = () => {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { user } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);

  const HeartIcon = isDark ? HeartIcon_Dark : HeartIcon_Light;

  useEffect(() => {
    if (!user?.uid) return;

    const unsubscribe = notificationService.subscribeToUnreadCount(user.uid, (count) => {
      setUnreadCount(count);
      // Keep the OS app-icon badge in step with this bell. The worker already
      // sends the right number with each push, but nothing was clearing it
      // locally, so the badge only ever went up.
      void notificationService.syncBadgeCount(count);
    });

    return () => unsubscribe();
  }, [user?.uid]);

  return (
    <Pressable 
        hitSlop={10} 
        onPress={() => router.push('/notifications')}
    >
      <View>
        <HeartIcon width={24} height={24} />
        {unreadCount > 0 && (
          <View style={[styles.badge, { borderColor: isDark ? '#000' : '#fff' }]} />
        )}
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#FF4D67',
    borderWidth: 1.5,
  },
});
