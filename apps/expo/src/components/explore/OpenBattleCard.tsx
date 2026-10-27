import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AppImage } from '@/src/components/ui/AppImage';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons, MaterialCommunityIcons } from '@/src/lib/icons';
import { DiamondIcon } from '@/src/components/ui/DiamondIcon';
import { Avatar } from '@/src/components/ui/Avatar';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';
import { entryFeePerPlayer } from '@/src/lib/contestPricing';
import { matchPrize } from '@/src/lib/contestPrize';
import { participantAvatar, participantThumb } from '@/src/lib/exploreMedia';
import { ScaleTouchable } from './ScaleTouchable';
import { GOLD, colorForType, gradForType, type ExplorePalette } from './theme';

export const OPEN_CARD_W = 248;

/**
 * A battle waiting for a challenger: the creator's entry against an empty,
 * dashed "your spot" slot, the prize, the entry fee and a Join CTA. The parent
 * decides what Join does (auth gate, own-battle toast, routing).
 */
export const OpenBattleCard = React.memo(function OpenBattleCard({
  item,
  isMine,
  palette,
  onJoin,
  width = OPEN_CARD_W,
}: {
  item: any;
  isMine: boolean;
  palette: ExplorePalette;
  onJoin: (item: any) => void;
  width?: number;
}) {
  const isVideo = item.type === 'video';
  const grad = gradForType(item.type);
  const accent = colorForType(item.type);
  const thumb = participantThumb(item.userA, item.type);
  const prize = matchPrize(item);
  const fee = entryFeePerPlayer(item);
  const title = item.title || (isVideo ? 'Video battle' : 'Photo battle');

  return (
    <ScaleTouchable
      style={[styles.card, { width, backgroundColor: palette.card, borderColor: palette.border }]}
      onPress={() => onJoin(item)}
      accessibilityRole="button"
      accessibilityLabel={`${title} by ${item.userA?.username || 'a player'}, entry ${fee} coins. ${isMine ? 'Your battle, waiting for a rival' : 'Join battle'}`}
    >
      <View style={styles.body}>
        <View style={styles.photo}>
          {thumb ? (
            <AppImage source={{ uri: thumb }} displayWidth={width} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} />
          ) : (
            <LinearGradient colors={grad} style={[StyleSheet.absoluteFill, styles.center]}>
              <Ionicons name={isVideo ? 'play' : 'image'} size={22} color="#FFF" />
            </LinearGradient>
          )}
          <View style={[styles.corner, { backgroundColor: accent }]}>
            <Text style={styles.cornerText}>P1</Text>
          </View>
        </View>
        <LinearGradient colors={grad} style={styles.vs}>
          <Text style={styles.vsText}>VS</Text>
        </LinearGradient>
        <View style={[styles.photo, styles.empty, { borderColor: accent, backgroundColor: palette.isDark ? '#1B1D26' : '#FFF4F5' }]}>
          <MaterialCommunityIcons name="sword-cross" size={22} color={accent} />
          <Text style={[styles.emptyText, { color: accent }]}>{isMine ? 'Awaiting\nrival' : 'Your\nspot'}</Text>
        </View>
      </View>

      <View style={styles.nameRow}>
        <Avatar uri={participantAvatar(item.userA)} name={item.userA?.username} size={20} />
        <Text style={[styles.name, { color: palette.text }]} numberOfLines={1}>@{item.userA?.username || 'player'}</Text>
        <VerifiedBadge verified={item.userA?.verified} size={12} />
      </View>
      <Text style={[styles.title, { color: palette.text }]} numberOfLines={1}>{title}</Text>
      <View style={styles.metaRow}>
        {fee > 0 ? <DiamondIcon size={11} color={palette.sub} /> : null}
        <Text style={[styles.meta, { color: palette.sub }]}>{fee > 0 ? `Entry ${fee}` : 'Free entry'}</Text>
        <View style={{ flex: 1 }} />
        {prize.type === 'product' ? (
          <Text style={styles.prize} numberOfLines={1}>🎁 {prize.product.title}</Text>
        ) : prize.coins > 0 ? (
          <Text style={styles.prize}>Win {prize.coins}</Text>
        ) : null}
      </View>
      <LinearGradient colors={isMine ? ['#9AA0AA', '#7E848E'] : grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.cta}>
        <Ionicons name={isMine ? 'hourglass' : 'flash'} size={14} color="#FFF" />
        <Text style={styles.ctaText}>{isMine ? 'Waiting for a rival' : 'Join battle'}</Text>
      </LinearGradient>
    </ScaleTouchable>
  );
});

const styles = StyleSheet.create({
  card: { borderRadius: 22, borderWidth: 1, padding: 12 },
  body: { flexDirection: 'row', alignItems: 'center' },
  photo: { flex: 1, aspectRatio: 0.85, borderRadius: 14, overflow: 'hidden' },
  center: { alignItems: 'center', justifyContent: 'center' },
  corner: { position: 'absolute', top: 6, left: 6, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  cornerText: { color: '#FFF', fontSize: 9, fontFamily: 'Urbanist-Black' },
  vs: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginHorizontal: -8,
    zIndex: 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#FFF',
  },
  vsText: { color: '#FFF', fontFamily: 'Urbanist-Black', fontSize: 11, fontStyle: 'italic' },
  empty: { borderWidth: 2, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center', gap: 4 },
  emptyText: { fontSize: 10, fontFamily: 'Urbanist-Bold', textAlign: 'center' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  name: { fontSize: 12, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  title: { fontSize: 14, fontFamily: 'Urbanist-Bold', marginTop: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  meta: { fontSize: 11, fontFamily: 'Urbanist-SemiBold' },
  prize: { color: GOLD, fontSize: 11, fontFamily: 'Urbanist-Black', maxWidth: 110 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 12, marginTop: 10 },
  ctaText: { color: '#FFF', fontSize: 13, fontFamily: 'Urbanist-Bold' },
});
