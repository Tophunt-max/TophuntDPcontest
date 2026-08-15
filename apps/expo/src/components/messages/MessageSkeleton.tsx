import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

export const MessageSkeleton = (_props: { isDark?: boolean }) => (
  <View style={styles.container}>
    <SkeletonCircle size={60} />
    <View style={styles.content}>
      <View style={styles.row}>
        <Skeleton width={120} height={16} />
        <Skeleton width={40} height={12} />
      </View>
      <Skeleton width="80%" height={14} style={{ marginTop: 8 }} />
    </View>
  </View>
);

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 20,
  },
  content: {
    flex: 1,
    marginLeft: 16,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
