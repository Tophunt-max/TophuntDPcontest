import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useResolvedColorScheme } from '@/src/lib/themePreference';
import { Skeleton } from '../ui/Skeleton';

/**
 * One contest card while the list loads. Mirrors the cards on
 * app/contest/photo/index.tsx and app/contest/video/index.tsx: radius 22,
 * marginBottom 20, shadow, a 190-tall banner (LIVE pill top-left, badges
 * top-right, 22pt title at the bottom), then a footer (padding 16) with the
 * prize line on the left and the ~42-tall Enter button on the right.
 */
export const ContestCardSkeleton = () => {
  const isDark = useResolvedColorScheme() === 'dark';
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  return (
    <View style={[styles.card, { backgroundColor: cardBg }]}>
      <View style={styles.banner}>
        <Skeleton width="100%" height={190} borderRadius={0} style={StyleSheet.absoluteFill} />
        <View style={styles.topRow}>
          <Skeleton width={52} height={22} borderRadius={11} />
          <Skeleton width={90} height={22} borderRadius={11} />
        </View>
        <View style={styles.bannerBottom}>
          <Skeleton width="68%" height={22} borderRadius={8} />
        </View>
      </View>
      <View style={styles.footer}>
        <View>
          <Skeleton width={74} height={10} borderRadius={5} />
          <Skeleton width={96} height={18} borderRadius={7} style={{ marginTop: 6 }} />
        </View>
        <Skeleton width={92} height={42} borderRadius={14} />
      </View>
    </View>
  );
};

/**
 * The card list itself. The caller supplies the list padding (the real lists
 * pad 20 on photo and 16 on video), so this adds none.
 */
export const ContestListSkeleton = ({ count = 3 }: { count?: number }) => (
  <View>
    {Array.from({ length: count }).map((_, i) => (
      <ContestCardSkeleton key={i} />
    ))}
  </View>
);

const styles = StyleSheet.create({
  card: {
    borderRadius: 22,
    marginBottom: 20,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    overflow: 'hidden',
  },
  banner: { height: 190, justifyContent: 'flex-end', padding: 16, overflow: 'hidden' },
  topRow: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  bannerBottom: {},
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
});

export default ContestListSkeleton;
