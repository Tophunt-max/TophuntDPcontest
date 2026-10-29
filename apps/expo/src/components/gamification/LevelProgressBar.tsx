import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { progressA11y, progressLabel, progressPercent, type LevelInfo } from '@/src/lib/progression';

/**
 * The XP bar, drawn from the server's `levelInfo` only. With no levelInfo (an
 * older Worker, or still loading) it renders nothing rather than a guessed
 * bar: a wrong progress bar is worse than none.
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
  const pct = progressPercent(info);
  const width = useSharedValue(reduce ? pct : 0);
  useEffect(() => {
    width.value = reduce ? pct : withTiming(pct, { duration: 700 });
  }, [pct, reduce, width]);
  const fill = useAnimatedStyle(() => ({ width: `${width.value}%` }));
  if (!info) return null;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={progressA11y(info)}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
    >
      {showLabels ? (
        <View style={styles.header}>
          <Text style={styles.label}>
            {info.isMaxLevel ? `Level ${info.level} · Max` : `Level ${info.level} → ${info.level + 1}`}
          </Text>
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
  label: { fontSize: 12, fontFamily: 'Urbanist-Bold', color: '#FF4D67' },
  value: { fontSize: 12, fontFamily: 'Urbanist-Medium' },
  bg: { overflow: 'hidden' },
  fillWrap: { height: '100%', overflow: 'hidden' },
});
