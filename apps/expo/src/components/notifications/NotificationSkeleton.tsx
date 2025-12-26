import React from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { Skeleton } from '../ui/Skeleton';

const { width } = Dimensions.get('window');

export const NotificationSkeleton = ({ isDark }: { isDark: boolean }) => {
  const skeletonColor = isDark ? '#35383F' : '#E0E0E0';

  return (
    <View style={styles.container}>
      <Skeleton width={44} height={44} borderRadius={22} style={{ backgroundColor: skeletonColor }} />
      <View style={styles.content}>
        <Skeleton width="80%" height={14} borderRadius={4} style={{ backgroundColor: skeletonColor }} />
        <Skeleton width="40%" height={12} borderRadius={4} style={{ backgroundColor: skeletonColor, marginTop: 8 }} />
      </View>
      <Skeleton width={44} height={44} borderRadius={4} style={{ backgroundColor: skeletonColor, marginLeft: 12 }} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    paddingHorizontal: 16,
  },
  content: {
    flex: 1,
    marginLeft: 12,
  },
});
