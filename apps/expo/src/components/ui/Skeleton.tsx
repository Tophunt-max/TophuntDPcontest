import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Animated, useColorScheme, StyleProp, ViewStyle, DimensionValue } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * Skeleton — a fresh, shimmer-sweep placeholder.
 *
 * A soft base block with a highlight band that sweeps left→right (instead of the
 * old opacity pulse). Theme-aware, so callers don't need to pass colors, but the
 * width/height/borderRadius/style API is unchanged so every existing screen
 * skeleton is upgraded automatically.
 */
interface SkeletonProps {
  width?: DimensionValue;
  height?: DimensionValue;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
}

export const Skeleton = ({ width = '100%', height = 16, borderRadius = 8, style }: SkeletonProps) => {
  const isDark = useColorScheme() === 'dark';
  const base = isDark ? '#20222B' : '#E7E9EF';
  const highlight = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.70)';

  const progress = useRef(new Animated.Value(0)).current;
  const [w, setW] = useState(0);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1150,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress]);

  // Sweep the highlight band from just off the left edge to just off the right.
  const translateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-w, w],
  });

  return (
    <View
      onLayout={(e) => {
        const lw = e.nativeEvent.layout.width;
        if (lw && Math.abs(lw - w) > 1) setW(lw);
      }}
      style={[{ width, height, borderRadius, backgroundColor: base, overflow: 'hidden' }, style]}
    >
      {w > 0 && (
        <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX }] }]}>
          <LinearGradient
            colors={['transparent', highlight, 'transparent']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      )}
    </View>
  );
};

/** Circular skeleton (avatars, icon buttons). */
export const SkeletonCircle = ({ size, style }: { size: number; style?: StyleProp<ViewStyle> }) => (
  <Skeleton width={size} height={size} borderRadius={size / 2} style={style} />
);

/** A single text-line skeleton. */
export const SkeletonText = ({
  width = '100%',
  height = 12,
  style,
}: {
  width?: DimensionValue;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) => <Skeleton width={width} height={height} borderRadius={6} style={style} />;

export default Skeleton;
