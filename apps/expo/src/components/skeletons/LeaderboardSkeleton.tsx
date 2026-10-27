import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useDesignWindow } from '@/src/lib/layout';
import { PAD, useExplorePalette } from '../explore/theme';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/**
 * Leaderboard while loading. Mirrors Podium and Row in app/explore/leaderboard.tsx:
 *
 *   podium (padH 20, padT 20, padB 18): three columns of (width − 40) / 3 in
 *     the order 2 · 1 · 3. Rings are 78 / 98 / 78 (66 / 86 avatars + ring),
 *     offset 26 / 0 / 40 from the top, with a 30 crown slot over rank 1.
 *     Name marginTop 16, score marginTop 2.
 *   rows: cards (marginH 20, marginB 10, padding 12, radius 16, 1px border),
 *     30-wide rank, 44 avatar, name over handle, score over unit on the right.
 */
export const LeaderboardSkeleton = ({ rows = 6 }: { rows?: number }) => {
  const p = useExplorePalette();
  const { width } = useDesignWindow();
  const colW = (width - PAD * 2) / 3;

  const cols = [
    { ring: 78, mt: 26, crown: false },
    { ring: 98, mt: 0, crown: true },
    { ring: 78, mt: 40, crown: false },
  ];

  return (
    <View>
      <View style={styles.podium}>
        {cols.map((c, i) => (
          <View key={i} style={{ width: colW, alignItems: 'center', marginTop: c.mt }}>
            {c.crown ? <View style={{ height: 26 }} /> : null}
            <SkeletonCircle size={c.ring} />
            <Skeleton width={Math.min(70, colW - 16)} height={13} borderRadius={6} style={{ marginTop: 16 }} />
            <Skeleton width={44} height={12} borderRadius={6} style={{ marginTop: 4 }} />
          </View>
        ))}
      </View>

      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={[styles.row, { backgroundColor: p.card, borderColor: p.border }]}>
          <View style={styles.rank}>
            <Skeleton width={14} height={15} borderRadius={4} />
          </View>
          <SkeletonCircle size={44} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Skeleton width="52%" height={14} borderRadius={6} />
            <Skeleton width="34%" height={11} borderRadius={5} style={{ marginTop: 5 }} />
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Skeleton width={34} height={16} borderRadius={6} />
            <Skeleton width={26} height={9} borderRadius={4} style={{ marginTop: 4 }} />
          </View>
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  podium: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: PAD, paddingTop: 20, paddingBottom: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: PAD,
    marginBottom: 10,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
  },
  rank: { width: 30 },
});

export default LeaderboardSkeleton;
