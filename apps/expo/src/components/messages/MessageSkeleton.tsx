import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useResolvedColorScheme } from '@/src/lib/themePreference';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/**
 * One chat row while the inbox loads. Drawn on the same card as the real
 * chatItem in app/messages/index.tsx: marginH 16, marginB 12, padding 12/14,
 * radius 20, card background + soft shadow, 54 avatar, info marginLeft 14,
 * name 15pt over a 14pt preview with the time inline.
 */
export const MessageSkeleton = (_props: { isDark?: boolean }) => {
  const isDark = useResolvedColorScheme() === 'dark';
  return (
    <View style={[styles.card, { backgroundColor: isDark ? '#1B1C22' : '#FFFFFF' }]}>
      <SkeletonCircle size={54} />
      <View style={styles.info}>
        <Skeleton width="55%" height={15} borderRadius={7} style={{ marginBottom: 7 }} />
        <View style={styles.previewRow}>
          <Skeleton width="auto" height={13} borderRadius={6} style={{ flex: 1, maxWidth: '70%' }} />
          <Skeleton width={34} height={11} borderRadius={5} style={{ marginLeft: 8 }} />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#1A1A2E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 2,
  },
  info: { flex: 1, marginLeft: 14, justifyContent: 'center' },
  previewRow: { flexDirection: 'row', alignItems: 'center' },
});
