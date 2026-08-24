import React from 'react';
import {
  View,
  StyleSheet,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Skeleton } from '../ui/Skeleton';

/** Shimmer placeholder for the blog list: one featured card + list cards. */
export const BlogSkeleton = () => {
  const isDark = useColorScheme() === 'dark';
  const cardBg = isDark ? '#16171E' : '#FFFFFF';
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
      <View style={[styles.card, { backgroundColor: cardBg }]}>
        <Skeleton width="100%" height={200} borderRadius={0} />
        <View style={styles.body}>
          <Skeleton width={70} height={10} />
          <Skeleton width="92%" height={18} style={{ marginTop: 10 }} />
          <Skeleton width="60%" height={18} style={{ marginTop: 6 }} />
          <Skeleton width="100%" height={11} style={{ marginTop: 12 }} />
          <Skeleton width="80%" height={11} style={{ marginTop: 6 }} />
        </View>
      </View>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.card, { backgroundColor: cardBg }]}>
          <Skeleton width="100%" height={150} borderRadius={0} />
          <View style={styles.body}>
            <Skeleton width={70} height={10} />
            <Skeleton width="85%" height={16} style={{ marginTop: 10 }} />
            <Skeleton width="55%" height={11} style={{ marginTop: 12 }} />
          </View>
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  card: { borderRadius: 16, overflow: 'hidden', marginBottom: 16 },
  body: { padding: 14 },
});

export default BlogSkeleton;
