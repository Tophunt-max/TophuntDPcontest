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
 * ---------------------------------------------------------------------------
 * The visual rule: ENTRY is a LIGHT pill, TIME is a DARK pill
 * ---------------------------------------------------------------------------
 * That is the whole point of this design, and it fixes the thing that actually
 * made these hard to read: the paid-entry chip and the countdown chip used the
 * SAME `rgba(0,0,0,0.42)` fill. Two different kinds of fact — what this costs you,
 * and how long you have — were rendered as the same grey lozenge, separated only
 * by an 11pt glyph. You had to read them to tell them apart, so a glance told you
 * nothing.
 *
 * Now the two carry different weight, so which is which is legible before any
 * text is: entry is a bright pill with dark type (green for free, gold for paid,
 * because money is gold everywhere else in this app), time is a solid dark pill
 * with light type that goes red in the final hour.
 *
 * ---------------------------------------------------------------------------
 * Why the fills are opaque
 * ---------------------------------------------------------------------------
 * These sit on top of a gradient OR an arbitrary banner photo. A translucent
 * black fill has no fixed contrast at all — over a dark photo the pill dissolves
 * into it, over a light one it reads fine — so on the two list screens, where the
 * badge row sits at the top of a scrim that is nearly transparent there
 * (`rgba(0,0,0,0.05)`), the old chips were effectively unstyled over whatever
 * image the admin uploaded. Opaque fills give every pill the same contrast on
 * every background, and the hairline plus small shadow keep the edge visible even
 * when the fill and the photo behind it are a similar tone.
 *
 * Contrast, measured rather than eyeballed (WCAG AA wants 4.5:1 at this size):
 *
 *   FREE    #052E16 on #4ADE80   8.6:1   (was white on #16A34A — 3.3:1, a FAIL)
 *   PAID    #422006 on #FCD34D   ~11:1
 *   TIME    #FFFFFF on #111827   ~16:1
 *   URGENT  #FFFFFF on #DC2626   4.9:1
 *   ENDED   #FFFFFF on #4B5563   ~7:1
 */

/** Entry pills: bright fill, dark type. */
const FREE_BG = '#4ADE80';
const FREE_FG = '#052E16';
const PAID_BG = '#FCD34D';
const PAID_FG = '#422006';
/** Time pill: solid dark, light type. */
const TIME_BG = '#111827';
const TIME_URGENT_BG = '#DC2626';
const TIME_ENDED_BG = '#4B5563';
const TIME_FG = '#FFFFFF';

/**
 * Caps how far the OS "larger text" setting can stretch badge type.
 *
 * These are fixed-width pills inside fixed-height cards, so an unbounded
 * multiplier does not make them more readable — it makes the label overflow its
 * own pill. 1.3 is enough to help without breaking the layout.
 */
const MAX_SCALE = 1.3;

/**
 * "FREE" or a coin figure — and, critically, ALWAYS one of the two.
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
  const iconSize = small ? 12 : 13;

  if (free) {
    return (
      <View
        style={[styles.badge, styles.freeBadge, small && styles.badgeSm]}
        accessibilityLabel="Free entry"
      >
        <Ionicons name="gift" size={iconSize} color={FREE_FG} />
        <Text
          style={[styles.badgeText, { color: FREE_FG }, small && styles.badgeTextSm]}
          numberOfLines={1}
          maxFontSizeMultiplier={MAX_SCALE}
        >
          FREE
        </Text>
      </View>
    );
  }

  return (
    <View
      style={[styles.badge, styles.paidBadge, small && styles.badgeSm]}
      accessibilityLabel={`Entry costs ${fee} coins`}
    >
      <CoinIcon size={iconSize} color={PAID_FG} />
      <Text
        style={[styles.badgeText, styles.numeric, { color: PAID_FG }, small && styles.badgeTextSm]}
        numberOfLines={1}
        maxFontSizeMultiplier={MAX_SCALE}
      >
        {fee}
      </Text>
    </View>
  );
}

/**
 * A live countdown chip for a contest's closing time.
 *
 * Renders nothing when the contest has no closing time — most contests run
 * indefinitely, and an empty or "∞" chip would be noise on every card. Turns
 * red in the final hour and reads "Ended" once the deadline passes (which the
 * card uses to disable itself, because the response cache means an expired
 * contest can still be in the list for a while).
 *
 * The label is tabular-figured. It reprints every second, and proportional digits
 * are different widths, so without that the pill visibly twitched wider and
 * narrower as the numbers rolled — which reads as a glitch on a card that is
 * otherwise still.
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
        size={small ? 12 : 13}
        color={TIME_FG}
      />
      <Text
        style={[styles.badgeText, styles.numeric, { color: TIME_FG }, small && styles.badgeTextSm]}
        numberOfLines={1}
        maxFontSizeMultiplier={MAX_SCALE}
      >
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 100,
    borderWidth: StyleSheet.hairlineWidth,
    // Separates the pill from a background of a similar tone. Cheap enough to be
    // unconditional, and the reason a light pill still has an edge on a pale photo.
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  badgeSm: { paddingHorizontal: 8, paddingVertical: 4, gap: 3 },
  // 11/12pt, up from 10/11. These carry the two facts a person needs in order to
  // decide, so they were the wrong thing in the card to make smallest.
  badgeText: { fontSize: 12, fontFamily: 'Urbanist-Black', letterSpacing: 0.3 },
  badgeTextSm: { fontSize: 11 },
  /** Fixed-width digits, so a ticking label does not resize its own pill. */
  numeric: { fontVariant: ['tabular-nums'] },

  freeBadge: { backgroundColor: FREE_BG, borderColor: 'rgba(5,46,22,0.22)' },
  paidBadge: { backgroundColor: PAID_BG, borderColor: 'rgba(66,32,6,0.22)' },
  timeBadge: { backgroundColor: TIME_BG, borderColor: 'rgba(255,255,255,0.22)' },
  timeBadgeUrgent: { backgroundColor: TIME_URGENT_BG, borderColor: 'rgba(255,255,255,0.34)' },
  timeBadgeEnded: { backgroundColor: TIME_ENDED_BG, borderColor: 'rgba(255,255,255,0.26)' },
});
