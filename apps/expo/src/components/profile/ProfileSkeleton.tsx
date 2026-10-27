import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Skeleton, SkeletonCircle, useSkeletonColors } from '../ui/Skeleton';
import { PostSkeleton } from '../home/PostSkeleton';

/**
 * Profile loading state, drawn block for block like `ProfileHeader` (and
 * `ProfileTabs` below it), so nothing jumps when the real profile replaces it.
 *
 * Mirrors, in order (see ProfileHeader styles):
 *   top bar 56 tall: empty 40 | @username | 40 slot with the ⋮ / settings icon
 *   avatar ring 110 (100 photo) at marginTop 10, with the "Lv." pill on its rim
 *   full name (22pt) at marginTop 15
 *   buttons at marginTop 20: Follow + Message pills (40 tall), or one Edit pill
 *   stats at marginTop 25: three flex columns, value 20pt + label 13pt
 *   level bar at marginTop 20, paddingH 30: label row + 10-tall track
 *   tab bar: full-width row, Photo | Video (| Saved), top + bottom border
 *
 * The real list under the tabs is battle CARDS (PostCard), not a grid, so the
 * loading list below is `PostSkeleton`s.
 */
export const ProfileHeaderSkeleton = ({ isOwnProfile = false }: { isOwnProfile?: boolean }) => {
  const { base } = useSkeletonColors();
  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <View style={styles.topSlot} />
        <Skeleton width={130} height={18} borderRadius={9} />
        <View style={[styles.topSlot, { alignItems: 'flex-end' }]}>
          <Skeleton width={6} height={20} borderRadius={3} />
        </View>
      </View>

      <View style={styles.avatarWrap}>
        <View style={[styles.avatarRing, { borderColor: base }]}>
          <SkeletonCircle size={100} />
        </View>
        <Skeleton width={40} height={18} borderRadius={10} style={styles.levelPill} />
      </View>

      <View style={styles.info}>
        <Skeleton width={150} height={22} borderRadius={8} />
      </View>

      <View style={styles.buttons}>
        {isOwnProfile ? (
          <Skeleton width={128} height={40} borderRadius={20} />
        ) : (
          <>
            <Skeleton width={112} height={40} borderRadius={24} />
            <Skeleton width={124} height={40} borderRadius={24} />
          </>
        )}
      </View>

      <View style={styles.stats}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.statItem}>
            <Skeleton width={28} height={22} borderRadius={6} />
            <Skeleton width={i === 0 ? 34 : 64} height={12} borderRadius={6} style={{ marginTop: 6 }} />
          </View>
        ))}
      </View>

      <View style={styles.xp}>
        <View style={styles.xpHeader}>
          <Skeleton width={110} height={12} borderRadius={6} />
          <Skeleton width={70} height={12} borderRadius={6} />
        </View>
        <Skeleton width="100%" height={10} borderRadius={5} />
      </View>
    </View>
  );
};

/** The Photo | Video (| Saved) bar, same box as ProfileTabs. */
export const ProfileTabsSkeleton = ({ tabs = 2 }: { tabs?: number }) => {
  const { base } = useSkeletonColors();
  return (
    <View style={[styles.tabs, { borderColor: base }]}>
      {Array.from({ length: tabs }).map((_, i) => (
        <View key={i} style={styles.tab}>
          <Skeleton width={24} height={24} borderRadius={6} />
          <Skeleton width={38} height={10} borderRadius={5} style={{ marginTop: 6 }} />
        </View>
      ))}
    </View>
  );
};

/**
 * Loading state for the list under the tabs: battle cards, like the real list.
 * (Name kept for the existing call sites.)
 */
export const PostGridSkeleton = ({ count = 2 }: { count?: number }) => (
  <View style={styles.list}>
    {Array.from({ length: count }).map((_, i) => (
      <PostSkeleton key={i} />
    ))}
  </View>
);

/** The whole profile while it loads: header, tabs, then cards. */
export const ProfileScreenSkeleton = ({ isOwnProfile = false }: { isOwnProfile?: boolean }) => (
  <>
    <ProfileHeaderSkeleton isOwnProfile={isOwnProfile} />
    <ProfileTabsSkeleton tabs={isOwnProfile ? 3 : 2} />
    <PostGridSkeleton />
  </>
);

const styles = StyleSheet.create({
  // ProfileHeader.container
  container: { paddingBottom: 20, width: '100%' },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, height: 56 },
  topSlot: { width: 40 },
  avatarWrap: { alignSelf: 'center', marginTop: 10, alignItems: 'center' },
  avatarRing: { width: 110, height: 110, borderRadius: 55, borderWidth: 1, padding: 4, alignItems: 'center', justifyContent: 'center' },
  levelPill: { position: 'absolute', bottom: -2 },
  info: { alignItems: 'center', marginTop: 15, paddingHorizontal: 20 },
  buttons: { marginTop: 20, flexDirection: 'row', justifyContent: 'center', gap: 12 },
  stats: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 25 },
  statItem: { alignItems: 'center', flex: 1 },
  xp: { marginTop: 20, paddingHorizontal: 30, width: '100%' },
  xpHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  // ProfileTabs
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderBottomWidth: 1 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  list: { paddingTop: 12 },
});
