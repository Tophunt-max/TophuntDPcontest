import React from 'react';
import {
  View,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

const CARD_W = (Dimensions.get('window').width - 20 * 2 - 12) / 2;

/** Shimmer placeholder for the coin store: balance bar + 2-col package grid. */
export const CoinStoreSkeleton = () => {
  const isDark = useColorScheme() === 'dark';
  const cardBg = isDark ? '#16171E' : '#FFFFFF';
  const border = isDark ? '#23262F' : '#EEEEEE';
  return (
    <View style={{ paddingHorizontal: 20 }}>
      <Skeleton width="100%" height={72} borderRadius={16} style={{ marginBottom: 24 }} />
      <View style={styles.grid}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={[styles.pkg, { backgroundColor: cardBg, borderColor: border, width: CARD_W }]}>
            <SkeletonCircle size={36} />
            <Skeleton width={72} height={22} style={{ marginTop: 14 }} />
            <Skeleton width={50} height={12} style={{ marginTop: 8 }} />
            <Skeleton width="100%" height={40} borderRadius={12} style={{ marginTop: 18 }} />
          </View>
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  pkg: { alignItems: 'center', padding: 16, borderRadius: 20, borderWidth: 1, marginBottom: 16 },
});

export default CoinStoreSkeleton;
