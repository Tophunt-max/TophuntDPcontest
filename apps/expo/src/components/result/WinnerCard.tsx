import React, { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, Platform, Image as RNImage } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons, MaterialCommunityIcons } from '@/src/lib/icons';
import images from '@/assets/images';
import { useVideoStatus } from '@/src/hooks/useVideoStatus';
import { cardSafePrizeImage, coinsLabel, votesLabel, type BattleResultSummary, type ResultSide } from '@/src/lib/battleResult';
import { CoinMedallion } from './CoinMedallion';
import { sameOriginMediaUrl } from '@/src/lib/shareMedia';

/**
 * The shareable 9:16 winner card (story size).
 *
 * Rendered at a LOGICAL width (see `cardSize`) and captured at 1080×1920 by
 * `captureShareCard` — react-native-view-shot on Android/iOS, html-to-image on
 * web — so the image people post is exactly what is on screen.
 *
 * Everything inside must be capturable on web too, which is why:
 *  - photos use the ORIGINAL media url on web, served through the same-origin
 *    `/share-media/` proxy (src/lib/shareMedia.ts). The capture then reads the
 *    copy already in the browser cache: no CORS, and no second download.
 *  - decorations are plain Views (no Lottie, no video): a screenshot of a
 *    VideoView is black.
 *  - `onReady` fires only once the hero photo (or its fallback) has painted, so
 *    the caller never captures a blank frame.
 */

export const CARD_ASPECT = 16 / 9;
export const CARD_EXPORT = { width: 1080, height: 1920 } as const;
/** Fire `onReady` after this long even if an image event never arrived. */
const READY_TIMEOUT_MS = 4000;
const CARD_BG = '#1B0B22';

export function cardSize(screenWidth: number, screenHeight: number): { width: number; height: number } {
  // Fit the screen with room for the buttons below, never wider than a phone.
  const byWidth = Math.min(screenWidth - 32, 380);
  const byHeight = (screenHeight - 260) / CARD_ASPECT;
  const width = Math.max(240, Math.floor(Math.min(byWidth, byHeight)));
  return { width, height: Math.round(width * CARD_ASPECT) };
}

/** Pick the capturable still for an entry. */
function stillFor(side: ResultSide | null, videoPoster: string | null): string | null {
  if (!side) return null;
  if (side.isVideo) return webCapturable(videoPoster || side.avatarUrl);
  if (Platform.OS === 'web') return webCapturable(side.mediaUrl || side.photoUrl);
  return side.photoUrl || side.mediaUrl;
}

/**
 * Web: show the photo from the same-origin `/share-media/` proxy, so the bytes the
 * capture needs are already in the browser cache (one download, not two, and no
 * CORS). Falls back to the url itself when it is not proxyable.
 */
function webCapturable(url: string | null | undefined): string | null {
  if (!url) return null;
  return Platform.OS === 'web' ? sameOriginMediaUrl(url) ?? url : url;
}

/**
 * Deterministic confetti, so every capture of the same card is identical. Kept to
 * the side margins and the strip above the title, so no piece ever sits on the
 * headline, the crown or the photo.
 */
const CONFETTI = Array.from({ length: 26 }, (_, i) => {
  const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  const zone = i % 3; // 0 = left margin, 1 = right margin, 2 = top strip
  const left = zone === 0 ? r(1) * 9 : zone === 1 ? 89 + r(1) * 8 : 4 + r(1) * 90;
  const top = zone === 2 ? r(2) * 7 : 3 + r(2) * 55;
  return {
    left: `${Math.round(left)}%` as const,
    top: `${Math.round(top)}%` as const,
    w: 4 + Math.round(r(3) * 6),
    h: 8 + Math.round(r(4) * 8),
    rot: `${Math.round(r(5) * 360)}deg`,
    color: ['#FFD700', '#FF4D67', '#FF8A4D', '#FFFFFF', '#7C5CFF', '#22D3EE'][i % 6],
    opacity: 0.55 + r(6) * 0.45,
  };
});

interface Props {
  summary: BattleResultSummary;
  width: number;
  /** Called once the card's images have painted (or failed to) — safe to capture. */
  onReady?: () => void;
}

export const WinnerCard = forwardRef<View, Props>(({ summary, width, onReady }, ref) => {
  // Not rounded: the capture scales this box to exactly 1080×1920.
  const height = width * CARD_ASPECT;
  const k = width / 360; // all sizes are designed at 360pt wide
  const isTie = summary.outcome === 'tie';
  const hero = isTie ? null : summary.winner;

  const heroPoster = useVideoStatus(hero?.isVideo ? hero.mediaUrl : null).thumbnailUrl ?? null;
  const aPoster = useVideoStatus(isTie && summary.a?.isVideo ? summary.a.mediaUrl : null).thumbnailUrl ?? null;
  const bPoster = useVideoStatus(isTie && summary.b?.isVideo ? summary.b.mediaUrl : null).thumbnailUrl ?? null;

  const photos = useMemo(
    () => (isTie ? [stillFor(summary.a, aPoster), stillFor(summary.b, bPoster)] : [stillFor(hero, heroPoster)]),
    [isTie, summary.a, summary.b, hero, aPoster, bPoster, heroPoster],
  );
  const prize = summary.prize;
  // Product photo for the prize block, only when the capture can read it.
  const safePrize =
    prize?.kind === 'product' ? cardSafePrizeImage(prize.imageUrl, hero?.mediaUrl ?? photos[0], Platform.OS === 'web') : null;
  const prizeImage = safePrize ? webCapturable(safePrize) : null;

  // Ready once the logo and every CURRENT photo have loaded or errored. Tracked
  // per slot+uri (a Set, not a counter), so a repeated onLoad cannot over-count
  // and a photo that changes (a video poster resolving) only re-arms its own slot
  // — the logo, which loads once, is never waited for again.
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const mark = useCallback((key: string) => {
    setLoaded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);
  const wanted = useMemo(
    () => [
      'logo',
      ...photos.map((u, i) => (u ? `p${i}:${u}` : null)).filter((k): k is string => !!k),
      ...(prizeImage ? [`prize:${prizeImage}`] : []),
    ],
    [photos, prizeImage],
  );
  const allLoaded = wanted.every((k) => loaded.has(k));
  const readyFired = useRef(false);
  const photoKey = wanted.join('|');
  useEffect(() => {
    readyFired.current = false;
  }, [photoKey]);
  useEffect(() => {
    const fire = () => {
      if (readyFired.current) return;
      readyFired.current = true;
      onReady?.();
    };
    // One frame for the browser/GPU to paint the decoded images.
    if (allLoaded) {
      const t = setTimeout(fire, 250);
      return () => clearTimeout(t);
    }
    // Never wait forever: an image event that does not arrive must not block
    // sharing. The capture step re-checks the images (web) or falls back.
    const cap = setTimeout(fire, READY_TIMEOUT_MS);
    return () => clearTimeout(cap);
  }, [allLoaded, photoKey, onReady]);

  const f = (n: number) => Math.round(n * k);
  const photoStyle = (w: number, h: number) => ({ width: f(w), height: f(h), borderRadius: f(22) });

  // A plain render helper, NOT a component: a component declared inside render
  // is a new type every render, so React would remount the image on every state
  // change — re-firing onLoad and never letting the card settle.
  const renderPhoto = (slot: number, uri: string | null, w: number, h: number, label: string) =>
    uri ? (
      <ExpoImage
        key={`p${slot}:${uri}`}
        source={{ uri }}
        style={photoStyle(w, h)}
        contentFit="cover"
        // No crossfade: a capture mid-fade would bake a half-transparent photo.
        transition={0}
        cachePolicy="memory-disk"
        onLoad={() => mark(`p${slot}:${uri}`)}
        onError={() => mark(`p${slot}:${uri}`)}
        accessibilityLabel={label}
      />
    ) : (
      <View style={[photoStyle(w, h), styles.photoFallback]}>
        <MaterialCommunityIcons name="trophy" size={f(64)} color="#FFD700" />
      </View>
    );

  return (
    <View ref={ref} collapsable={false} style={{ width, height, borderRadius: f(28), overflow: 'hidden', backgroundColor: CARD_BG }}>
      <LinearGradient
        colors={['#2A0B33', '#5B1146', '#C2185B', '#FF4D67']}
        locations={[0, 0.35, 0.75, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Soft glow behind the photo */}
      <View
        style={{
          position: 'absolute',
          width: f(320),
          height: f(320),
          borderRadius: f(160),
          backgroundColor: 'rgba(255,215,0,0.16)',
          top: f(130),
          left: (width - f(320)) / 2,
        }}
      />
      {CONFETTI.map((c, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: c.left,
            top: c.top,
            width: f(c.w),
            height: f(c.h),
            borderRadius: f(2),
            backgroundColor: c.color,
            opacity: c.opacity,
            transform: [{ rotate: c.rot }],
          }}
        />
      ))}

      <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: f(20), paddingTop: f(18), paddingBottom: f(20) }}>
        {/* Brand */}
        {/*
          The logo is a 3:1 wordmark. The old 104x25 box (4.2:1) drew it at only
          ~75x25. A 3:1 box with less pill padding draws it at 93x31, and the pill
          stays 37 tall (31 + 2x3), so nothing below moves. The winner-with-prize
          layout already uses nearly all of the 640-tall card, so a taller pill
          could push the footer off the bottom.
        */}
        <View style={[styles.logoPill, { paddingHorizontal: f(12), paddingVertical: f(3), borderRadius: f(18) }]}>
          <RNImage
            source={images.tophuntLogo}
            style={{ width: f(93), height: f(31) }}
            resizeMode="contain"
            onLoad={() => mark('logo')}
            onError={() => mark('logo')}
            accessibilityLabel="TopHunt"
          />
        </View>

        <Text style={[styles.congrats, { fontSize: f(isTie ? 30 : 27), lineHeight: f(isTie ? 36 : 33), marginTop: f(10), letterSpacing: f(1.5) }]}>
          {isTie ? "IT'S A TIE!" : 'CONGRATULATIONS'}
        </Text>
        <Text style={[styles.contest, { fontSize: f(13), lineHeight: f(18), marginTop: f(4) }]} numberOfLines={1}>
          {summary.title}
        </Text>

        {/* Hero */}
        {isTie ? (
          <View style={{ flexDirection: 'row', gap: f(12), marginTop: f(26), alignItems: 'center' }}>
            {[summary.a, summary.b].map((p, i) => (
              <View key={i} style={{ alignItems: 'center' }}>
                <View style={[styles.goldFrame, { padding: f(4), borderRadius: f(26) }]}>
                  {renderPhoto(i, photos[i] ?? null, 146, 200, `@${p?.username} entry`)}
                </View>
                <Text style={[styles.handle, { fontSize: f(16), marginTop: f(10) }]} numberOfLines={1}>@{p?.username}</Text>
                <Text style={[styles.sub, { fontSize: f(13) }]}>{votesLabel(p?.votes ?? 0)}</Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={{ alignItems: 'center', marginTop: f(8) }}>
            {/* In normal flow (not absolute), overlapping only the photo's top edge,
                so it can never sit on the contest title above. */}
            <View style={{ zIndex: 2, marginBottom: -f(18), height: f(46), justifyContent: 'center' }}>
              <MaterialCommunityIcons name="crown" size={f(46)} color="#FFD700" />
            </View>
            <LinearGradient
              colors={['#FFF4B0', '#FFD700', '#E6A200']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ padding: f(5), borderRadius: f(27) }}
            >
              {prize
                ? renderPhoto(0, photos[0] ?? null, 170, 196, `@${hero?.username} winning entry`)
                : renderPhoto(0, photos[0] ?? null, 222, 262, `@${hero?.username} winning entry`)}
            </LinearGradient>
            <View style={[styles.winnerBadge, { marginTop: -f(16), paddingHorizontal: f(16), paddingVertical: f(6), borderRadius: f(16) }]}>
              <Ionicons name="trophy" size={f(14)} color="#5A3A00" />
              <Text style={[styles.winnerBadgeText, { fontSize: f(13), marginLeft: f(6), letterSpacing: f(1.5) }]}>WINNER</Text>
            </View>
            <Text style={[styles.handle, { fontSize: f(25), marginTop: f(8) }]} numberOfLines={1}>@{hero?.username}</Text>
          </View>
        )}

        {/* Score */}
        {!isTie && hero ? (
          <View style={[styles.scoreBox, { marginTop: f(prize ? 8 : 10), paddingVertical: f(prize ? 7 : 9), paddingHorizontal: f(16), borderRadius: f(18) }]}>
            <Text style={[styles.scoreBig, { fontSize: f(22) }]}>
              {votesLabel(hero.votes)}
              {summary.loser ? <Text style={[styles.sub, { fontSize: f(15) }]}>{`  vs  ${summary.loser.votes}`}</Text> : null}
            </Text>
            <Text style={[styles.sub, { fontSize: f(13), marginTop: f(2) }]}>
              {summary.margin > 0 ? `Won by ${votesLabel(summary.margin)} · ${summary.winnerPct}% of votes` : `${summary.winnerPct}% of votes`}
            </Text>
            {summary.loser ? (
              <Text style={[styles.sub, { fontSize: f(12), marginTop: f(4), opacity: 0.85 }]} numberOfLines={1}>
                against @{summary.loser.username}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Prize won: a minted coin for Dpcoins, the product's photo for a product. */}
        {prize ? (
          <View style={[styles.prizeBox, { marginTop: f(10), padding: f(8), paddingRight: f(14), borderRadius: f(18), gap: f(10) }]}>
            {prize.kind === 'coins' ? (
              <CoinMedallion size={f(46)} />
            ) : (
              <View style={[styles.prizeThumb, { width: f(50), height: f(50), borderRadius: f(12), borderWidth: f(2) }]}>
                {prizeImage ? (
                  <ExpoImage
                    key={`prize:${prizeImage}`}
                    source={{ uri: prizeImage }}
                    style={{ width: '100%', height: '100%' }}
                    contentFit="cover"
                    transition={0}
                    cachePolicy="memory-disk"
                    onLoad={() => mark(`prize:${prizeImage}`)}
                    onError={() => mark(`prize:${prizeImage}`)}
                    accessibilityLabel={prize.title}
                  />
                ) : (
                  <Ionicons name="gift" size={f(26)} color="#E6A200" />
                )}
              </View>
            )}
            <View style={{ flexShrink: 1 }}>
              <Text style={[styles.prizeLabel, { fontSize: f(10), letterSpacing: f(1.5) }]}>PRIZE WON</Text>
              {prize.kind === 'coins' ? (
                <Text style={[styles.prizeAmount, { fontSize: f(22), lineHeight: f(26) }]} numberOfLines={1}>
                  {coinsLabel(prize.coins)}
                  <Text style={[styles.prizeUnit, { fontSize: f(13) }]}> Dpcoins</Text>
                </Text>
              ) : (
                <>
                  <Text style={[styles.prizeTitle, { fontSize: f(14), lineHeight: f(17) }]} numberOfLines={2}>
                    {prize.title}
                  </Text>
                  {prize.value > 0 ? (
                    <Text style={[styles.prizeUnit, { fontSize: f(12), marginTop: f(1) }]}>Worth ₹{coinsLabel(prize.value)}</Text>
                  ) : null}
                </>
              )}
            </View>
          </View>
        ) : null}

        <View style={{ flex: 1, minHeight: f(8) }} />

        {/* Footer */}
        <Text style={[styles.footerCta, { fontSize: f(15) }]}>Vote. Battle. Win.</Text>
        <Text style={[styles.footerUrl, { fontSize: f(12), marginTop: f(2) }]}>tophunt.in</Text>
      </View>
    </View>
  );
});

WinnerCard.displayName = 'WinnerCard';

/** Background for capture flattening (matches the card's darkest corner). */
export const WINNER_CARD_BG = CARD_BG;

const styles = StyleSheet.create({
  logoPill: { backgroundColor: '#FFFFFF', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  congrats: { flexShrink: 0, fontFamily: 'Urbanist-Bold', color: '#FFD700', textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.35)', textShadowRadius: 6, textShadowOffset: { width: 0, height: 2 } },
  contest: { fontFamily: 'Urbanist-SemiBold', color: 'rgba(255,255,255,0.9)', textAlign: 'center', flexShrink: 0 },
  goldFrame: { backgroundColor: '#FFD700' },
  photoFallback: { backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' },
  winnerBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFD700', borderWidth: 2, borderColor: '#FFF4B0' },
  winnerBadgeText: { fontFamily: 'Urbanist-Bold', color: '#5A3A00' },
  handle: { fontFamily: 'Urbanist-Bold', color: '#FFFFFF', textAlign: 'center', maxWidth: '100%' },
  sub: { fontFamily: 'Urbanist-SemiBold', color: 'rgba(255,255,255,0.88)', textAlign: 'center' },
  scoreBox: { backgroundColor: 'rgba(0,0,0,0.28)', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  scoreBig: { fontFamily: 'Urbanist-Bold', color: '#FFFFFF', textAlign: 'center' },
  prizeBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.32)', borderWidth: 1.5, borderColor: '#FFD700', maxWidth: '94%' },
  prizeThumb: { backgroundColor: '#FFFFFF', borderColor: '#FFD700', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  prizeLabel: { fontFamily: 'Urbanist-Bold', color: '#FFD700' },
  prizeAmount: { fontFamily: 'Urbanist-Bold', color: '#FFFFFF' },
  prizeUnit: { fontFamily: 'Urbanist-SemiBold', color: '#FFE68A' },
  prizeTitle: { fontFamily: 'Urbanist-Bold', color: '#FFFFFF' },
  footerCta: { fontFamily: 'Urbanist-Bold', color: '#FFFFFF', letterSpacing: 1 },
  footerUrl: { fontFamily: 'Urbanist-SemiBold', color: 'rgba(255,255,255,0.8)', letterSpacing: 1.5 },
});
