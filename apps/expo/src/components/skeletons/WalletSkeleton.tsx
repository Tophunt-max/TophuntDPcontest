import React from 'react';
import { View, StyleSheet, useColorScheme } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/** Shimmer placeholder for the wallet screen: balance card + transaction rows. */
export const WalletSkeleton = () => {
  const isDark = useColorScheme() === 'dark';
  const cardBg = isDark ? '#16171E' : '#FFFFFF';
  return (
    <View style={{ padding: 16 }}>
      {/* Balance card */}
      <Skeleton width="100%" height={190} borderRadius={24} />

      {/* Daily reward strip */}
      <View style={styles.rewardRow}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} width={58} height={78} borderRadius={16} />
        ))}
      </View>

      {/* Section title + filters */}
      <Skeleton width={150} height={18} style={{ marginTop: 24, marginBottom: 14 }} />
      <View style={styles.filterRow}>
        {[70, 80, 64, 76].map((w, i) => (
          <Skeleton key={i} width={w} height={32} borderRadius={100} />
        ))}
      </View>

      {/* Transactions */}
      {[0, 1, 2, 3, 4].map((i) => (
        <View key={i} style={[styles.txRow, { backgroundColor: cardBg }]}>
          <SkeletonCircle size={40} />
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Skeleton width="55%" height={14} />
            <Skeleton width="35%" height={10} style={{ marginTop: 7 }} />
          </View>
          <Skeleton width={50} height={16} />
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  rewardRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 },
  filterRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  txRow: { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 16, marginBottom: 10 },
});

export default WalletSkeleton;
