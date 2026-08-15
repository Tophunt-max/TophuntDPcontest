import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

export const NotificationSkeleton = (_props: { isDark?: boolean }) => (
  <View style={styles.container}>
    <SkeletonCircle size={44} />
    <View style={styles.content}>
      <Skeleton width="80%" height={14} />
      <Skeleton width="40%" height={12} style={{ marginTop: 8 }} />
    </View>
    <Skeleton width={44} height={44} borderRadius={10} style={{ marginLeft: 12 }} />
  </View>
);

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    paddingHorizontal: 16,
  },
  content: { flex: 1, marginLeft: 12 },
});
