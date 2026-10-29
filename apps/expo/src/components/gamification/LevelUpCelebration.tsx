import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { shouldCelebrate } from '@/src/lib/progression';
import { BoundedIdSet, levelUpEventId, motionTimings } from '@/src/lib/xpAnimation';
import { getCelebratedLevel, loadSeenIds, saveSeenIds, setCelebratedLevel } from '@/src/services/gamification';
import { useScreenActive } from '@/src/hooks/useScreenActive';
import { LevelBadge } from './LevelBadge';
import { SparkleBurst } from './SparkleBurst';
import { XpGainPill } from './RewardBits';

/**
 * Level-up celebration.
 *
 * Sequence (~1.9s, skippable at any point by tapping):
 *   dim → badge springs in → sparkle burst → old level swaps to new →
 *   rank / title → unlocks → Continue.
 * It auto-dismisses after 6s and dismisses itself if the app is backgrounded
 * or the user navigates away, so it never holds the screen.
 *
 * Idempotent: an event is "this account reached level N"
 * (`levelUpEventId`), recorded per device before the animation starts, plus the
 * legacy last-celebrated-level marker. A refresh, a refetch or a remount cannot
 * show it again, and the first load of a device never replays old level-ups.
 *
 * It displays server values only (level, previous level, rank, unlocks, the XP
 * of the triggering event). It writes nothing to the server.
 */
/** Level-up ids already handled in this JS session (bounded by levels reachable). */
const CLAIMED_THIS_SESSION = new Set<string>();

export function LevelUpCelebration({
  uid,
  level,
  rankId,
  rankName,
  isMaxLevel = false,
  previousLevel,
  xpGained,
  unlocks,
  onView,
}: {
  uid: string | null | undefined;
  level: number | null | undefined;
  rankId?: string | null;
  rankName?: string;
  isMaxLevel?: boolean;
  previousLevel?: number | null;
  xpGained?: { amount: number; label: string } | null;
  unlocks?: string[];
  onView?: () => void;
}) {
  const reduce = useReducedMotion();
  const active = useScreenActive();
  const t = motionTimings(reduce);
  const [shown, setShown] = useState<{ to: number; from: number | null } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const dim = useSharedValue(0);
  const badge = useSharedValue(0);
  const swap = useSharedValue(0);
  const rank = useSharedValue(0);
  const extras = useSharedValue(0);
  const cont = useSharedValue(0);
  const all = [dim, badge, swap, rank, extras, cont];

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const dismiss = () => {
    clearTimers();
    all.forEach((v) => cancelAnimation(v));
    setShown(null);
  };

  // Decide whether to celebrate: only while this screen is visible (a hidden
  // instance under another screen must not consume the level-up), and only
  // once per app session even if two instances (Profile, Rewards) see the new
  // level together — the id is claimed synchronously before any storage I/O.
  useEffect(() => {
    if (!uid || !level || !active) return;
    const claimId = levelUpEventId(uid, level);
    if (CLAIMED_THIS_SESSION.has(claimId)) return;
    CLAIMED_THIS_SESSION.add(claimId);
    let alive = true;
    (async () => {
      const [last, seenIds] = await Promise.all([getCelebratedLevel(uid), loadSeenIds('levelup', uid)]);
      if (!alive) return;
      const seen = new BoundedIdSet(100, seenIds ?? []);
      const id = levelUpEventId(uid, level);
      const fresh = shouldCelebrate(last, level) && !seen.has(id);
      // Record BEFORE showing, so a remount mid-animation cannot show it twice.
      seen.add(id);
      await Promise.all([saveSeenIds('levelup', uid, seen.toArray()), last === null || level > last ? setCelebratedLevel(uid, level) : null]);
      if (!alive || !fresh) return;
      setShown({ to: level, from: previousLevel ?? last });
    })();
    return () => {
      alive = false;
    };
    // previousLevel is display-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, level, active]);

  // Play the sequence when shown.
  useEffect(() => {
    if (!shown) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    AccessibilityInfo.announceForAccessibility(
      `Level up! ${shown.from ? `Level ${shown.from} to level ${shown.to}` : `Level ${shown.to}`}${rankName ? `. Rank ${rankName}` : ''}.`,
    );
    const ease = { duration: 260, easing: Easing.out(Easing.cubic) };
    if (reduce) {
      all.forEach((v) => (v.value = 1));
    } else {
      dim.value = withTiming(1, { duration: t.dim });
      badge.value = withDelay(t.dim, withSpring(1, { damping: 11, stiffness: 160 }));
      swap.value = withDelay(t.levelSwap, withTiming(1, ease));
      rank.value = withDelay(t.rankReveal, withTiming(1, ease));
      extras.value = withDelay(t.unlocksReveal, withTiming(1, ease));
      cont.value = withDelay(t.continueAt, withTiming(1, ease));
    }
    timers.current.push(setTimeout(dismiss, t.autoDismiss));
    return () => {
      clearTimers();
      all.forEach((v) => cancelAnimation(v));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, reduce]);

  // Backgrounded or navigated away: end it (it was already recorded as seen).
  useEffect(() => {
    if (!active && shown) dismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value * 0.55 }));
  const cardStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, badge.value * 1.5), transform: [{ scale: 0.6 + badge.value * 0.4 }] }));
  const fromStyle = useAnimatedStyle(() => ({ opacity: 1 - swap.value, transform: [{ translateY: -12 * swap.value }] }));
  const toStyle = useAnimatedStyle(() => ({ opacity: swap.value, transform: [{ translateY: 12 * (1 - swap.value) }] }));
  const rankStyle = useAnimatedStyle(() => ({ opacity: rank.value }));
  const extrasStyle = useAnimatedStyle(() => ({ opacity: extras.value, transform: [{ translateY: 8 * (1 - extras.value) }] }));
  const contStyle = useAnimatedStyle(() => ({ opacity: 0.35 + cont.value * 0.65 }));

  if (!shown) return null;
  const from = shown.from && shown.from < shown.to ? shown.from : null;
  return (
    <View style={[StyleSheet.absoluteFill, styles.layer]} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} accessibilityRole="button" accessibilityLabel="Skip celebration">
        <Animated.View style={[StyleSheet.absoluteFill, styles.dim, dimStyle]} />
      </Pressable>
      <View style={styles.center} pointerEvents="box-none">
        <Animated.View style={[styles.cardWrap, cardStyle]} accessibilityViewIsModal accessibilityRole="alert">
          <LinearGradient colors={['#7C4DFF', '#FF4D67']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.card}>
            <View style={styles.badgeWrap}>
              <LevelBadge level={shown.to} rankId={rankId} rankName={rankName} isMaxLevel={isMaxLevel} size="xl" />
              {t.particles ? <SparkleBurst playKey={shown.to} size={170} /> : null}
            </View>
            <Text style={styles.kicker}>{isMaxLevel ? 'MAXIMUM LEVEL' : 'LEVEL UP'}</Text>
            <View style={styles.levels}>
              {from ? <Animated.Text style={[styles.levelText, styles.levelAbs, fromStyle]}>Level {from}</Animated.Text> : null}
              <Animated.Text style={[styles.levelText, from ? toStyle : null]}>
                {from ? `Level ${from} → ${shown.to}` : `Level ${shown.to}`}
              </Animated.Text>
            </View>
            {rankName ? <Animated.Text style={[styles.rank, rankStyle]}>{rankName}</Animated.Text> : null}
            <Animated.View style={[styles.extras, extrasStyle]}>
              {xpGained && xpGained.amount > 0 ? (
                <View style={styles.gainRow}>
                  <XpGainPill amount={xpGained.amount} compact />
                  <Text style={styles.small} numberOfLines={1}>{xpGained.label}</Text>
                </View>
              ) : null}
              {unlocks?.length ? (
                <Text style={styles.small} numberOfLines={2}>Unlocked: {unlocks.slice(0, 3).join(', ')}{unlocks.length > 3 ? '…' : ''}</Text>
              ) : null}
            </Animated.View>
            <Animated.View style={[styles.actions, contStyle]}>
              {onView ? (
                <TouchableOpacity
                  style={[styles.btn, styles.btnGhost]}
                  onPress={() => {
                    dismiss();
                    onView();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="View rewards"
                >
                  <Text style={styles.btnText}>View rewards</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={styles.btn} onPress={dismiss} accessibilityRole="button" accessibilityLabel="Continue">
                <Text style={[styles.btnText, { color: '#5B21B6' }]}>Continue</Text>
              </TouchableOpacity>
            </Animated.View>
          </LinearGradient>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Rendered before the screen's list, so it must sit above later siblings.
  layer: { zIndex: 100, elevation: 100 },
  dim: { backgroundColor: '#000' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 24 },
  cardWrap: { width: '100%', maxWidth: 360 },
  card: { borderRadius: 24, padding: 22, alignItems: 'center' },
  badgeWrap: { alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  kicker: { color: 'rgba(255,255,255,0.85)', letterSpacing: 2, fontSize: 12, fontFamily: 'Urbanist-Bold' },
  levels: { height: 32, justifyContent: 'center', alignItems: 'center', marginTop: 4 },
  levelText: { color: '#FFF', fontSize: 24, fontFamily: 'Urbanist-Black' },
  levelAbs: { position: 'absolute' },
  rank: { color: '#FFE082', fontSize: 16, fontFamily: 'Urbanist-Bold', marginTop: 2 },
  extras: { alignItems: 'center', gap: 6, marginTop: 10, minHeight: 20 },
  gainRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  small: { color: 'rgba(255,255,255,0.92)', fontSize: 12, fontFamily: 'Urbanist-Medium', textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  btn: { backgroundColor: '#FFFFFF', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 14 },
  btnGhost: { backgroundColor: 'rgba(255,255,255,0.2)' },
  btnText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 13 },
});
