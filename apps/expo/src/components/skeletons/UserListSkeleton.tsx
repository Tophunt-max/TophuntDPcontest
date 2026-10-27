import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useResolvedColorScheme } from '@/src/lib/themePreference';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/**
 * Followers / following while loading. Mirrors userCard in
 * app/profile/connections.tsx: card with padding 12, radius 16, marginH 16,
 * marginB 10 and a soft shadow; 50 avatar (marginRight 12), 16pt name over a
 * 14pt handle, and the ~31-tall Follow / Remove pill on the right.
 */
export const UserListSkeleton = ({ count = 9 }: { count?: number }) => {
  const isDark = useResolvedColorScheme() === 'dark';
  const cardBg = isDark ? '#1C1C1E' : '#FFFFFF';
  return (
    <View>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={[styles.card, { backgroundColor: cardBg }]}>
          <SkeletonCircle size={50} style={{ marginRight: 12 }} />
          <View style={{ flex: 1 }}>
            <Skeleton width="55%" height={15} borderRadius={7} />
            <Skeleton width="36%" height={12} borderRadius={6} style={{ marginTop: 6 }} />
          </View>
          <Skeleton width={78} height={31} borderRadius={20} />
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 16,
    marginHorizontal: 16,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
});

export default UserListSkeleton;
