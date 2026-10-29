/**
 * Small reusable animations for achievements, rewards, quests, streaks and
 * leaderboards. All of them:
 *   - display server values only (they never call the API to grant anything),
 *   - honour reduced motion with a static fallback,
 *   - cancel their animations and timers on unmount.
 */
import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Animated, {
  Easing,
  ZoomIn,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@/src/lib/icons';
import { BoundedIdSet, REWARD_REVEAL_COPY, achievementEventId, canRetryReward, rankChange, rewardRevealState, streakMilestone } from '@/src/lib/xpAnimation';
import { loadSeenIds, saveSeenIds, useClaimRewardGrant } from '@/src/services/gamification';
import type { ExplorePalette } from '@/src/components/explore/theme';
import { AchievementIcon, XpGainPill } from './RewardBits';
import { GamificationIcon } from './GamificationIcon';
import { LockBadge } from './vectors';

const BRAND = '#FF4D67';

// ---------------------------------------------------------------------------
// Achievement unlock
// ---------------------------------------------------------------------------

export interface UnlockedAchievementView {
  id: string;
  name: string;
  icon: string;
  rarity: string;
  tier: number;
  xp: number;
  description?: string;
}

/**
 * Shows achievements the SERVER just unlocked (getProgression.newlyUnlocked),
 * one at a time, as a lock → badge reveal. Deduped per device by
 * `achievementEventId`, bounded to the first 3 per batch.
 */
export function AchievementUnlockToast({ uid, unlocked }: { uid: string | null | undefined; unlocked: UnlockedAchievementView[] | null | undefined }) {
  const insets = useSafeAreaInsets();
  const [queue, setQueue] = useState<UnlockedAchievementView[]>([]);
  useEffect(() => {
    if (!uid || !unlocked?.length) return;
    let alive = true;
    (async () => {
      const seen = new BoundedIdSet(200, (await loadSeenIds('ach', uid)) ?? []);
      const fresh = unlocked.filter((a) => !seen.has(achievementEventId(uid, a.id, a.tier))).slice(0, 3);
      for (const a of unlocked) seen.add(achievementEventId(uid, a.id, a.tier));
      await saveSeenIds('ach', uid, seen.toArray());
      if (alive && fresh.length) setQueue((q) => [...q, ...fresh].slice(0, 3));
    })();
    return () => {
      alive = false;
    };
  }, [uid, unlocked]);
  const current = queue[0];
  if (!current) return null;
  return (
    <View pointerEvents="box-none" style={[styles.toastWrap, { bottom: insets.bottom + 16 }]}>
      <AchievementReveal key={`${current.id}:${current.tier}`} a={current} onDone={() => setQueue((q) => q.slice(1))} />
    </View>
  );
}

/** Locked badge → unlocked badge with scale, opacity and a brief glow. */
export function AchievementReveal({ a, onDone, holdMs = 3200 }: { a: UnlockedAchievementView; onDone?: () => void; holdMs?: number }) {
  const reduce = useReducedMotion();
  const card = useSharedValue(reduce ? 1 : 0);
  const unlock = useSharedValue(reduce ? 1 : 0);
  const glow = useSharedValue(0);
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(`Achievement unlocked: ${a.name}${a.xp ? `, plus ${a.xp} XP` : ''}`);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (!reduce) {
      card.value = withTiming(1, { duration: 220 });
      unlock.value = withDelay(350, withSpring(1, { damping: 12, stiffness: 170 }));
      glow.value = withDelay(400, withSequence(withTiming(1, { duration: 220 }), withTiming(0, { duration: 500 })));
    }
    const timer = onDone ? setTimeout(onDone, holdMs) : null;
    return () => {
      if (timer) clearTimeout(timer);
      [card, unlock, glow].forEach((v) => cancelAnimation(v));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce]);
  const cardStyle = useAnimatedStyle(() => ({ opacity: card.value, transform: [{ translateY: 16 * (1 - card.value) }] }));
  const lockStyle = useAnimatedStyle(() => ({ opacity: 1 - unlock.value, transform: [{ scale: 1 - unlock.value * 0.4 }] }));
  const badgeStyle = useAnimatedStyle(() => ({ opacity: unlock.value, transform: [{ scale: 0.5 + unlock.value * 0.5 }] }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: glow.value * 0.7, transform: [{ scale: 1 + glow.value * 0.5 }] }));
  return (
    <Animated.View style={[styles.toast, cardStyle]} accessibilityRole="alert">
      <Pressable onPress={onDone} style={styles.toastInner} accessibilityHint="Dismiss">
        <View style={styles.revealIcon}>
          <Animated.View style={[styles.glow, glowStyle]} />
          <Animated.View style={[StyleSheet.absoluteFill, styles.centerAbs, lockStyle]}>
            <LockBadge size={46} />
          </Animated.View>
          <Animated.View style={badgeStyle}>
            <AchievementIcon a={{ id: a.id, icon: a.icon, unlocked: true, rarity: a.rarity }} size={46} />
          </Animated.View>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.toastKicker}>Achievement unlocked</Text>
          <Text style={styles.toastTitle} numberOfLines={1}>{a.name}{a.tier > 1 ? ` · Tier ${a.tier}` : ''}</Text>
          {a.description ? <Text style={styles.toastBody} numberOfLines={2}>{a.description}</Text> : null}
        </View>
        {a.xp > 0 ? <XpGainPill amount={a.xp} compact /> : null}
      </Pressable>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Reward reveal + claim
// ---------------------------------------------------------------------------

/**
 * Claim button + result reveal for a reward grant. The success state ONLY
 * appears with the server's result (its `coins`), never optimistically. Failed,
 * already-claimed, expired, unavailable and offline outcomes each get their own
 * state, and retry is offered where it makes sense.
 */
export function RewardClaimReveal({ grantId, p, onClaimed }: { grantId: string; p: ExplorePalette; onClaimed?: (coins: number) => void }) {
  const claim = useClaimRewardGrant();
  const reduce = useReducedMotion();
  const state = rewardRevealState({ pending: claim.isPending, result: claim.data ?? null, error: (claim.error as any) ?? null });
  const reveal = useSharedValue(0);
  useEffect(() => {
    if (state === 'claimed') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      AccessibilityInfo.announceForAccessibility(`${claim.data?.coins} Diamond added to your wallet`);
      onClaimed?.(Number(claim.data?.coins) || 0);
    }
    reveal.value = reduce ? 1 : 0;
    if (!reduce && state !== 'idle' && state !== 'claiming') reveal.value = withSpring(1, { damping: 13, stiffness: 180 });
    return () => cancelAnimation(reveal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, reduce]);
  const style = useAnimatedStyle(() => ({ opacity: 0.3 + reveal.value * 0.7, transform: [{ scale: 0.9 + reveal.value * 0.1 }] }));

  if (state === 'idle' || state === 'claiming') {
    return (
      <TouchableOpacity
        style={[styles.claimBtn, state === 'claiming' && { opacity: 0.6 }]}
        disabled={state === 'claiming'}
        onPress={() => claim.mutate(grantId)}
        accessibilityRole="button"
        accessibilityLabel="Claim reward"
        accessibilityState={{ busy: state === 'claiming' }}
      >
        {state === 'claiming' ? <ActivityIndicator color="#FFF" size="small" /> : <Text style={styles.claimText}>Claim</Text>}
      </TouchableOpacity>
    );
  }
  const ok = state === 'claimed' || state === 'already_claimed';
  return (
    <Animated.View style={[styles.result, style]} accessible accessibilityLabel={state === 'claimed' ? `+${claim.data?.coins} Diamond. ${REWARD_REVEAL_COPY.claimed}` : REWARD_REVEAL_COPY[state]}>
      <GamificationIcon assetKey={ok ? 'reward.claimed' : 'reward.locked'} size={16} />
      <Text style={[styles.resultText, { color: ok ? '#16A34A' : p.sub }]} numberOfLines={2}>
        {state === 'claimed' ? `+${claim.data?.coins} Diamond` : REWARD_REVEAL_COPY[state]}
      </Text>
      {canRetryReward(state) ? (
        <TouchableOpacity onPress={() => { claim.reset(); claim.mutate(grantId); }} accessibilityRole="button" accessibilityLabel="Retry claim">
          <Text style={[styles.retry, { color: BRAND }]}>Retry</Text>
        </TouchableOpacity>
      ) : null}
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Quests
// ---------------------------------------------------------------------------

/**
 * A completion checkmark. It springs in only when `animate` is set — the parent
 * passes true when the SERVER snapshot changed this item to done — so lists
 * opened with already-completed items do not all bounce at once.
 */
export function AnimatedCheck({ done, size = 22, animate = false }: { done: boolean; size?: number; animate?: boolean }) {
  const reduce = useReducedMotion();
  if (!done) return null;
  return (
    <Animated.View entering={animate && !reduce ? ZoomIn.springify().damping(12) : undefined} accessible accessibilityLabel="Completed">
      <Ionicons name="checkmark-circle" size={size} color="#22C55E" />
    </Animated.View>
  );
}

/** A mini progress bar that slides on meaningful server changes only. */
export function AnimatedMiniBar({ value, target, track }: { value: number; target: number; track: string }) {
  const reduce = useReducedMotion();
  const pct = Math.min(100, (value / Math.max(1, target)) * 100);
  const w = useSharedValue(pct);
  useEffect(() => {
    w.value = reduce ? pct : withTiming(pct, { duration: 500, easing: Easing.out(Easing.cubic) });
    return () => cancelAnimation(w);
  }, [pct, reduce, w]);
  const style = useAnimatedStyle(() => ({ width: `${w.value}%` }));
  return (
    <View style={[styles.mini, { backgroundColor: track }]}>
      <Animated.View style={[styles.miniFill, style]} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

/** Banner for a 7 / 30 / 100-day check-in streak, from the server's streak after a claim. */
export function StreakMilestoneBanner({ streak, onDone }: { streak: number | null | undefined; onDone: () => void }) {
  const reduce = useReducedMotion();
  const m = streakMilestone(streak);
  const s = useSharedValue(reduce ? 1 : 0);
  useEffect(() => {
    if (!m) return;
    AccessibilityInfo.announceForAccessibility(`${m}-day streak!`);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    if (!reduce) s.value = withSpring(1, { damping: 10, stiffness: 160 });
    const t = setTimeout(onDone, 3500);
    return () => {
      clearTimeout(t);
      cancelAnimation(s);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, reduce]);
  const style = useAnimatedStyle(() => ({ opacity: s.value, transform: [{ scale: 0.7 + s.value * 0.3 }] }));
  if (!m) return null;
  return (
    <Animated.View style={[styles.streak, style]} accessibilityRole="alert">
      <Pressable onPress={onDone} style={styles.streakInner} accessibilityHint="Dismiss">
        <GamificationIcon assetKey="activity.streak" size={28} />
        <View style={{ flex: 1 }}>
          <Text style={styles.toastTitle}>{m}-day streak!</Text>
          <Text style={styles.toastBody}>You checked in {m} days in a row.</Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/**
 * A short up/down marker when a user's rank moved between two fetches of the
 * same board. It fades in once and then stays still — the list never shuffles.
 */
export function RankDelta({ prev, next }: { prev: number | null | undefined; next: number }) {
  const reduce = useReducedMotion();
  const c = rankChange(prev, next);
  if (c.dir !== 'up' && c.dir !== 'down') return null;
  const up = c.dir === 'up';
  return (
    <Animated.View
      entering={reduce ? undefined : ZoomIn.duration(250)}
      style={[styles.delta, { backgroundColor: up ? '#DCFCE7' : '#FEE2E2' }]}
      accessible
      accessibilityLabel={`${up ? 'Up' : 'Down'} ${c.by} ${c.by === 1 ? 'place' : 'places'}`}
    >
      <Ionicons name={up ? 'trending-up' : 'trending-down'} size={11} color={up ? '#15803D' : '#B91C1C'} />
      <Text style={[styles.deltaText, { color: up ? '#15803D' : '#B91C1C' }]}>{c.by}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toastWrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center', zIndex: 60, elevation: 60 },
  toast: { width: '100%', maxWidth: 520 },
  toastInner: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#1F2933', borderRadius: 18, padding: 12 },
  revealIcon: { width: 50, height: 50, alignItems: 'center', justifyContent: 'center' },
  centerAbs: { alignItems: 'center', justifyContent: 'center' },
  glow: { position: 'absolute', width: 50, height: 50, borderRadius: 25, backgroundColor: '#FFD54F' },
  toastKicker: { color: '#FFD54F', fontSize: 11, fontFamily: 'Urbanist-Bold', letterSpacing: 0.5 },
  toastTitle: { color: '#FFFFFF', fontSize: 15, fontFamily: 'Urbanist-Bold' },
  toastBody: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 1 },
  claimBtn: { backgroundColor: BRAND, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, minWidth: 64, alignItems: 'center' },
  claimText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 12 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 200 },
  resultText: { fontSize: 12, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  retry: { fontSize: 12, fontFamily: 'Urbanist-Bold' },
  mini: { height: 6, borderRadius: 3, marginTop: 6, overflow: 'hidden' },
  miniFill: { height: '100%', backgroundColor: BRAND, borderRadius: 3 },
  streak: { position: 'absolute', left: 16, right: 16, top: 12, zIndex: 60, elevation: 60, alignItems: 'center' },
  streakInner: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#1F2933', borderRadius: 18, padding: 14, width: '100%', maxWidth: 520 },
  delta: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6 },
  deltaText: { fontSize: 10, fontFamily: 'Urbanist-Bold' },
});
