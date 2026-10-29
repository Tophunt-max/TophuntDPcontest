import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { XpStar } from './vectors';

/**
 * A short, local sparkle burst (no network: the battle-result confetti loads a
 * remote Lottie file, which fails offline). Plays once and stops — nothing
 * keeps animating after it. Renders nothing under reduced motion.
 */
const PARTICLES = [
  { a: -80, d: 46, c: '#FFD54F', s: 12 },
  { a: -30, d: 56, c: '#FF4D67', s: 10 },
  { a: 15, d: 50, c: '#7C4DFF', s: 12 },
  { a: 60, d: 44, c: '#29B6F6', s: 9 },
  { a: 110, d: 40, c: '#FFD54F', s: 8 },
  { a: 160, d: 48, c: '#FF7043', s: 10 },
  { a: 210, d: 42, c: '#22C55E', s: 9 },
  { a: 260, d: 50, c: '#FF4D67', s: 8 },
];

export function SparkleBurst({ playKey, size = 120 }: { playKey: string | number; size?: number }) {
  const reduce = useReducedMotion();
  if (reduce) return null;
  return (
    <View pointerEvents="none" style={[styles.wrap, { width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2 }]}>
      {PARTICLES.map((p, i) => (
        <Particle key={`${playKey}:${i}`} {...p} delay={i * 25} />
      ))}
    </View>
  );
}

function Particle({ a, d, c, s, delay }: { a: number; d: number; c: string; s: number; delay: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) }));
  }, [t, delay]);
  const rad = (a * Math.PI) / 180;
  const style = useAnimatedStyle(() => ({
    opacity: 1 - t.value,
    transform: [{ translateX: Math.cos(rad) * d * t.value }, { translateY: Math.sin(rad) * d * t.value }, { scale: 0.6 + t.value * 0.6 }],
  }));
  return (
    <Animated.View style={[styles.p, style]}>
      <XpStar size={s} color={c} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: '50%', top: '50%' },
  p: { position: 'absolute', left: '50%', top: '50%' },
});
