import React, { useEffect, useState } from 'react';
import {
  View,
  StyleSheet,
  Animated,
  Easing,
  Platform,
  AccessibilityInfo,
  StyleProp,
  ViewStyle,
  DimensionValue,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useResolvedColorScheme } from '@/src/lib/themePreference';

/**
 * Skeleton — a soft base block with a highlight band sweeping left → right.
 *
 * WHY IT IS BUILT THIS WAY
 * ------------------------
 * The previous version gave every block its own `Animated.loop` with
 * `useNativeDriver: true`. On web there is no native driver, so React Native Web
 * silently fell back to the JS driver, which re-renders every block through
 * React on every frame. With ~30 blocks on a profile skeleton the band never
 * moved: measured on the production web build, its position did not change for
 * 1.2 s at 62 fps, so users saw a pale band frozen at one edge of every block.
 *
 *  - Web: the band is a CSS animation (`@keyframes`, injected once). The browser
 *    runs it on the compositor; React does nothing per frame, and the band moves
 *    by its own width with `translateX(-100%) → translateX(100%)`, so no layout
 *    measurement is needed. Every block shares one timeline (a negative
 *    `animation-delay` from the wall clock), so the screen shimmers in step.
 *  - Native: ONE shared `Animated.Value` on the native driver for all blocks
 *    (started with the first block, stopped with the last), instead of one loop
 *    per block.
 *  - Reduce motion (OS setting / `prefers-reduced-motion`): no band, just the
 *    static block.
 *  - The theme is read with the resolved scheme directly (no per-block
 *    "light first, then dark" flash on web).
 */
interface SkeletonProps {
  width?: DimensionValue;
  height?: DimensionValue;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
}

export const SHIMMER_MS = 1300;

export function skeletonColors(isDark: boolean) {
  return {
    base: isDark ? '#22252E' : '#E9EBF0',
    highlight: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.65)',
  };
}

// ---------------------------------------------------------------------------
// Web: one global keyframes rule
// ---------------------------------------------------------------------------
const WEB_ATTR = 'th-shimmer';
let webCssInjected = false;

function ensureWebCss() {
  if (webCssInjected || typeof document === 'undefined') return;
  webCssInjected = true;
  const css =
    `@keyframes th-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}` +
    `[data-${WEB_ATTR}]{animation:th-shimmer ${SHIMMER_MS}ms linear infinite;will-change:transform}` +
    `@media (prefers-reduced-motion: reduce){[data-${WEB_ATTR}]{animation:none;opacity:0}}`;
  const el = document.createElement('style');
  el.setAttribute('data-th-shimmer-css', '');
  el.textContent = css;
  document.head.appendChild(el);
}

/** Same phase for every block: a negative delay taken from the wall clock. */
function sharedPhaseDelay(): string {
  return `-${Date.now() % SHIMMER_MS}ms`;
}

// ---------------------------------------------------------------------------
// Native: one shared animated value for every block
// ---------------------------------------------------------------------------
const sharedProgress = new Animated.Value(0);
let nativeUsers = 0;
let nativeLoop: Animated.CompositeAnimation | null = null;

function retainNativeLoop() {
  nativeUsers += 1;
  if (nativeLoop) return;
  sharedProgress.setValue(0);
  nativeLoop = Animated.loop(
    Animated.timing(sharedProgress, {
      toValue: 1,
      duration: SHIMMER_MS,
      easing: Easing.linear,
      useNativeDriver: true,
    }),
  );
  nativeLoop.start();
}

function releaseNativeLoop() {
  nativeUsers = Math.max(0, nativeUsers - 1);
  if (nativeUsers === 0 && nativeLoop) {
    nativeLoop.stop();
    nativeLoop = null;
  }
}

let reduceMotion = false;
let reduceMotionKnown = false;
const reduceMotionListeners = new Set<(v: boolean) => void>();
function watchReduceMotion() {
  if (reduceMotionKnown || Platform.OS === 'web') return;
  reduceMotionKnown = true;
  AccessibilityInfo.isReduceMotionEnabled?.()
    .then((v) => {
      reduceMotion = !!v;
      reduceMotionListeners.forEach((l) => l(reduceMotion));
    })
    .catch(() => undefined);
  AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => {
    reduceMotion = !!v;
    reduceMotionListeners.forEach((l) => l(reduceMotion));
  });
}

function useNativeReduceMotion(): boolean {
  const [v, setV] = useState(reduceMotion);
  useEffect(() => {
    watchReduceMotion();
    reduceMotionListeners.add(setV);
    return () => {
      reduceMotionListeners.delete(setV);
    };
  }, []);
  return v;
}

// ---------------------------------------------------------------------------

const WebBand = ({ highlight }: { highlight: string }) => {
  ensureWebCss();
  const [delay] = useState(sharedPhaseDelay);
  return (
    <View
      // `dataSet` becomes data-th-shimmer on the DOM node (react-native-web).
      {...({ dataSet: { thShimmer: '' } } as any)}
      style={[StyleSheet.absoluteFill, { animationDelay: delay } as any]}
      pointerEvents="none"
    >
      <LinearGradient
        colors={['transparent', highlight, 'transparent']}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
};

const NativeBand = ({ highlight, width }: { highlight: string; width: number }) => {
  useEffect(() => {
    retainNativeLoop();
    return releaseNativeLoop;
  }, []);
  const translateX = sharedProgress.interpolate({ inputRange: [0, 1], outputRange: [-width, width] });
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateX }] }]} pointerEvents="none">
      <LinearGradient
        colors={['transparent', highlight, 'transparent']}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
};

export const Skeleton = ({ width = '100%', height = 16, borderRadius = 8, style }: SkeletonProps) => {
  const isDark = useResolvedColorScheme() === 'dark';
  const { base, highlight } = skeletonColors(isDark);
  const isWeb = Platform.OS === 'web';
  const noMotion = useNativeReduceMotion();
  const [w, setW] = useState(0);

  return (
    <View
      onLayout={
        isWeb
          ? undefined
          : (e) => {
              const lw = Math.round(e.nativeEvent.layout.width);
              if (lw && lw !== w) setW(lw);
            }
      }
      style={[{ width, height, borderRadius, backgroundColor: base, overflow: 'hidden' }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {isWeb ? <WebBand highlight={highlight} /> : !noMotion && w > 0 ? <NativeBand highlight={highlight} width={w} /> : null}
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

/** The theme colour of skeleton blocks, for screens that build their own frames. */
export function useSkeletonColors() {
  return skeletonColors(useResolvedColorScheme() === 'dark');
}

export default Skeleton;
