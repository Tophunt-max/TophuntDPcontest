import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { assetColors } from '@/src/lib/progression';

/**
 * A cosmetic ring around an avatar. Purely visual. An animated frame pulses
 * gently, and stays still when the OS asks for reduced motion.
 */
export function ProfileFrame({
  frame,
  size,
  children,
  fallbackBorder,
}: {
  frame: { name: string; asset: Record<string, any> } | null | undefined;
  size: number;
  children: React.ReactNode;
  fallbackBorder: string;
}) {
  const reduce = useReducedMotion();
  const animated = !!frame?.asset?.animated && !reduce;
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (animated) pulse.value = withRepeat(withTiming(1.04, { duration: 1400, easing: Easing.inOut(Easing.ease) }), -1, true);
    else pulse.value = 1;
  }, [animated, pulse]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
  const outer = size + 10;
  if (!frame) {
    return (
      <View style={[styles.plain, { width: outer, height: outer, borderRadius: outer / 2, borderColor: fallbackBorder }]}>
        {children}
      </View>
    );
  }
  const colors = assetColors(frame.asset);
  return (
    <Animated.View style={[{ width: outer, height: outer }, style]} accessibilityLabel={`${frame.name} profile frame`}>
      <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[styles.ring, { borderRadius: outer / 2 }]}>
        {children}
      </LinearGradient>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  plain: { borderWidth: 1, padding: 4, justifyContent: 'center', alignItems: 'center' },
  ring: { flex: 1, padding: 4, justifyContent: 'center', alignItems: 'center' },
});
