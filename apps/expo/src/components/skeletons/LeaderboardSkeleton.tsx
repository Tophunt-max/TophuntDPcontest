import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/** Shimmer placeholder for the leaderboard: podium (top 3) + ranked rows. */
export const LeaderboardSkeleton = () => (
  <View style={{ paddingHorizontal: 16 }}>
    <View style={styles.podium}>
      {[{ s: 60, mt: 40 }, { s: 88, mt: 0 }, { s: 60, mt: 60 }].map((p, i) => (
        <View key={i} style={{ alignItems: 'center', width: '30%', marginTop: p.mt }}>
          <SkeletonCircle size={p.s} />
          <Skeleton width={62} height={12} style={{ marginTop: 10 }} />
          <Skeleton width={40} height={10} style={{ marginTop: 6 }} />
        </View>
      ))}
    </View>
    {Array.from({ length: 6 }).map((_, i) => (
      <View key={i} style={styles.row}>
        <Skeleton width={18} height={16} />
        <SkeletonCircle size={44} style={{ marginLeft: 12 }} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Skeleton width="50%" height={14} />
          <Skeleton width="30%" height={10} style={{ marginTop: 6 }} />
        </View>
        <Skeleton width={40} height={16} />
      </View>
    ))}
  </View>
);

const styles = StyleSheet.create({
  podium: { flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-end', height: 200, marginBottom: 20, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(150,150,150,0.15)' },
});

export default LeaderboardSkeleton;
