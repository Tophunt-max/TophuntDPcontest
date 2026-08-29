import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@/src/lib/icons';
import { CoinIcon } from '@/src/components/ui/CoinIcon';
import { useCountdown } from '@/src/hooks/useCountdown';
import { entryFeePerPlayer, isFreeContest, type ContestPricingInput } from '@/src/lib/contestPricing';
import type { Deadline } from '@/src/lib/countdown';

/**
 * The two badges every contest card needs, in one place so Explore, the photo
 * list and the video list cannot drift apart again.
 *
 * Both are designed to sit on top of a dark gradient or banner image, which is
 * what all three call sites do.
 */

/**
 * "FREE" or "Entry N" — and, critically, ALWAYS one of the two.
 *
 * The old cards rendered a price only when it was greater than zero, so a free
 * battle showed nothing at all. "Nothing" reads as a loading failure, not as
 * "this is free", which is the single most persuasive thing a card can say.
 */
export function ContestEntryBadge({
  contest,
  size = 'md',
}: {
  contest: ContestPricingInput | null | undefined;
  size?: 'sm' | 'md';
}) {
  const free = isFreeContest(contest);
  const fee = entryFeePerPlayer(contest);
  const small = size === 'sm';

  if (free) {
    return (
      <View
        style={[styles.badge, styles.freeBadge, small && styles.badgeSm]}
        accessibilityLabel="Free entry"
      >
        <Ionicons name="gift" size={small ? 11 : 12} color="#FFF" />
        <Text style={[styles.badgeText, small && styles.badgeTextSm]}>FREE</Text>
      </View>
    );
  }

  return (
    <View
      style={[styles.badge, styles.paidBadge, small && styles.badgeSm]}
      accessibilityLabel={`Entry costs ${fee} coins`}
    >
      <CoinIcon size={small ? 11 : 12} color="#FFF" />
      <Text style={[styles.badgeText, small && styles.badgeTextSm]}>{fee}</Text>
    </View>
  );
}

/**
 * A live countdown chip for a contest's closing time.
 *
 * Renders nothing when the contest has no closing time — most contests run
 * indefinitely, and an empty or "∞" chip would be noise on every card. Turns
 * red in the final hour and reads "Ended" once the deadline passes (which the
 * card uses to disable itself, because the 60s response cache means an expired
 * contest can still be in the list for up to a minute).
 */
export function ContestCountdownBadge({
  endsAt,
  size = 'md',
}: {
  endsAt: Deadline;
  size?: 'sm' | 'md';
}) {
  const { label, ended, urgent } = useCountdown(endsAt);
  if (label === null) return null;
  const small = size === 'sm';

  return (
    <View
      style={[
        styles.badge,
        styles.timeBadge,
        small && styles.badgeSm,
        urgent && styles.timeBadgeUrgent,
        ended && styles.timeBadgeEnded,
      ]}
      accessibilityLabel={ended ? 'This contest has ended' : `Closes in ${label}`}
    >
      <Ionicons
        name={ended ? 'lock-closed' : 'time'}
        size={small ? 11 : 12}
        color="#FFF"
      />
      <Text style={[styles.badgeText, small && styles.badgeTextSm]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 100,
  },
  badgeSm: { paddingHorizontal: 7, paddingVertical: 3, gap: 3 },
  badgeText: { color: '#FFF', fontSize: 11, fontFamily: 'Urbanist-Black' },
  badgeTextSm: { fontSize: 10 },
  freeBadge: { backgroundColor: '#16A34A' },
  paidBadge: { backgroundColor: 'rgba(0,0,0,0.42)' },
  timeBadge: { backgroundColor: 'rgba(0,0,0,0.42)' },
  timeBadgeUrgent: { backgroundColor: '#DC2626' },
  timeBadgeEnded: { backgroundColor: '#4B5563' },
});
