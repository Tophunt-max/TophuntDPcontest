import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/**
 * One comment row while comments load. Mirrors CommentSheet's comment row:
 * list padding 16, row marginBottom 20, 36 avatar (marginRight 12),
 * name 13pt + time 12pt, text 14pt on an 18 line, "Reply" 12pt (marginTop 4),
 * heart column minWidth 40 with an 18 icon.
 */
export const CommentSkeleton = (_props: { isDark?: boolean }) => (
  <View style={styles.row}>
    <SkeletonCircle size={36} style={styles.avatar} />
    <View style={styles.content}>
      <View style={styles.header}>
        <Skeleton width={96} height={13} borderRadius={6} />
        <Skeleton width={28} height={11} borderRadius={5} style={{ marginLeft: 6 }} />
      </View>
      <Skeleton width="92%" height={13} borderRadius={6} style={{ marginTop: 5 }} />
      <Skeleton width="58%" height={13} borderRadius={6} style={{ marginTop: 5 }} />
      <Skeleton width={34} height={11} borderRadius={5} style={{ marginTop: 8 }} />
    </View>
    <View style={styles.heart}>
      <Skeleton width={18} height={18} borderRadius={9} />
    </View>
  </View>
);

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 20, paddingHorizontal: 16 },
  avatar: { marginRight: 12 },
  content: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 2, marginTop: 1 },
  heart: { minWidth: 40, paddingLeft: 10, alignItems: 'center', paddingTop: 4 },
});
