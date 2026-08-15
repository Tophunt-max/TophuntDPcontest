import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/** Shimmer placeholder for a list of users (followers/following, suggestions). */
export const UserListSkeleton = ({ count = 9 }: { count?: number }) => (
  <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
    {Array.from({ length: count }).map((_, i) => (
      <View key={i} style={styles.row}>
        <SkeletonCircle size={50} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Skeleton width="55%" height={14} />
          <Skeleton width="35%" height={11} style={{ marginTop: 7 }} />
        </View>
        <Skeleton width={84} height={34} borderRadius={100} />
      </View>
    ))}
  </View>
);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
});

export default UserListSkeleton;
