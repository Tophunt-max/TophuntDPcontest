import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Skeleton, SkeletonCircle } from '@/src/components/ui/Skeleton';
import { OPEN_CARD_W } from './OpenBattleCard';
import { PAD, useExplorePalette } from './theme';

/**
 * Loading placeholders for the Explore cards. Each one is drawn on the same
 * bordered card as the real component (palette.card + 1px palette.border) and
 * sized from the same numbers, so a rail or grid does not jump on load.
 */

/** BattleTile: media of width × 0.78, then the title + meta info block (~57). */
export function BattleTileSkeleton({ width }: { width: number }) {
  const p = useExplorePalette();
  return (
    <View style={[styles.tile, { width, backgroundColor: p.card, borderColor: p.border }]}>
      <Skeleton width="100%" height={Math.round(width * 0.78)} borderRadius={0} />
      <View style={styles.tileInfo}>
        <Skeleton width="72%" height={13} borderRadius={6} />
        <View style={styles.tileMeta}>
          <Skeleton width={36} height={11} borderRadius={5} />
          <Skeleton width={34} height={15} borderRadius={8} />
        </View>
      </View>
    </View>
  );
}

/** OpenBattleCard: two 0.85-aspect slots around a VS orb, name, title, meta, CTA (~265). */
export function OpenBattleCardSkeleton({ width = OPEN_CARD_W }: { width?: number }) {
  const p = useExplorePalette();
  return (
    <View style={[styles.open, { width, backgroundColor: p.card, borderColor: p.border }]}>
      <View style={styles.openBody}>
        <View style={styles.openSlot}>
          <Skeleton width="100%" height="100%" borderRadius={14} />
        </View>
        <SkeletonCircle size={32} style={[styles.openVs, { borderColor: p.card }]} />
        <View style={styles.openSlot}>
          <Skeleton width="100%" height="100%" borderRadius={14} />
        </View>
      </View>
      <View style={styles.openName}>
        <SkeletonCircle size={20} />
        <Skeleton width={90} height={12} borderRadius={6} />
      </View>
      <Skeleton width="62%" height={14} borderRadius={6} style={{ marginTop: 6 }} />
      <View style={styles.openMeta}>
        <Skeleton width={64} height={11} borderRadius={5} />
        <Skeleton width={48} height={11} borderRadius={5} />
      </View>
      <Skeleton width="100%" height={37} borderRadius={12} style={{ marginTop: 10 }} />
    </View>
  );
}

/** CreatorChip: 69 ring, name, wins (78 wide). */
export function CreatorChipSkeleton() {
  return (
    <View style={styles.creator}>
      <SkeletonCircle size={69} />
      <Skeleton width={56} height={12} borderRadius={6} style={{ marginTop: 12 }} />
      <Skeleton width={40} height={10} borderRadius={5} style={{ marginTop: 3 }} />
    </View>
  );
}

/** PersonCard: 72 ring, name, handle, followers, full-width Follow pill (~205). */
export function PersonCardSkeleton({ width }: { width: number }) {
  const p = useExplorePalette();
  return (
    <View style={[styles.person, { width, backgroundColor: p.card, borderColor: p.border }]}>
      <SkeletonCircle size={72} />
      <Skeleton width="70%" height={14} borderRadius={6} style={{ marginTop: 11 }} />
      <Skeleton width="50%" height={11} borderRadius={5} style={{ marginTop: 5 }} />
      <Skeleton width="44%" height={10} borderRadius={5} style={{ marginTop: 5 }} />
      <Skeleton width="100%" height={33} borderRadius={100} style={{ marginTop: 13 }} />
    </View>
  );
}

/** A horizontal rail with the same padding and gap as the real FlatList rails. */
export function SkeletonRail({ children, gap = 12 }: { children: React.ReactNode; gap?: number }) {
  return <View style={[styles.rail, { gap }]}>{children}</View>;
}

/** Render `count` copies of a skeleton (keys handled here). */
export function repeat(count: number, render: (i: number) => React.ReactNode) {
  return Array.from({ length: count }, (_, i) => <React.Fragment key={i}>{render(i)}</React.Fragment>);
}

const styles = StyleSheet.create({
  rail: { flexDirection: 'row', paddingHorizontal: PAD, overflow: 'hidden' },
  tile: { borderRadius: 20, borderWidth: 1, overflow: 'hidden' },
  tileInfo: { paddingHorizontal: 10, paddingVertical: 9, height: 55 },
  tileMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 7 },
  open: { borderRadius: 22, borderWidth: 1, padding: 12 },
  openBody: { flexDirection: 'row', alignItems: 'center' },
  openSlot: { flex: 1, aspectRatio: 0.85 },
  openVs: { marginHorizontal: -8, zIndex: 2, borderWidth: 2 },
  openName: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  openMeta: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 7 },
  creator: { width: 78, alignItems: 'center' },
  person: { borderRadius: 20, borderWidth: 1, padding: 14, alignItems: 'center' },
});
