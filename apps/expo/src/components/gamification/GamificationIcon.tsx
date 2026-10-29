import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@/src/lib/icons';
import { resolveAsset, type AssetDef, type AssetKey, type TierId, type VectorId } from '@/src/lib/gamificationAssets';
import { Emblem, EmptyInventory, FrameRing, LockBadge, RewardGift, Trophy, XpStar } from './vectors';

/**
 * Render any manifest asset by key (or an already-resolved def). Unknown keys
 * fall back to the generic asset, so a renamed or missing key shows a neutral
 * star instead of a blank or a crash.
 */
export function GamificationIcon({
  assetKey,
  def,
  size = 24,
  color,
  muted = false,
}: {
  assetKey?: AssetKey | string | null;
  def?: AssetDef;
  size?: number;
  /** Overrides the manifest colour (e.g. white on a gradient). */
  color?: string;
  muted?: boolean;
}) {
  const d = def ?? resolveAsset(assetKey ?? null);
  const tint = muted ? '#9AA3AD' : color ?? d.color;
  if (d.kind === 'icon') {
    return (
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Ionicons name={d.icon} size={size} color={tint} />
      </View>
    );
  }
  return <Vector id={d.vector} size={size} color={tint} tier={d.tier} muted={muted} />;
}

function Vector({ id, size, color, tier, muted }: { id: VectorId; size: number; color: string; tier?: TierId; muted: boolean }) {
  switch (id) {
    case 'xpStar':
      return <XpStar size={size} color={color} />;
    case 'emblem':
      return <Emblem tier={tier} size={size} muted={muted} />;
    case 'frameRing':
      return (
        <View style={{ width: size, height: size }}>
          <FrameRing tier={tier} size={size * 0.78} thickness={Math.max(2, size * 0.11)} />
        </View>
      );
    case 'lockBadge':
      return <LockBadge size={size} color={color} />;
    case 'trophy':
      return <Trophy size={size} color={color} />;
    case 'emptyInventory':
      return <EmptyInventory size={size} color={color} />;
    case 'rewardGift':
      return <RewardGift size={size} color={color} />;
    default: {
      // Exhaustiveness: adding a VectorId without drawing it fails typecheck.
      const never: never = id;
      return never;
    }
  }
}
