import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { frameAsset, frameTier } from '@/src/lib/gamificationAssets';
import { FrameRing } from './vectors';

/**
 * A cosmetic frame around an avatar of diameter `size`. The ring is drawn in
 * the padding OUTSIDE the avatar, so it never covers the face or shifts the
 * photo's crop. Purely visual.
 *
 * An animated frame pulses gently. It stays still when the OS asks for reduced
 * motion, and when `paused` (e.g. the row is off-screen).
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
  const animated = !!frame?.asset?.animated && !reduce && !paused;
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (animated) pulse.value = withRepeat(withTiming(1.035, { duration: 1400, easing: Easing.inOut(Easing.ease) }), -1, true);
    else {
      cancelAnimation(pulse);
      pulse.value = 1;
    }
    return () => cancelAnimation(pulse);
  }, [animated, pulse]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
  const th = Math.max(3, Math.round(size * 0.06));
  const outer = size + th * 2;
  const radius = shape === 'circle' ? outer / 2 : size * 0.2 + th;
  const tier = frameTier(frame);

  if (!frame || !tier) {
    return (
      <View style={[styles.center, { width: outer, height: outer, borderRadius: radius, borderWidth: 1, borderColor: fallbackBorder }]}>
        {children}
      </View>
    );
  }
  return (
    <Animated.View
      style={[{ width: outer, height: outer }, style]}
      accessible
      accessibilityLabel={`${frame.name}${frameAsset(frame)?.label ? ` (${frameAsset(frame)!.label})` : ''}`}
    >
      <FrameRing tier={tier.id} size={size} thickness={th} shape={shape} cornerRadius={size * 0.2} />
      <View style={[styles.center, { width: outer, height: outer }]}>{children}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { justifyContent: 'center', alignItems: 'center' },
});
