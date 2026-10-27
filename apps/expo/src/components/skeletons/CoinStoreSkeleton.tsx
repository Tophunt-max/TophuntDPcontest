import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useResolvedColorScheme } from '@/src/lib/themePreference';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/**
 * Package grid while the coin store loads. The screen already shows the real
 * header, balance card and "Select a Package" title above this, so only the
 * grid is drawn. Mirrors listContent + card in app/wallet/store.tsx:
 * padH 20, padT 18; two 47%-wide cards per row (radius 20, padding 18,
 * marginB 22, 1.5 border) with a 56 coin circle, 26pt count, label, bonus
 * row and the 46-tall price button.
 */
export const CoinStoreSkeleton = ({ count = 4 }: { count?: number }) => {
  const isDark = useResolvedColorScheme() === 'dark';
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const border = isDark ? '#35383F' : '#EEEEEE';
  return (
    <View style={styles.list}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={[styles.card, { backgroundColor: cardBg, borderColor: border }]}>
          <View style={styles.coin}>
            <SkeletonCircle size={56} style={{ marginBottom: 10 }} />
            <Skeleton width={60} height={26} borderRadius={8} />
            <Skeleton width={48} height={11} borderRadius={5} style={{ marginTop: 5 }} />
            <Skeleton width={70} height={20} borderRadius={10} style={{ marginTop: 9 }} />
          </View>
          <Skeleton width="100%" height={46} borderRadius={12} />
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  list: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 18,
  },
  card: { width: '47%', borderRadius: 20, padding: 18, alignItems: 'center', marginBottom: 22, borderWidth: 1.5 },
  coin: { alignItems: 'center', marginBottom: 16, marginTop: 6 },
});

export default CoinStoreSkeleton;
