import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useResolvedColorScheme } from '@/src/lib/themePreference';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/**
 * A battle card while it loads, drawn on the same card as PostCard so the feed
 * does not jump when real cards replace it. Mirrors PostCard's styles, in order:
 *
 *   card: radius 24, marginH 10, marginB 20, paddingB 14, shadow
 *   header (pad 16/14/12): two overlapping 32 avatars, "A VS B" + title, prize pill
 *   media (marginH 16, gap 12): two 260-tall slots, radius 20, VS orb in the middle
 *   meter (mt 16): 9-tall track, then % · time chip · %
 *   vote counts (paddingH 20, mt 16)
 *   vote buttons (mt 8, gap 12): 46 tall, radius 16
 *   action bar (mt 16, top border): like · comment · share  …  bookmark
 */
export const PostSkeleton = (_props: { isDark?: boolean }) => {
  const isDark = useResolvedColorScheme() === 'dark';
  const cardColor = isDark ? '#181B21' : '#FFFFFF';
  const trackColor = isDark ? '#2A2E37' : '#EEF0F4';
  return (
    <View style={[styles.card, { backgroundColor: cardColor }]}>
      <View style={styles.header}>
        <View style={styles.avatars}>
          <SkeletonCircle size={32} style={[styles.avatar, { borderColor: cardColor }]} />
          <SkeletonCircle size={32} style={[styles.avatar, { borderColor: cardColor, marginLeft: -14 }]} />
        </View>
        <View style={styles.names}>
          <Skeleton width="70%" height={16} borderRadius={8} />
          <Skeleton width="45%" height={11} borderRadius={6} style={{ marginTop: 6 }} />
        </View>
        <Skeleton width={52} height={24} borderRadius={12} />
      </View>

      <View style={styles.media}>
        <Skeleton width="auto" height={260} borderRadius={20} style={styles.slot} />
        <Skeleton width="auto" height={260} borderRadius={20} style={styles.slot} />
        <View style={styles.vsOrbWrap} pointerEvents="none">
          <View style={[styles.vsOrb, { backgroundColor: cardColor }]} />
        </View>
      </View>

      <View style={styles.meter}>
        <Skeleton width="100%" height={9} borderRadius={5} />
        <View style={styles.meterLabels}>
          <Skeleton width={32} height={13} borderRadius={6} />
          <Skeleton width={108} height={24} borderRadius={12} />
          <Skeleton width={32} height={13} borderRadius={6} />
        </View>
      </View>

      <View style={styles.counts}>
        <Skeleton width={70} height={16} borderRadius={8} />
        <Skeleton width={70} height={16} borderRadius={8} />
      </View>

      <View style={styles.buttons}>
        <Skeleton width="auto" height={46} borderRadius={16} style={styles.slot} />
        <Skeleton width="auto" height={46} borderRadius={16} style={styles.slot} />
      </View>

      <View style={[styles.actions, { borderTopColor: trackColor }]}>
        <View style={styles.leftActions}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width={44} height={22} borderRadius={11} style={{ marginRight: 20 }} />
          ))}
        </View>
        <Skeleton width={22} height={24} borderRadius={6} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: 24,
    marginHorizontal: 10,
    marginBottom: 20,
    paddingBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12 },
  avatars: { flexDirection: 'row', alignItems: 'center' },
  avatar: { borderWidth: 2 },
  names: { flex: 1, marginLeft: 10, marginRight: 10 },
  media: { flexDirection: 'row', marginHorizontal: 16, gap: 12 },
  slot: { flex: 1 },
  vsOrbWrap: { position: 'absolute', top: '50%', left: 0, right: 0, alignItems: 'center', marginTop: -22 },
  vsOrb: { width: 44, height: 44, borderRadius: 22, opacity: 0.9 },
  meter: { paddingHorizontal: 16, marginTop: 16 },
  meterLabels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  counts: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, marginTop: 16 },
  buttons: { flexDirection: 'row', paddingHorizontal: 16, marginTop: 8, gap: 12 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    marginTop: 16,
    borderTopWidth: 1,
  },
  leftActions: { flexDirection: 'row', alignItems: 'center' },
});
