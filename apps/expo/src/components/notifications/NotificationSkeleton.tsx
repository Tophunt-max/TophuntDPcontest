import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/**
 * Shimmer placeholder for the notifications list. Mirrors NotificationRow in
 * app/notifications/index.tsx: list paddingTop 10, full-width rows with
 * padding 12/16, 48 avatar (marginRight 12), a small tag pill (marginBottom 4),
 * a 14pt body on a 20 line, the 12pt time (marginTop 3), and a 48 thumbnail
 * (radius 6) on some rows.
 */
export const NotificationSkeleton = ({ count = 8 }: { count?: number; isDark?: boolean }) => (
  <View style={styles.wrap}>
    {Array.from({ length: count }).map((_, i) => (
      <View key={i} style={styles.row}>
        <SkeletonCircle size={48} style={styles.avatar} />
        <View style={styles.text}>
          <Skeleton width={i % 3 === 1 ? 64 : 50} height={17} borderRadius={6} style={{ marginBottom: 4 }} />
          <Skeleton width="94%" height={14} borderRadius={6} style={{ marginTop: 3 }} />
          {i % 2 === 0 ? <Skeleton width="62%" height={14} borderRadius={6} style={{ marginTop: 6 }} /> : null}
          <Skeleton width={56} height={11} borderRadius={5} style={{ marginTop: 7 }} />
        </View>
        {i % 3 !== 2 ? <Skeleton width={48} height={48} borderRadius={6} /> : null}
      </View>
    ))}
  </View>
);

const styles = StyleSheet.create({
  wrap: { paddingTop: 10 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16 },
  avatar: { marginRight: 12 },
  text: { flex: 1, marginRight: 8 },
});

export default NotificationSkeleton;
