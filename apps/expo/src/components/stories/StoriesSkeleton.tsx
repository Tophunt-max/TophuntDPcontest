import React from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { Skeleton } from '../ui/Skeleton';

export const StoriesSkeleton = ({ isDark }: { isDark: boolean }) => {
  const skeletonColor = isDark ? '#35383F' : '#E0E0E0'; // Deeper colors

  return (
    <ScrollView 
        horizontal 
        showsHorizontalScrollIndicator={false} 
        contentContainerStyle={styles.container}
    >
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <View key={i} style={styles.storyItem}>
          <Skeleton width={70} height={70} borderRadius={35} style={{ backgroundColor: skeletonColor }} />
          <Skeleton width={50} height={10} borderRadius={4} style={{ backgroundColor: skeletonColor, marginTop: 8 }} />
        </View>
      ))}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingLeft: 16,
    paddingVertical: 10,
  },
  storyItem: {
    alignItems: 'center',
    marginRight: 15,
  },
});
