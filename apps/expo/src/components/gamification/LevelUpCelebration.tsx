import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeInUp, FadeOutUp, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { shouldCelebrate } from '@/src/lib/progression';
import { getCelebratedLevel, setCelebratedLevel } from '@/src/services/gamification';
import { LevelBadge } from './LevelBadge';
import { SparkleBurst } from './SparkleBurst';
import { XpGainPill } from './RewardBits';

/**
 * A small, non-blocking level-up banner.
 *
 * - Shows previous → new level, the XP from the event that triggered it, the
 *   newest unlocks, and a "View" action (navigation only — this component never
 *   grants anything; the server already did).
 * - Celebrated once per level per device (AsyncStorage) and never on a device's
 *   first load, so it cannot replay history; the server notification is
 *   deduplicated separately.
 * - Dismisses itself after 6s, never blocks touches outside the card, is
 *   announced to screen readers, and skips motion under reduced-motion.
 */
export function LevelUpCelebration({
  uid,
  level,
  rankId,
  rankName,
  previousLevel,
  xpGained,
  unlocks,
  onView,
}: {
  uid: string | null | undefined;
  level: number | null | undefined;
  rankId?: string | null;
  rankName?: string;
  previousLevel?: number | null;
  xpGained?: { amount: number; label: string } | null;
  unlocks?: string[];
  onView?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const reduce = useReducedMotion();
  const [shown, setShown] = useState<{ to: number; from: number | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!uid || !level) return;
    let alive = true;
    (async () => {
      const last = await getCelebratedLevel(uid);
      if (!alive) return;
      if (shouldCelebrate(last, level)) {
        setShown({ to: level, from: previousLevel ?? last });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        AccessibilityInfo.announceForAccessibility(`Level up! You reached level ${level}${rankName ? `, rank ${rankName}` : ''}.`);
        timer.current = setTimeout(() => setShown(null), 6000);
      }
      if (last === null || level > last) await setCelebratedLevel(uid, level);
    })();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
    // previousLevel / rankName are display-only; re-running on them would re-check storage needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          <View>
            <LevelBadge level={shown.to} rankId={rankId} rankName={rankName} size="md" />
            <SparkleBurst playKey={shown.to} size={110} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>
              Level up! {shown.from ? `${shown.from} → ` : ''}{shown.to}
            </Text>
            <Text style={styles.body} numberOfLines={2}>
              {unlocks?.length ? `Unlocked: ${unlocks.slice(0, 2).join(', ')}` : rankName ? `Rank: ${rankName}` : 'Keep going!'}
            </Text>
            {xpGained && xpGained.amount > 0 ? (
              <View style={styles.gain}>
                <XpGainPill amount={xpGained.amount} compact />
                <Text style={styles.gainText} numberOfLines={1}>{xpGained.label}</Text>
              </View>
            ) : null}
          </View>
          {onView ? (
            <TouchableOpacity
              style={styles.view}
              onPress={() => {
                setShown(null);
                onView();
              }}
              accessibilityRole="button"
              accessibilityLabel="View rewards"
            >
              <Text style={styles.viewText}>View</Text>
            </TouchableOpacity>
          ) : null}
        </LinearGradient>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, zIndex: 50, maxWidth: 560, alignSelf: 'center' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 18 },
  title: { color: '#FFF', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  body: { color: 'rgba(255,255,255,0.92)', fontSize: 13, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  gain: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  gainText: { color: 'rgba(255,255,255,0.9)', fontSize: 11, fontFamily: 'Urbanist-Medium', flexShrink: 1 },
  view: { backgroundColor: 'rgba(255,255,255,0.22)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12 },
  viewText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 12 },
});
