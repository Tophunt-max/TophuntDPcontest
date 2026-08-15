import React from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

export const StoriesSkeleton = (_props: { isDark?: boolean }) => (
  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.container}>
    {[1, 2, 3, 4, 5, 6].map((i) => (
      <View key={i} style={styles.storyItem}>
        <SkeletonCircle size={70} />
        <Skeleton width={50} height={10} style={{ marginTop: 8 }} />
      </View>
    ))}
  </ScrollView>
);

const styles = StyleSheet.create({
  container: { paddingLeft: 16, paddingVertical: 10 },
  storyItem: { alignItems: 'center', marginRight: 15 },
});
