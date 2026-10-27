import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useDesignWindow } from '@/src/lib/layout';
import { useResolvedColorScheme } from '@/src/lib/themePreference';
import { Skeleton } from '../ui/Skeleton';

/**
 * My Wallet while the profile loads. The screen renders its real header above
 * this; everything below mirrors app/wallet/index.tsx:
 *
 *   balance card (marginH 20, radius 28, padding 25, mb 25): label + badge,
 *     42pt balance, 48-tall Top Up button
 *   "Daily Check-in" header (18pt title over 13pt subtitle, padH 20, mb 15)
 *   seven 44 × 60 day cards (radius 22) in (width − 40) / 7 slots
 *   "Daily Tasks" header (mt 25), task cards (padding 12, radius 20, 48 icon)
 *   refer card (marginH 20, mt 20, radius 20, padding 16)
 *   "Transactions" header (mt 25), filter chips (~34 tall, radius 20, mb 15)
 *   transactions (marginH 20, padding 16, radius 20, mb 12, 48 icon, radius 16)
 */
export const WalletSkeleton = () => {
  const isDark = useResolvedColorScheme() === 'dark';
  const { width } = useDesignWindow();
  const daySlot = (width - 40) / 7;
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const referBg = isDark ? '#2A2D35' : '#FFFFFF';

  const sectionHeader = (titleW: number, subW?: number, style?: object) => (
    <View style={[styles.sectionHeader, style]}>
      <Skeleton width={titleW} height={18} borderRadius={8} />
      {subW ? <Skeleton width={subW} height={12} borderRadius={6} style={{ marginTop: 5 }} /> : null}
    </View>
  );

  return (
    <View>
      <View style={[styles.balanceCard, { backgroundColor: cardBg }]}>
        <View style={styles.balanceHeader}>
          <Skeleton width={110} height={16} borderRadius={7} />
          <Skeleton width={72} height={22} borderRadius={12} />
        </View>
        <Skeleton width={120} height={42} borderRadius={12} style={{ marginTop: 4, marginBottom: 25 }} />
        <Skeleton width="100%" height={48} borderRadius={16} />
      </View>

      {sectionHeader(130, 150)}
      <View style={styles.daily}>
        {Array.from({ length: 7 }).map((_, i) => (
          <View key={i} style={{ width: daySlot, alignItems: 'center' }}>
            <Skeleton width={44} height={60} borderRadius={22} style={{ marginBottom: 5 }} />
          </View>
        ))}
      </View>

      {sectionHeader(110, 170, { marginTop: 25 })}
      <View style={{ paddingHorizontal: 20 }}>
        {[0, 1].map((i) => (
          <View key={i} style={[styles.taskCard, { backgroundColor: cardBg }]}>
            <Skeleton width={48} height={48} borderRadius={16} />
            <View style={{ flex: 1, paddingHorizontal: 12 }}>
              <Skeleton width="60%" height={15} borderRadius={7} style={{ marginBottom: 7 }} />
              <Skeleton width="100%" height={6} borderRadius={3} style={{ marginBottom: 7 }} />
              <Skeleton width="40%" height={11} borderRadius={5} />
            </View>
            <Skeleton width={64} height={34} borderRadius={12} />
          </View>
        ))}
      </View>

      <View style={[styles.referCard, { backgroundColor: referBg }]}>
        <Skeleton width={48} height={48} borderRadius={14} />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Skeleton width="45%" height={15} borderRadius={7} />
          <Skeleton width="85%" height={12} borderRadius={6} style={{ marginTop: 6 }} />
        </View>
      </View>

      {sectionHeader(120, undefined, { marginTop: 25, marginBottom: 10 })}
      <View style={styles.filters}>
        {[48, 76, 82].map((w, i) => (
          <Skeleton key={i} width={w} height={34} borderRadius={20} />
        ))}
      </View>

      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.txRow, { backgroundColor: cardBg }]}>
          <Skeleton width={48} height={48} borderRadius={16} />
          <View style={{ flex: 1, marginLeft: 14 }}>
            <Skeleton width="58%" height={15} borderRadius={7} />
            <Skeleton width="40%" height={11} borderRadius={5} style={{ marginTop: 7 }} />
          </View>
          <Skeleton width={40} height={16} borderRadius={7} />
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  balanceCard: { marginHorizontal: 20, marginBottom: 25, borderRadius: 28, padding: 25 },
  balanceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sectionHeader: { paddingHorizontal: 20, marginBottom: 15 },
  daily: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, marginBottom: 5 },
  taskCard: { flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 12, borderRadius: 20 },
  referCard: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 20,
    marginTop: 20,
    borderRadius: 20,
    padding: 16,
  },
  filters: { flexDirection: 'row', paddingHorizontal: 20, marginBottom: 15, gap: 10 },
  txRow: { flexDirection: 'row', alignItems: 'center', padding: 16, marginBottom: 12, borderRadius: 20, marginHorizontal: 20 },
});

export default WalletSkeleton;
