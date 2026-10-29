/**
 * TopHunt gamification artwork, drawn as SVG (react-native-svg, already used by
 * DiamondIcon / VerifiedBadge). Vector instead of PNG/WebP because these are
 * geometric emblems: they stay sharp at every size and density, keep a
 * transparent background, follow light/dark themes through props, and remain
 * editable as source. All drawings are original TopHunt shapes.
 *
 * Each vector id here is listed in `VECTOR_IDS` (src/lib/gamificationAssets.ts);
 * test/gamificationAssets.test.ts fails if one is missing.
 */
import React, { useId } from 'react';
import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { TIERS, type TierId, type TierStyle } from '@/src/lib/gamificationAssets';

/** Unique gradient ids: two emblems on one screen must not share a <Defs> id on web. */
function useGradId(prefix: string) {
  const raw = useId();
  return `${prefix}${raw.replace(/[^a-zA-Z0-9]/g, '')}`;
}

function Grad({ id, colors, vertical = true }: { id: string; colors: [string, string]; vertical?: boolean }) {
  return (
    <Defs>
      <LinearGradient id={id} x1="0" y1="0" x2={vertical ? '0' : '1'} y2={vertical ? '1' : '0'}>
        <Stop offset="0" stopColor={colors[0]} />
        <Stop offset="1" stopColor={colors[1]} />
      </LinearGradient>
    </Defs>
  );
}

/** Four-point XP spark: the app-wide XP symbol. */
export function XpStar({ size = 20, color = '#FFB300' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      <Path d="M12 1.5 L14.6 9.4 L22.5 12 L14.6 14.6 L12 22.5 L9.4 14.6 L1.5 12 L9.4 9.4 Z" fill={color} />
      <Path d="M12 6 L13.2 10.8 L18 12 L13.2 13.2 L12 18 L10.8 13.2 L6 12 L10.8 10.8 Z" fill="#FFFFFF" opacity={0.45} />
      <Circle cx="19.5" cy="4.5" r="1.6" fill={color} opacity={0.8} />
    </Svg>
  );
}

/** Emblem outline per tier silhouette, on a 48×48 canvas. */
const SHAPES: Record<TierStyle['shape'], string> = {
  circle: 'M24 3 A21 21 0 1 1 23.99 3 Z',
  hexagon: 'M24 2 L43 13 L43 35 L24 46 L5 35 L5 13 Z',
  shield: 'M24 2 L43 9 L43 24 C43 35 34 42 24 46 C14 42 5 35 5 24 L5 9 Z',
  crest: 'M24 2 L30 8 L43 8 L43 26 C43 36 34 43 24 46 C14 43 5 36 5 26 L5 8 L18 8 Z',
  star: 'M24 2 L29.5 15 L44 16 L33 26 L36.5 41 L24 33.5 L11.5 41 L15 26 L4 16 L18.5 15 Z',
  gem: 'M14 5 H34 L44 17 L24 45 L4 17 Z',
  crown: 'M5 14 L15 22 L24 6 L33 22 L43 14 L40 40 L8 40 Z',
};

/**
 * A rank emblem. The level NUMBER is not part of the artwork: LevelBadge draws
 * it on top, so one emblem serves every level (no 100 per-level images).
 */
export function Emblem({
  tier = 'starter',
  size = 40,
  muted = false,
}: {
  tier?: TierId;
  size?: number;
  /** Locked / unavailable: drawn in grey, so the state does not rely on colour. */
  muted?: boolean;
}) {
  const t = TIERS[tier] ?? TIERS.starter;
  const id = useGradId('emb');
  const colors: [string, string] = muted ? ['#D5D9DE', '#8D96A0'] : t.colors;
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityElementsHidden importantForAccessibility="no">
      <Grad id={id} colors={colors} />
      <Path d={SHAPES[t.shape]} fill={`url(#${id})`} stroke="#FFFFFF" strokeOpacity={0.85} strokeWidth={2} strokeLinejoin="round" />
      {/* inner bevel */}
      <Path d={SHAPES[t.shape]} fill="none" stroke="#000000" strokeOpacity={0.12} strokeWidth={1} transform="translate(24 24) scale(0.82) translate(-24 -24)" />
      {/* top highlight */}
      <Path d="M12 12 C18 8 30 8 36 12" stroke="#FFFFFF" strokeOpacity={0.5} strokeWidth={2} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

/**
 * A circular frame ring around an avatar of diameter `size`. The ring sits
 * OUTSIDE the avatar circle (stroke drawn in the extra padding), so it never
 * covers the face; ornaments sit on the ring at the top only.
 */
export function FrameRing({
  tier = 'bronze',
  size,
  thickness,
  shape = 'circle',
  cornerRadius,
}: {
  tier?: TierId;
  size: number;
  thickness?: number;
  /** `rounded`: for square avatar layouts (grid tiles, cards). */
  shape?: 'circle' | 'rounded';
  /** Corner radius of the AVATAR for `rounded`; the frame follows it outside. */
  cornerRadius?: number;
}) {
  const t = TIERS[tier] ?? TIERS.bronze;
  const id = useGradId('frm');
  const th = thickness ?? Math.max(3, Math.round(size * 0.06));
  const outer = size + th * 2;
  const c = outer / 2;
  const r = c - th / 2;
  const ornaments = tier === 'gold' || tier === 'champion' || tier === 'diamond' || tier === 'legendary' || tier === 'max';
  return (
    <Svg width={outer} height={outer} viewBox={`0 0 ${outer} ${outer}`} accessibilityElementsHidden importantForAccessibility="no" style={{ position: 'absolute', top: 0, left: 0 }}>
      <Grad id={id} colors={t.colors} vertical={false} />
      {shape === 'rounded' ? (
        <Rect
          x={th / 2}
          y={th / 2}
          width={outer - th}
          height={outer - th}
          rx={(cornerRadius ?? size * 0.2) + th / 2}
          stroke={`url(#${id})`}
          strokeWidth={th}
          fill="none"
        />
      ) : (
        <>
          <Circle cx={c} cy={c} r={r} stroke={`url(#${id})`} strokeWidth={th} fill="none" />
          <Circle cx={c} cy={c} r={r + th / 2 - 0.5} stroke="#FFFFFF" strokeOpacity={0.35} strokeWidth={1} fill="none" />
        </>
      )}
      {shape === 'circle' && (tier === 'silver' || tier === 'bronze')
        ? [0, 90, 180, 270].map((deg) => {
            const a = (deg * Math.PI) / 180;
            return <Circle key={deg} cx={c + r * Math.cos(a)} cy={c + r * Math.sin(a)} r={th * 0.55} fill="#FFFFFF" opacity={0.7} />;
          })
        : null}
      {ornaments ? (
        <G transform={`translate(${c} ${th * 0.4}) scale(${th / 6})`}>
          {tier === 'gold' ? (
            <Path d="M0 -4 L2.4 1.8 L-2.4 1.8 Z M-6 2 L6 2 L4.5 5 L-4.5 5 Z" fill="#FFF8E1" />
          ) : tier === 'diamond' ? (
            <Path d="M-4 -5 H4 L7 -1 L0 6 L-7 -1 Z" fill="#E0F7FF" stroke={t.colors[1]} strokeWidth={0.8} />
          ) : tier === 'champion' ? (
            <Path d="M0 -6 L1.8 -1.8 L6 -1.6 L2.7 1.2 L3.8 5.4 L0 3 L-3.8 5.4 L-2.7 1.2 L-6 -1.6 L-1.8 -1.8 Z" fill="#EDE7FF" />
          ) : (
            <Path d="M-7 4 L-5 -3 L-2 0.5 L0 -6 L2 0.5 L5 -3 L7 4 Z" fill="#FFF3E0" stroke={t.colors[1]} strokeWidth={0.8} />
          )}
        </G>
      ) : null}
    </Svg>
  );
}

/** Padlock disc used for locked achievements, cosmetics and rewards. */
export function LockBadge({ size = 40, color = '#9AA3AD', background = '#EEF0F3' }: { size?: number; color?: string; background?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40" accessibilityElementsHidden importantForAccessibility="no">
      <Circle cx="20" cy="20" r="19" fill={background} stroke={color} strokeOpacity={0.4} strokeWidth={1.5} strokeDasharray="3 3" />
      <Rect x="12.5" y="18" width="15" height="11" rx="2.5" fill={color} />
      <Path d="M15 18 V15 A5 5 0 0 1 25 15 V18" stroke={color} strokeWidth={2.4} fill="none" strokeLinecap="round" />
      <Circle cx="20" cy="23.2" r="1.6" fill={background} />
    </Svg>
  );
}

/** Trophy cup: Hall of Fame and first win. */
export function Trophy({ size = 40, color = '#FFB300' }: { size?: number; color?: string }) {
  const id = useGradId('tro');
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40" accessibilityElementsHidden importantForAccessibility="no">
      <Grad id={id} colors={['#FFE082', color]} />
      <Path d="M11 5 H29 V13 A9 9 0 0 1 11 13 Z" fill={`url(#${id})`} />
      <Path d="M11 8 H6 V11 A6 6 0 0 0 12 17 M29 8 H34 V11 A6 6 0 0 1 28 17" stroke={color} strokeWidth={2} fill="none" strokeLinecap="round" />
      <Rect x="18" y="21" width="4" height="7" fill={color} />
      <Rect x="12" y="28" width="16" height="5" rx="1.5" fill={color} />
      <Path d="M15 8 C15 12 17 14 19 15" stroke="#FFFFFF" strokeOpacity={0.55} strokeWidth={1.8} fill="none" strokeLinecap="round" />
    </Svg>
  );
}

/** Gift box: a reward waiting to be claimed. */
export function RewardGift({ size = 40, color = '#FF4D67' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40" accessibilityElementsHidden importantForAccessibility="no">
      <Rect x="6" y="16" width="28" height="19" rx="3" fill={color} />
      <Rect x="4" y="11" width="32" height="7" rx="2" fill={color} opacity={0.85} />
      <Rect x="18" y="11" width="4" height="24" fill="#FFFFFF" opacity={0.85} />
      <Path d="M20 11 C16 4 9 6 12 10 C13.5 11.5 17 11 20 11 C23 11 26.5 11.5 28 10 C31 6 24 4 20 11 Z" fill="#FFD54F" />
    </Svg>
  );
}

/** Empty-state illustration: an open box with sparkles. */
export function EmptyInventory({ size = 96, color = '#9AA3AD' }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 96 96" accessibilityElementsHidden importantForAccessibility="no">
      <Path d="M18 44 L48 56 L78 44 L78 76 L48 88 L18 76 Z" fill={color} opacity={0.25} />
      <Path d="M18 44 L48 56 L78 44" stroke={color} strokeWidth={2.5} fill="none" strokeLinejoin="round" />
      <Path d="M18 44 L10 32 L40 22 L48 34 M78 44 L86 32 L56 22 L48 34" stroke={color} strokeWidth={2.5} fill="none" strokeLinejoin="round" />
      <Path d="M48 56 V88" stroke={color} strokeWidth={2.5} />
      <Path d="M48 6 L50 12 L56 14 L50 16 L48 22 L46 16 L40 14 L46 12 Z" fill="#FFB300" />
      <Path d="M70 12 L71.3 15.7 L75 17 L71.3 18.3 L70 22 L68.7 18.3 L65 17 L68.7 15.7 Z" fill="#FF4D67" />
      <Circle cx="28" cy="16" r="2.5" fill="#29B6F6" />
    </Svg>
  );
}
