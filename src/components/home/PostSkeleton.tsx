import React from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { Skeleton } from '../ui/Skeleton';

const { width } = Dimensions.get('window');

export const PostSkeleton = ({ isDark }: { isDark: boolean }) => {
  const skeletonColor = isDark ? '#35383F' : '#E0E0E0'; // Deeper colors for dark and light modes

  return (
    <View style={styles.container}>
      {/* Header Skeleton */}
      <View style={styles.header}>
        <Skeleton width={44} height={44} borderRadius={22} style={{ backgroundColor: skeletonColor }} />
        <View style={styles.headerText}>
          <Skeleton width={120} height={16} borderRadius={4} style={{ backgroundColor: skeletonColor }} />
          <Skeleton width={80} height={12} borderRadius={4} style={{ backgroundColor: skeletonColor, marginTop: 6 }} />
        </View>
      </View>

      {/* Media Skeleton */}
      <View style={styles.media}>
        <Skeleton width={(width - 42) / 2} height={(width - 42) / 2} borderRadius={20} style={{ backgroundColor: skeletonColor }} />
        <Skeleton width={(width - 42) / 2} height={(width - 42) / 2} borderRadius={20} style={{ backgroundColor: skeletonColor }} />
      </View>

      {/* Voting Buttons Skeleton */}
      <View style={styles.voting}>
        <Skeleton width={(width - 42) / 2} height={45} borderRadius={25} style={{ backgroundColor: skeletonColor }} />
        <Skeleton width={(width - 42) / 2} height={45} borderRadius={25} style={{ backgroundColor: skeletonColor }} />
      </View>

      {/* Split Info Skeleton */}
      <View style={styles.split}>
        <Skeleton width={200} height={14} borderRadius={4} style={{ backgroundColor: skeletonColor, marginBottom: 15 }} />
        <Skeleton width="100%" height={6} borderRadius={3} style={{ backgroundColor: skeletonColor }} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingBottom: 20,
    marginBottom: 10,
  },
  header: {
    flexDirection: 'row',
    padding: 16,
    alignItems: 'center',
  },
  headerText: {
    marginLeft: 12,
  },
  media: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
  },
  voting: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginTop: 20,
  },
  split: {
    paddingHorizontal: 16,
    marginTop: 20,
    alignItems: 'center',
  },
});
