import React from 'react';
import { View, StyleSheet, ScrollView } from 'react-native';
import { useResolvedColorScheme } from '@/src/lib/themePreference';
import { Colors } from '@/constants/theme';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/**
 * The stories rail while it loads. Same box as StoriesBar (100 tall, hairline
 * bottom border, 8px list padding) and the same tile as StoryItem (72 wide,
 * 8px side margins, 68 ring, 12pt name), so the row does not shift when the
 * real rail replaces it.
 */
export const StoriesSkeleton = (_props: { isDark?: boolean }) => {
  const isDark = useResolvedColorScheme() === 'dark';
  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: isDark ? Colors.dark.background : Colors.light.background,
          borderBottomColor: isDark ? '#35383F' : '#DBDBDB',
        },
      ]}
    >
      <ScrollView
        horizontal
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.list}
      >
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <View key={i} style={styles.item}>
            <View style={styles.ringBox}>
              <SkeletonCircle size={68} />
            </View>
            <Skeleton width={i === 0 ? 52 : 44} height={10} borderRadius={5} style={{ marginTop: 2 }} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { height: 100, borderBottomWidth: StyleSheet.hairlineWidth },
  list: { paddingHorizontal: 8, alignItems: 'center' },
  item: { alignItems: 'center', marginHorizontal: 8, width: 72 },
  ringBox: { width: 72, height: 72, marginBottom: 4, alignItems: 'center', justifyContent: 'center' },
});
