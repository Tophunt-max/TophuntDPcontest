import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { frameAsset, frameTier } from '@/src/lib/gamificationAssets';
import { useScreenActive } from '@/src/hooks/useScreenActive';
import { FrameRing } from './vectors';

/** Tiers that get the shimmer when equipped. */
const SHIMMER_TIERS = new Set(['champion', 'diamond', 'legendary', 'max']);

/**
 * A cosmetic frame around an avatar of diameter `size`. The ring is drawn in
 * the padding OUTSIDE the avatar, so it never covers the face, and the outer
 * box has a fixed size whether or not a frame is equipped — changing frames
 * cross-fades the ring without moving anything else on the profile.
 *
 * Motion (all off under reduced motion, and paused while the screen is not
 * focused or the app is backgrounded):
 *   - animated frames pulse gently;
 *   - high-tier frames carry a slow highlight travelling round the ring
 *     (a rotating transform — no layout work per frame).
 */
export function ProfileFrame({
  frame,
  size,
  children,
  fallbackBorder,
  shape = 'circle',
  paused = false,
}: {
  frame: { id?: string; name: string; rarity?: string; asset: Record<string, any> } | null | undefined;
  size: number;
  children: React.ReactNode;
  fallbackBorder: string;
  shape?: 'circle' | 'rounded';
  paused?: boolean;
}) {
  const reduce = useReducedMotion();
  const active = useScreenActive();
  const tier = frameTier(frame);
  const running = !reduce && !paused && active;
  const pulseOn = running && !!frame?.asset?.animated;
  const shimmerOn = running && !!tier && SHIMMER_TIERS.has(tier.id) && shape === 'circle';

  const pulse = useSharedValue(1);
  const spin = useSharedValue(0);
  useEffect(() => {
    if (pulseOn) pulse.value = withRepeat(withTiming(1.035, { duration: 1400, easing: Easing.inOut(Easing.ease) }), -1, true);
    else {
      cancelAnimation(pulse);
      pulse.value = 1;
    }
    if (shimmerOn) {
      // One lap, then a rest, repeated — mostly still, never busy.
      spin.value = 0;
      spin.value = withRepeat(withSequence(withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.quad) }), withTiming(1, { duration: 2400 }), withTiming(0, { duration: 0 })), -1);
    } else {
      cancelAnimation(spin);
      spin.value = 0;
    }
    return () => {
      cancelAnimation(pulse);
      cancelAnimation(spin);
    };
  }, [pulseOn, shimmerOn, pulse, spin]);
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
  const shimmerStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }], opacity: spin.value > 0 && spin.value < 1 ? 1 : 0 }));

  const th = Math.max(3, Math.round(size * 0.06));
  const outer = size + th * 2;
  const radius = shape === 'circle' ? outer / 2 : size * 0.2 + th;

  return (
    <View style={{ width: outer, height: outer }}>
      {frame && tier ? (
        <Animated.View
          key={frame.id ?? frame.name}
          entering={reduce ? undefined : FadeIn.duration(300)}
          style={[StyleSheet.absoluteFill, pulseStyle]}
          accessible
          accessibilityLabel={`${frame.name}${frameAsset(frame)?.label ? ` (${frameAsset(frame)!.label})` : ''}`}
        >
          <FrameRing tier={tier.id} size={size} thickness={th} shape={shape} cornerRadius={size * 0.2} />
          {shimmerOn ? (
            <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, shimmerStyle]}>
              <View style={[styles.glint, { width: th * 1.6, height: th * 1.6, borderRadius: th, left: outer / 2 - th * 0.8, top: -th * 0.3 }]} />
            </Animated.View>
          ) : null}
        </Animated.View>
      ) : (
        <View style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: 1, borderColor: fallbackBorder }]} />
      )}
      <View style={[StyleSheet.absoluteFill, styles.center]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center', alignItems: 'center' },
  glint: { position: 'absolute', backgroundColor: '#FFFFFF', opacity: 0.85, shadowColor: '#FFFFFF', shadowOpacity: 0.9, shadowRadius: 4 },
});
