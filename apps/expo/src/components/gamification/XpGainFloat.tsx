import React, { useEffect } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { motionTimings, type XpGainItem } from '@/src/lib/xpAnimation';
import { XpStar } from './vectors';

/**
 * The floating "+XP" indicator for ONE server-confirmed gain (useXpGainFeed).
 * Rises and fades over ~0.9s with a small star pulse, then calls `onDone`.
 * Reduced motion: shown still for 1.5s. Its only timer is cleared on unmount.
 */
export function XpGainFloat({ item, onDone }: { item: XpGainItem | null; onDone: () => void }) {
  const reduce = useReducedMotion();
  const t = motionTimings(reduce);
  const y = useSharedValue(0);
  const o = useSharedValue(0);
  const s = useSharedValue(1);

  useEffect(() => {
    if (!item) return;
    AccessibilityInfo.announceForAccessibility(`Plus ${item.amount} XP`);
    if (reduce) {
      o.value = 1;
      y.value = 0;
    } else {
      y.value = 0;
      o.value = withSequence(withTiming(1, { duration: 120 }), withTiming(1, { duration: t.float - 420 }), withTiming(0, { duration: 300 }));
      y.value = withTiming(-26, { duration: t.float, easing: Easing.out(Easing.cubic) });
      s.value = withSequence(withTiming(1.35, { duration: t.pulse / 2 }), withTiming(1, { duration: t.pulse / 2 }));
    }
    const timer = setTimeout(onDone, reduce ? 1500 : t.float + 50);
    return () => {
      clearTimeout(timer);
      cancelAnimation(y);
      cancelAnimation(o);
      cancelAnimation(s);
    };
    // A new item (its key) restarts the animation; onDone is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.key, reduce]);

  const style = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateY: y.value }] }));
  const star = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  if (!item) return null;
  return (
    <View pointerEvents="none" style={styles.anchor}>
      <Animated.View style={[styles.pill, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Animated.View style={star}><XpStar size={14} color="#E08E00" /></Animated.View>
        <Text style={styles.text}>+{item.amount} XP</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'absolute', right: 0, top: -6, alignItems: 'flex-end' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FFF4D6', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  text: { color: '#8A5700', fontSize: 12, fontFamily: 'Urbanist-Bold' },
});
