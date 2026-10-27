import React from 'react';
import { View, Text, StyleSheet, ImageBackground } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons, MaterialCommunityIcons } from '@/src/lib/icons';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { CoinIcon } from '@/src/components/ui/CoinIcon';
import { ContestCountdownBadge, ContestEntryBadge, PrizeTagLine } from '@/src/components/contests/ContestBadges';
import { useCountdown } from '@/src/hooks/useCountdown';
import { isFreeContest } from '@/src/lib/contestPricing';
import { contestPrize, describePrize, prizeTag } from '@/src/lib/contestPrize';
import { ScaleTouchable } from './ScaleTouchable';
import { colorForType, gradForType } from './theme';

export const TEMPLATE_W = 176;
/** Shared with the loading skeleton so the rail never jumps on load. */
export const TEMPLATE_H = 216;

/**
 * One "Start a New Battle" template card.
 *
 * A real component rather than the render function it used to be, because it runs
 * `useCountdown` — hooks cannot live in a helper the FlatList calls per item, since
 * the hook order would shift as the list is filtered.
 *
 * ---------------------------------------------------------------------------
 * Layout
 * ---------------------------------------------------------------------------
 *
 *   ┌────────────────────────────┐
 *   │ [type]          [⏱ 2d 4h]  │  own row, fixed — nothing here wraps
 *   │                            │
 *   │  WINNER GETS               │
 *   │  ◉ 500                     │  the reason to tap, so the biggest thing here
 *   │  Best DP Contest           │
 *   │  [FREE]                    │
 *   │  [    Start Battle  →    ] │  full-width, so the tap target is the card's
 *   └────────────────────────────┘  width rather than a 70pt pill
 *
 * Two things the previous version got wrong.
 *
 * 1. THE COUNTDOWN SHARED A WRAPPING ROW with the entry badge. `formatCountdown`
 *    emits up to "12d 23h 59m", which needs ~94pt here; beside the entry badge
 *    that row wants ~154pt inside a 136pt box, so every contest more than a day
 *    out wrapped onto a second line. The card is a fixed height with its content
 *    bottom-aligned inside `overflow: 'hidden'`, so the extra line was taken off
 *    the TOP — it pushed the title up under the icon with about 6pt of headroom
 *    before clipping it. The countdown now owns the top row, the footer is a
 *    column, and no row in the card can wrap.
 *
 * 2. THE HIERARCHY WAS INVERTED. Entry COST got a saturated green badge while the
 *    PRIZE — the actual reason to enter — was 11pt text in a translucent corner
 *    chip. The prize is now the hero line, which also makes this card agree with
 *    how the same contest already reads on the photo and video list screens
 *    ("WINNER GETS / 500 Coins").
 *
 * It also renders `bannerUrl` when the contest has one. Both list screens have
 * always done that and this card never did, so an admin who set a banner saw it
 * everywhere except here. Most contests carry no banner today, so the type
 * gradient is still the common case rather than a fallback nobody sees.
 */
export const TemplateCard = React.memo(function TemplateCard({ item, onStart }: { item: any; onStart: () => void }) {
  const isVideo = item?.type === 'video';
  const { ended } = useCountdown(item?.endsAt);
  const prize = contestPrize(item);

  if (!item || !item.title) return null;

  const banner = typeof item.bannerUrl === 'string' && item.bannerUrl ? item.bannerUrl : null;

  // One sentence, so a screen reader reads a card rather than five disconnected
  // fragments. The touchable had no label at all before.
  const spoken = [
    item.title,
    isVideo ? 'video battle' : 'photo battle',
    isFreeContest(item) ? 'free entry' : 'paid entry',
    describePrize(prize),
    ended ? 'closed' : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <ScaleTouchable
      style={styles.templateCard}
      // The list is cached server-side, so a contest can still be here for a
      // while after it closed. Refuse the tap rather than let a user reach a
      // setup screen that would fail on submit.
      disabled={ended}
      onPress={ended ? undefined : onStart}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityState={{ disabled: ended }}
    >
      <ImageBackground
        // No banner -> no source, and the gradient below is the surface. Passing
        // `undefined` rather than a placeholder url is the same thing the photo
        // and video list cards do.
        source={banner ? { uri: banner } : undefined}
        style={styles.templateInner}
        imageStyle={styles.templateImg}
      >
        {/* This gradient does double duty: it IS the card surface when there is
            no banner, and the legibility scrim when there is one — which is why
            the banner case is a top-to-bottom black ramp rather than the
            diagonal brand gradient. */}
        <LinearGradient
          colors={
            ended
              ? ['rgba(75,85,99,0.82)', 'rgba(31,41,55,0.97)']
              : banner
                ? ['rgba(0,0,0,0.06)', 'rgba(0,0,0,0.34)', 'rgba(0,0,0,0.88)']
                : gradForType(item.type)
          }
          locations={banner && !ended ? [0, 0.42, 1] : undefined}
          start={{ x: 0, y: 0 }}
          end={banner || ended ? { x: 0, y: 1 } : { x: 1, y: 1 }}
          style={styles.templateFill}
        >
          {/* Only decoration, and only when there is no banner to decorate with. */}
          {!banner && (
            <MaterialCommunityIcons
              name={isVideo ? 'movie-open-star' : 'image-filter-hdr'}
              size={78}
              color="rgba(255,255,255,0.13)"
              style={styles.templateWm}
            />
          )}

          <View style={styles.templateTopRow}>
            <View style={styles.templateIcon}>
              <MaterialCommunityIcons
                name={isVideo ? 'movie-open-play' : 'image-multiple'}
                size={15}
                color="#FFF"
              />
            </View>
            {/* Renders nothing when the contest has no closing time, which is
                most of them — hence its own row rather than a reserved gap. */}
            <ContestCountdownBadge endsAt={item.endsAt} size="sm" />
          </View>

          <View>
            {/* A product is named rather than numbered, so it drops to the smaller
                title-sized type — a 20-character product name at the coin figure's
                21pt would not fit the card, and the name IS the persuasive part. */}
            {prize.type === 'product' ? (
              <>
                <Text style={styles.templatePrizeLabel}>WINNER GETS</Text>
                <View style={styles.templatePrizeRow}>
                  <Ionicons name="cube" size={14} color="#DDD0FF" />
                  <Text style={styles.templateProductValue} numberOfLines={1}>
                    {prize.product.title}
                  </Text>
                </View>
                {prizeTag(item) === 'sold_out' && <PrizeTagLine tag="sold_out" color="#FCA5A5" />}
              </>
            ) : prize.coins > 0 ? (
              <>
                <Text style={styles.templatePrizeLabel}>WINNER GETS</Text>
                <View style={styles.templatePrizeRow}>
                  <CoinIcon size={15} color="#FFD54A" />
                  <Text style={styles.templatePrizeValue} numberOfLines={1}>
                    {prize.coins}
                  </Text>
                </View>
                {prizeTag(item) === 'promo' && <PrizeTagLine tag="promo" color="#86EFAC" />}
              </>
            ) : null}
            <Text style={styles.templateTitle} numberOfLines={2}>
              {item.title}
            </Text>
            {/* A column, deliberately: the entry badge and the CTA on one line
                fit only just, and a four-digit entry fee would have pushed the
                CTA off the card. */}
            <View style={styles.templateFooter}>
              <ContestEntryBadge contest={item} size="sm" />
              <View style={[styles.templateCta, ended && styles.templateCtaEnded]}>
                <Text style={[styles.templateCtaText, ended && styles.templateCtaTextEnded]}>
                  {ended ? 'Closed' : 'Start Battle'}
                </Text>
                {!ended && <ArrowIcon size={11} color={colorForType(item.type)} variant="arrow" />}
              </View>
            </View>
          </View>
        </LinearGradient>
      </ImageBackground>
    </ScaleTouchable>
  );
});

const styles = StyleSheet.create({
  templateCard: {
    width: TEMPLATE_W, height: TEMPLATE_H, borderRadius: 24, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.15, shadowRadius: 10, elevation: 5,
  },
  templateInner: { flex: 1 },
  templateImg: { borderRadius: 24 },
  // `space-between` is what pins the top row to the top and the copy to the
  // bottom without a spacer view, so a card with no prize block simply has more
  // air rather than a differently-placed title.
  templateFill: { flex: 1, padding: 14, justifyContent: 'space-between' },
  templateWm: { position: 'absolute', right: -12, top: -10 },
  templateTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  templateIcon: {
    width: 28, height: 28, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.24)', justifyContent: 'center', alignItems: 'center',
  },
  templatePrizeLabel: {
    color: 'rgba(255,255,255,0.72)', fontSize: 9, fontFamily: 'Urbanist-Black',
    letterSpacing: 0.9, marginBottom: 1,
  },
  templatePrizeRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  templatePrizeValue: { color: '#FFF', fontSize: 21, fontFamily: 'Urbanist-Black', lineHeight: 24 },
  /** A product NAME in the hero slot: smaller than the coin figure so it fits. */
  templateProductValue: {
    color: '#FFF', fontSize: 14, fontFamily: 'Urbanist-Black', lineHeight: 18, flexShrink: 1,
  },
  templateTitle: { color: '#FFF', fontSize: 14, fontFamily: 'Urbanist-Bold', lineHeight: 18, marginTop: 3 },
  // Column, and `flex-start` so the badge keeps its intrinsic width instead of
  // being stretched by the default `stretch` alignment.
  templateFooter: { marginTop: 9, gap: 8, alignItems: 'flex-start' },
  templateCta: {
    alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#FFF', paddingVertical: 8, borderRadius: 100, gap: 6,
  },
  templateCtaEnded: { backgroundColor: 'rgba(255,255,255,0.16)' },
  templateCtaText: { fontSize: 12, fontFamily: 'Urbanist-Bold', color: '#121212' },
  templateCtaTextEnded: { color: '#FFF' },

});
