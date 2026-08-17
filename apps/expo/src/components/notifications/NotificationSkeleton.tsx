import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/**
 * Shimmer placeholder for the notifications list. Count-driven (mirrors
 * UserListSkeleton) so the screen renders one <NotificationSkeleton count={n} />
 * instead of repeating the component manually. Includes top padding so the
 * skeleton lines up with the loaded list (which also has a top gap).
 */
export const NotificationSkeleton = ({ count = 8 }: { count?: number; isDark?: boolean }) => (
  <View style={styles.wrap}>
    {Array.from({ length: count }).map((_, i) => (
      <View key={i} style={styles.row}>
        <SkeletonCircle size={44} />
        <View style={styles.content}>
          <Skeleton width="80%" height={14} />
          <Skeleton width="40%" height={12} style={{ marginTop: 8 }} />
        </View>
        <Skeleton width={44} height={44} borderRadius={10} style={{ marginLeft: 12 }} />
      </View>
    ))}
  </View>
);

const styles = StyleSheet.create({
  wrap: { paddingTop: 12, paddingHorizontal: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 22,
  },
  content: { flex: 1, marginLeft: 12 },
});

export default NotificationSkeleton;
