import React from 'react';
import { View, StyleSheet, useColorScheme } from 'react-native';
import { Skeleton } from '../ui/Skeleton';

/** Shimmer placeholder for a simple contest list (title + prize + chevron). */
export const ContestListSkeleton = ({ count = 6 }: { count?: number }) => {
  const isDark = useColorScheme() === 'dark';
  const cardBg = isDark ? '#16171E' : '#FFFFFF';
  const border = isDark ? '#23262F' : '#EEEEEE';
  return (
    <View style={{ padding: 16 }}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={[styles.card, { backgroundColor: cardBg, borderColor: border }]}>
          <View style={{ flex: 1 }}>
            <Skeleton width="60%" height={16} />
            <Skeleton width="35%" height={12} style={{ marginTop: 10 }} />
          </View>
          <Skeleton width={24} height={24} borderRadius={12} />
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 18,
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 12,
  },
});

export default ContestListSkeleton;
