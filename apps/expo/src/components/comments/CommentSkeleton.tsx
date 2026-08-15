import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

export const CommentSkeleton = (_props: { isDark?: boolean }) => (
  <View style={styles.container}>
    <SkeletonCircle size={36} />
    <View style={styles.content}>
      <View style={styles.header}>
        <Skeleton width={100} height={12} />
        <Skeleton width={30} height={12} style={{ marginLeft: 8 }} />
      </View>
      <Skeleton width="90%" height={14} style={{ marginTop: 8 }} />
      <Skeleton width="60%" height={14} style={{ marginTop: 6 }} />
      <Skeleton width={40} height={10} style={{ marginTop: 10 }} />
    </View>
    <View style={styles.right}>
      <SkeletonCircle size={16} />
      <Skeleton width={12} height={10} style={{ marginTop: 4 }} />
    </View>
  </View>
);

const styles = StyleSheet.create({
  container: { flexDirection: 'row', marginBottom: 24, paddingHorizontal: 16 },
  content: { flex: 1, marginLeft: 12 },
  header: { flexDirection: 'row', alignItems: 'center' },
  right: { alignItems: 'center', width: 30, marginLeft: 10 },
});
