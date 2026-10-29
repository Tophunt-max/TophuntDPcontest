import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@/src/lib/icons';
import {
  BADGE_SIZES,
  TIERS,
  levelFontSize,
  tierForRank,
  type BadgeSize,
  type BadgeState,
} from '@/src/lib/gamificationAssets';
import { Emblem } from './vectors';

/**
 * The level emblem: the rank's silhouette with the server level drawn on top.
 * One component for every level 1..max — no per-level images.
 *
 * States are shown by more than colour: locked/unavailable are grey AND carry a
 * lock glyph; equipped carries a check; every state is in the accessibility label.
 */
export function LevelBadge({
  level,
  rankId,
  rankName,
  isMaxLevel = false,
  size = 'md',
  state = 'earned',
  showRank = false,
}: {
  level: number;
  rankId?: string | null;
  rankName?: string | null;
  isMaxLevel?: boolean;
  size?: BadgeSize | number;
  state?: BadgeState;
  showRank?: boolean;
}) {
  const px = typeof size === 'number' ? size : BADGE_SIZES[size];
  const tier = tierForRank(rankId, { isMaxLevel });
  const muted = state === 'locked' || state === 'unavailable';
  const ink = muted ? '#FFFFFF' : TIERS[tier.id].ink;
  const label = `${isMaxLevel ? 'Maximum level' : `Level ${level}`}${rankName ? `, ${rankName}` : ''}${
    state === 'locked' ? ', locked' : state === 'unavailable' ? ', unavailable' : state === 'equipped' ? ', equipped' : ''
  }`;
  return (
    <View style={styles.row} accessible accessibilityRole="image" accessibilityLabel={label}>
      <View style={{ width: px, height: px, alignItems: 'center', justifyContent: 'center' }}>
        <Emblem tier={tier.id} size={px} muted={muted} />
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          {muted && px >= 28 ? (
            <Ionicons name="lock-closed" size={Math.round(px * 0.36)} color={ink} />
          ) : (
            <Text
              style={[styles.num, { color: ink, fontSize: levelFontSize(px, level, tier.shape), marginTop: tier.shape === 'crown' ? px * 0.12 : tier.shape === 'star' ? px * 0.06 : 0 }]}
              allowFontScaling={false}
              numberOfLines={1}
            >
              {level}
            </Text>
          )}
        </View>
        {state === 'equipped' ? (
          <View style={[styles.check, { width: px * 0.34, height: px * 0.34, borderRadius: px * 0.17 }]}>
            <Ionicons name="checkmark" size={Math.max(8, px * 0.24)} color="#FFFFFF" />
          </View>
        ) : null}
      </View>
      {showRank && rankName ? (
        <Text style={[styles.rank, { color: muted ? '#9AA3AD' : tier.colors[1] }]} numberOfLines={1}>
          {isMaxLevel ? `${rankName} · Max` : rankName}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  center: { alignItems: 'center', justifyContent: 'center' },
  num: { fontFamily: 'Urbanist-Black', textShadowColor: 'rgba(0,0,0,0.25)', textShadowRadius: 2, textShadowOffset: { width: 0, height: 1 } },
  rank: { fontSize: 13, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  check: { position: 'absolute', right: -2, bottom: -2, backgroundColor: '#22C55E', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#FFFFFF' },
});
