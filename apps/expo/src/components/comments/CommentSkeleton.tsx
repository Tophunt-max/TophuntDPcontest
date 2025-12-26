import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Skeleton } from '../ui/Skeleton';

export const CommentSkeleton = ({ isDark }: { isDark: boolean }) => {
  const skeletonColor = isDark ? '#35383F' : '#E0E0E0';

  return (
    <View style={styles.container}>
      <Skeleton width={36} height={36} borderRadius={18} style={{ backgroundColor: skeletonColor }} />
      <View style={styles.content}>
        <View style={styles.header}>
          <Skeleton width={100} height={12} borderRadius={4} style={{ backgroundColor: skeletonColor }} />
          <Skeleton width={30} height={12} borderRadius={4} style={{ backgroundColor: skeletonColor, marginLeft: 8 }} />
        </View>
        <Skeleton width="90%" height={14} borderRadius={4} style={{ backgroundColor: skeletonColor, marginTop: 8 }} />
        <Skeleton width="60%" height={14} borderRadius={4} style={{ backgroundColor: skeletonColor, marginTop: 6 }} />
        <View style={styles.footer}>
          <Skeleton width={40} height={10} borderRadius={4} style={{ backgroundColor: skeletonColor }} />
        </View>
      </View>
      <View style={styles.right}>
        <Skeleton width={16} height={16} borderRadius={8} style={{ backgroundColor: skeletonColor }} />
        <Skeleton width={12} height={10} borderRadius={4} style={{ backgroundColor: skeletonColor, marginTop: 4 }} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    marginBottom: 24,
    paddingHorizontal: 16,
  },
  content: {
    flex: 1,
    marginLeft: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  footer: {
    marginTop: 10,
  },
  right: {
    alignItems: 'center',
    width: 30,
    marginLeft: 10,
  },
});
