import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { progressA11y, progressLabel, progressPercent, type LevelInfo } from '@/src/lib/progression';
import { barPlan, motionTimings } from '@/src/lib/xpAnimation';
import { XpStar } from './vectors';

/**
 * The XP bar, drawn from the server's `levelInfo` only.
 *
 * When a NEW server snapshot arrives it animates from the previous snapshot to
 * the new one (lib/xpAnimation.ts#barPlan): within a level it slides; across a
 * level it fills, resets and slides on; a reversal or the first render jumps.
 * The previous snapshot is tracked by XP value, so a refetch that returns the
 * same numbers does nothing. Reduced motion: no animation.
 */
export function LevelProgressBar({
  info,
  isDark,
  showLabels = true,
  height = 10,
}: {
  info: LevelInfo | null | undefined;
  isDark: boolean;
  showLabels?: boolean;
  height?: number;
}) {
  const reduce = useReducedMotion();
  const t = motionTimings(reduce);
  const prev = useRef<LevelInfo | null>(null);
  const width = useSharedValue(progressPercent(info));
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (!info) return;
    const last = prev.current;
    if (last && last.xp === info.xp && last.level === info.level && last.maxLevel === info.maxLevel) return;
    const plan = barPlan(last, info);
    prev.current = info;
    cancelAnimation(width);
    if (!plan.animate || reduce) {
      width.value = plan.segments[plan.segments.length - 1].to;
      return;
    }
    const [a, b] = plan.segments;
    width.value = a.from;
    width.value = b
      ? withSequence(
          withTiming(a.to, { duration: t.bar * 0.5, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 0 }),
          withTiming(b.to, { duration: t.bar, easing: Easing.out(Easing.cubic) }),
        )
      : withTiming(a.to, { duration: t.bar, easing: Easing.out(Easing.cubic) });
    pulse.value = withSequence(withTiming(1.3, { duration: t.pulse / 2 }), withTiming(1, { duration: t.pulse / 2 }));
    return () => {
      cancelAnimation(width);
      cancelAnimation(pulse);
    };
  }, [info, reduce, t.bar, t.pulse, width, pulse]);

  const fill = useAnimatedStyle(() => ({ width: `${width.value}%` }));
  const star = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
  if (!info) return null;
  const pct = progressPercent(info);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={progressA11y(info)}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
    >
      {showLabels ? (
        <View style={styles.header}>
          <View style={styles.labelRow}>
            <Animated.View style={star}><XpStar size={13} color="#FF4D67" /></Animated.View>
            <Text style={styles.label}>
              {info.isMaxLevel ? `Level ${info.level} · Max` : `Level ${info.level} → ${info.level + 1}`}
            </Text>
          </View>
          <Text style={[styles.value, { color: isDark ? '#BDBDBD' : '#888' }]}>{progressLabel(info)}</Text>
        </View>
      ) : null}
      <View style={[styles.bg, { height, borderRadius: height / 2, backgroundColor: isDark ? '#1F222A' : '#F0F0F0' }]}>
        <Animated.View style={[styles.fillWrap, fill]}>
          <LinearGradient
            colors={info.isMaxLevel ? ['#FFD54F', '#FF8F00'] : ['#FF4D67', '#FF8A9B']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  label: { fontSize: 12, fontFamily: 'Urbanist-Bold', color: '#FF4D67' },
  value: { fontSize: 12, fontFamily: 'Urbanist-Medium' },
  bg: { overflow: 'hidden' },
  fillWrap: { height: '100%', overflow: 'hidden' },
});
