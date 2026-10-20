import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@/src/lib/icons';
import { CoinIcon } from '@/src/components/ui/CoinIcon';
import { matchPrize } from '@/src/lib/contestPrize';
import { timeLeftLabel } from '@/src/lib/shareCaptions';
import { compactCount, participantThumb } from '@/src/lib/exploreMedia';
import { ScaleTouchable } from './ScaleTouchable';
import { GOLD, gradForType, type ExplorePalette } from './theme';

/**
 * A live head-to-head battle as a tile: both entries side by side, a VS badge,
 * time left, votes and the prize. Used by Trending, Ending soon, the Explore grid
 * and "See all". Tapping opens the battle, where voting happens (public — guests
 * are asked to sign in only when they vote).
 *
 * No countdown hook per tile: the label is computed at render and the lists
 * refetch every 30s, so a grid of 40 tiles does not run 40 timers.
 */
export const BattleTile = React.memo(function BattleTile({
  item,
  width,
  palette,
  emphasis,
}: {
  item: any;
  width: number;
  palette: ExplorePalette;
  /** "ending" highlights the time left in red. */
  emphasis?: 'ending' | 'trending';
}) {
  const router = useRouter();
  const a = participantThumb(item.userA, item.type);
  const b = participantThumb(item.userB, item.type);
  const isVideo = item.type === 'video';
  const left = timeLeftLabel(item.expiresAt);
  const prize = matchPrize(item);
  const grad = gradForType(item.type);
  const mediaH = Math.round(width * 0.78);
  const title = item.title || (isVideo ? 'Video battle' : 'Photo battle');
  const nameA = item.userA?.username || 'player';
  const nameB = item.userB?.username || 'player';

  return (
    <ScaleTouchable
      style={[styles.card, { width, backgroundColor: palette.card, borderColor: palette.border }]}
      onPress={() => router.push(`/battle/${item.id}` as any)}
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${nameA} versus ${nameB}, ${item.totalVotes || 0} votes${left ? `, ${left} left` : ''}`}
    >
      <View style={[styles.media, { height: mediaH }]}>
        <Side uri={a} grad={grad} isVideo={isVideo} />
        <View style={[styles.divider, { backgroundColor: palette.card }]} />
        <Side uri={b} grad={grad} isVideo={isVideo} />
        <LinearGradient colors={['rgba(0,0,0,0.35)', 'transparent', 'rgba(0,0,0,0.55)']} style={StyleSheet.absoluteFill} pointerEvents="none" />

        <View style={styles.topRow} pointerEvents="none">
          <View style={[styles.pill, emphasis === 'ending' && left ? { backgroundColor: 'rgba(220,38,38,0.92)' } : null]}>
            {emphasis === 'ending' ? (
              <Ionicons name="time" size={10} color="#FFF" />
            ) : (
              <View style={styles.liveDot} />
            )}
            <Text style={styles.pillText}>{emphasis === 'ending' && left ? left : 'LIVE'}</Text>
          </View>
          {isVideo && (
            <View style={styles.pill}>
              <Ionicons name="videocam" size={10} color="#FFF" />
            </View>
          )}
        </View>

        <LinearGradient colors={grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.vs, { top: mediaH / 2 - 15 }]}>
          <Text style={styles.vsText}>VS</Text>
        </LinearGradient>

        <View style={styles.bottomRow} pointerEvents="none">
          <Text style={styles.handle} numberOfLines={1}>@{nameA}</Text>
          <Text style={[styles.handle, { textAlign: 'right' }]} numberOfLines={1}>@{nameB}</Text>
        </View>
      </View>

      <View style={styles.info}>
        <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>{title}</Text>
        <View style={styles.metaRow}>
          <MaterialCommunityIcons name="vote" size={13} color={palette.sub} />
          <Text style={[styles.meta, { color: palette.sub }]}>{compactCount(item.totalVotes)}</Text>
          {emphasis !== 'ending' && left ? (
            <>
              <Text style={[styles.meta, { color: palette.sub }]}>·</Text>
              <Ionicons name="time-outline" size={12} color={palette.sub} />
              <Text style={[styles.meta, { color: palette.sub }]} numberOfLines={1}>{left}</Text>
            </>
          ) : null}
          <View style={{ flex: 1 }} />
          {prize.type === 'product' ? (
            <MaterialCommunityIcons name="gift" size={13} color={GOLD} />
          ) : prize.coins > 0 ? (
            <View style={styles.prize}>
              <CoinIcon size={11} color={GOLD} />
              <Text style={styles.prizeText}>{compactCount(prize.coins)}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </ScaleTouchable>
  );
});

function Side({ uri, grad, isVideo }: { uri: string | null; grad: [string, string]; isVideo: boolean }) {
  return (
    <View style={styles.side}>
      {uri ? (
        <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} cachePolicy="memory-disk" recyclingKey={uri} />
      ) : (
        <LinearGradient colors={grad} style={[StyleSheet.absoluteFill, styles.center]}>
          <Ionicons name={isVideo ? 'play' : 'image'} size={22} color="rgba(255,255,255,0.85)" />
        </LinearGradient>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 20,
    borderWidth: 1,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
  media: { flexDirection: 'row', position: 'relative' },
  side: { flex: 1, overflow: 'hidden' },
  divider: { width: 2 },
  center: { alignItems: 'center', justifyContent: 'center' },
  topRow: { position: 'absolute', top: 8, left: 8, right: 8, flexDirection: 'row', justifyContent: 'space-between' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 100,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FF4D67' },
  pillText: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Black', letterSpacing: 0.4 },
  vs: {
    position: 'absolute',
    left: '50%',
    marginLeft: -15,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#FFF',
  },
  vsText: { color: '#FFF', fontFamily: 'Urbanist-Black', fontSize: 11, fontStyle: 'italic' },
  bottomRow: { position: 'absolute', left: 8, right: 8, bottom: 6, flexDirection: 'row', gap: 10 },
  handle: { flex: 1, color: '#FFF', fontSize: 11, fontFamily: 'Urbanist-Bold' },
  info: { paddingHorizontal: 10, paddingVertical: 9 },
  title: { fontSize: 13, fontFamily: 'Urbanist-Bold' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  meta: { fontSize: 11, fontFamily: 'Urbanist-SemiBold' },
  prize: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(245,158,11,0.14)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 100 },
  prizeText: { color: GOLD, fontSize: 11, fontFamily: 'Urbanist-Black' },
});
