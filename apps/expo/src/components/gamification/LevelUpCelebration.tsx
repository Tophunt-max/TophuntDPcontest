import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInUp, FadeOutUp, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@/src/lib/icons';
import { shouldCelebrate } from '@/src/lib/progression';
import { getCelebratedLevel, setCelebratedLevel } from '@/src/services/gamification';

/**
 * A small, non-blocking level-up banner. It sits over the top of the screen,
 * never stops the user doing anything, dismisses itself and is announced to
 * screen readers. Driven by the server level and a per-device "last celebrated
 * level", so each level-up is celebrated once per device and never replayed on
 * first launch.
 */
export function LevelUpCelebration({
  uid,
  level,
  rankName,
  unlocks,
}: {
  uid: string | null | undefined;
  level: number | null | undefined;
  rankName?: string;
  unlocks?: string[];
}) {
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const [shown, setShown] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!uid || !level) return;
    let alive = true;
    (async () => {
      const last = await getCelebratedLevel(uid);
      if (!alive) return;
      if (shouldCelebrate(last, level)) {
        setShown(level);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        AccessibilityInfo.announceForAccessibility(`Level up! You reached level ${level}.`);
        timer.current = setTimeout(() => setShown(null), 5000);
      }
      if (last === null || level > last) await setCelebratedLevel(uid, level);
    })();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [uid, level]);

  if (shown === null) return null;
  return (
    <Animated.View
      entering={reduce ? undefined : FadeInUp.duration(350)}
      exiting={reduce ? undefined : FadeOutUp.duration(250)}
      style={[styles.wrap, { top: insets.top + 8 }]}
      pointerEvents="box-none"
    >
      <Pressable onPress={() => setShown(null)} accessibilityRole="alert" accessibilityHint="Dismiss">
        <LinearGradient colors={['#7C4DFF', '#FF4D67']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.card}>
          <View style={styles.icon}>
            <Ionicons name="star" size={22} color="#FFD54F" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Level up! Level {shown}</Text>
            <Text style={styles.body} numberOfLines={2}>
              {unlocks?.length ? `Unlocked: ${unlocks.slice(0, 2).join(', ')}` : rankName ? `Rank: ${rankName}` : 'Keep going!'}
            </Text>
          </View>
        </LinearGradient>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, zIndex: 50 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 18 },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  title: { color: '#FFF', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  body: { color: 'rgba(255,255,255,0.92)', fontSize: 13, fontFamily: 'Urbanist-Medium', marginTop: 2 },
});
