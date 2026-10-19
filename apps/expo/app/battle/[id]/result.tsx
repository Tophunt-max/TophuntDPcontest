import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  StatusBar,
  ActivityIndicator,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import LottieView from 'lottie-react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { contestService } from '@/src/services/contests/contestService';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import { useAuth } from '@/src/hooks/useAuth';
import { useToast } from '@/src/components/toast/ToastProvider';
import { useWebSeo } from '@/src/lib/webSeo';
import { WinnerCard, CARD_EXPORT, WINNER_CARD_BG, cardSize } from '@/src/components/result/WinnerCard';
import { captureShareCard, releaseVsCard } from '@/src/lib/vsImage';
import { resolveBattleShareAsset } from '@/src/lib/vsShareAsset';
import { drawWebVsCard } from '@/src/hooks/useBattleShareAsset';
import {
  battleResultUrl,
  copyBattleLink,
  downloadBattleImage,
  prepareShareFile,
  saveImageAndCopyCaption,
  shareBattleLink,
  shareImageFile,
  type ShareImageSource,
  type ShareOutcome,
} from '@/src/lib/share';
import { AppImage } from '@/src/components/ui/AppImage';
import { CoinMedallion } from '@/src/components/result/CoinMedallion';
import {
  coinsLabel,
  resultHeadline,
  summarizeResult,
  viewerRole,
  winnerCaption,
  winnerShareMessage,
} from '@/src/lib/battleResult';
import { formatClock } from '@/src/lib/countdown';

/**
 * `/battle/<id>/result` — the winner page.
 *
 * Shows the branded 9:16 winner card (src/components/result/WinnerCard.tsx) and
 * shares a SCREENSHOT of exactly that card, on Android, iOS and web:
 *   1. the card is captured once, in the background, as soon as its images have
 *      painted (so the Share tap itself does no slow work — Safari and Chrome only
 *      honour `navigator.share` inside the user gesture);
 *   2. Share sends that image through the OS / Web Share sheet;
 *   3. a browser that cannot attach files downloads the image and copies the
 *      caption instead, so the user still leaves with the picture;
 *   4. if the capture is impossible (old native build, unreadable image), it
 *      falls back to the server-rendered VS card — or, on web, a VS card drawn
 *      in the browser when the server's is late — and only then to the link,
 *      saying so.
 *
 * Web capture reads every photo through the same-origin `/share-media/` proxy
 * (src/lib/shareMedia.ts), so CORS on media.tophunt.in cannot break it.
 *
 * States: still live (countdown + back to the battle), result pending (polls
 * while the server settles), winner, tie, voided, missing.
 */
const PENDING_POLL_MS = 3000;
const PENDING_MAX_POLLS = 40;

export default function BattleResult() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = typeof rawId === 'string' ? rawId : '';
  const router = useRouter();
  const { user } = useAuth();
  const { addToast } = useToast();
  const isDark = useColorScheme() === 'dark';
  const bg = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const sub = isDark ? '#A0A0A0' : '#666';
  const { width: screenW, height: screenH } = useWindowDimensions();
  const size = cardSize(screenW, screenH);

  const { data: match, isLoading, refetch } = useQuery({
    queryKey: ['battle', id, user?.uid ?? 'guest'],
    queryFn: () => contestService.getMatchById(id),
    enabled: !!id,
    staleTime: 10_000,
    // While the result is being declared, re-read (each read also nudges the
    // Worker to settle, lib/settleDue.ts). Bounded; stops as soon as it lands.
    // (Bounded by the number of answers actually received — this callback also
    // runs on every render, so it must not count anything itself.)
    refetchInterval: (q) => {
      const m: any = q.state.data;
      const pending = m?.status === 'active' && m?.expiresAt && Number(new Date(m.expiresAt)) <= Date.now();
      if (!pending || q.state.dataUpdateCount > PENDING_MAX_POLLS) return false;
      return PENDING_POLL_MS;
    },
  });

  const summary = useMemo(() => summarizeResult(match), [match]);
  // Held for moderation review (several reports, e.g. a QR / payment scam):
  // the battle stays viewable by link, but is not turned into a share asset.
  const held = !!(match as any)?.moderationHeld;
  const role = viewerRole(summary, user?.uid);
  const headline = resultHeadline(summary, role);
  const hasResult = !held && (summary.outcome === 'winner' || summary.outcome === 'tie');
  const url = battleResultUrl(id);
  const caption = winnerCaption(summary, url);

  useWebSeo({
    title: summary.winner ? `🏆 @${summary.winner.username} won — ${summary.title}` : `${summary.title} — Result`,
    description: summary.winner
      ? `@${summary.winner.username} won with ${summary.winner.votes} votes on TopHunt.`
      : 'See who won this battle on TopHunt.',
    canonical: id ? `https://tophunt.in/battle/${encodeURIComponent(id)}/result` : undefined,
    image: typeof match?.vsImageUrl === 'string' ? match.vsImageUrl : undefined,
    type: 'article',
  });

  // ---- capture (background, once per result) --------------------------------
  const cardRef = useRef<View>(null);
  const [cardReady, setCardReady] = useState(false);
  const [capture, setCapture] = useState<{ uri: string; file: File | null } | null>(null);
  const [captureFailed, setCaptureFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const captureKey = `${id}:${summary.outcome}:${summary.winner?.uid ?? ''}:${summary.totalVotes}`;

  useEffect(() => {
    setCardReady(false);
    setCapture(null);
    setCaptureFailed(false);
  }, [captureKey]);

  useEffect(() => {
    if (!cardReady || !hasResult || capture || captureFailed) return;
    let alive = true;
    (async () => {
      const uri = await captureShareCard(cardRef.current, { ...CARD_EXPORT, quality: 0.92, backgroundColor: WINNER_CARD_BG });
      if (!alive) {
        releaseVsCard(uri);
        return;
      }
      if (!uri) {
        setCaptureFailed(true);
        return;
      }
      // Web: hold a File so the Share tap can call navigator.share immediately.
      const file = Platform.OS === 'web' ? await prepareShareFile({ kind: 'local', uri }, 'tophunt-winner.jpg') : null;
      if (alive) setCapture({ uri, file });
      else releaseVsCard(uri);
    })();
    return () => {
      alive = false;
    };
  }, [cardReady, hasResult, capture, captureFailed]);

  // Free the temp file / blob when it is replaced or the page closes.
  useEffect(() => () => releaseVsCard(capture?.uri), [capture?.uri]);

  const onCardReady = useCallback(() => setCardReady(true), []);

  const toastFor = useCallback(
    (outcome: ShareOutcome) => {
      const msg = winnerShareMessage(outcome);
      if (msg) addToast(msg.text, msg.tone);
    },
    [addToast],
  );

  // When the card cannot be captured (old native build, unreadable image on web),
  // resolve the server VS card AHEAD of the tap and keep its File, so Share still
  // calls navigator.share with no network wait (Safari drops the gesture after
  // an await and would ask for "one more tap" forever).
  const [fallback, setFallback] = useState<{ source: ShareImageSource; file: File | null } | null | 'none'>(null);
  useEffect(() => setFallback(null), [captureKey]);
  useEffect(() => {
    if (!captureFailed || fallback !== null || !hasResult) return;
    let alive = true;
    (async () => {
      // Server VS card first; on web, if that is late or its renderer is failing,
      // a VS card drawn in the browser — so this never degrades to a text link
      // just because the server is slow.
      const asset = await resolveBattleShareAsset(id, {
        fetchShareImage: contestService.getMatchShareImage,
        capture: Platform.OS === 'web' ? () => drawWebVsCard(id) : undefined,
        captureVideo: Platform.OS === 'web',
      });
      if (!alive) {
        if (asset.status === 'ready' && asset.source.kind === 'local') releaseVsCard(asset.source.uri);
        return;
      }
      if (asset.status !== 'ready') return setFallback('none');
      const file = Platform.OS === 'web' ? await prepareShareFile(asset.source, 'tophunt-winner.jpg') : null;
      if (alive) setFallback({ source: asset.source, file });
    })();
    return () => {
      alive = false;
    };
  }, [captureFailed, fallback, hasResult, id]);

  const fallbackLocal = fallback && fallback !== 'none' && fallback.source.kind === 'local' ? fallback.source.uri : null;
  useEffect(() => () => releaseVsCard(fallbackLocal), [fallbackLocal]);

  /** The image to send, already prepared: the card screenshot, else the server VS card, else none. */
  const shareSource = useCallback((): { source: ShareImageSource; file: File | null } | null => {
    if (capture) return { source: { kind: 'local', uri: capture.uri }, file: capture.file };
    if (fallback && fallback !== 'none') return fallback;
    return null;
  }, [capture, fallback]);
  const sharePreparing = hasResult && !capture && (!captureFailed || fallback === null);

  const onShare = useCallback(async () => {
    if (busy) return;
    if (sharePreparing) {
      addToast('Winner card taiyaar ho raha hai — ek second…', 'info');
      return;
    }
    setBusy(true);
    try {
      const picked = shareSource();
      if (!picked) {
        // Say so: the user asked for the card and is getting only a link.
        addToast('Card image nahi ban payi — result link share kar rahe hain.', 'info');
        toastFor(await shareBattleLink({ caption, url }));
        return;
      }
      let outcome = await shareImageFile({ source: picked.source, caption, url, file: picked.file });
      // A browser that cannot attach files: give them the picture anyway.
      if (outcome === 'image_unsupported' && Platform.OS === 'web') {
        outcome = await saveImageAndCopyCaption(picked.source, caption, 'tophunt-winner.jpg');
      }
      toastFor(outcome);
    } finally {
      setBusy(false);
    }
  }, [busy, sharePreparing, shareSource, caption, url, toastFor, addToast]);

  const onSave = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const picked = shareSource();
      const target = picked?.source.kind === 'local' ? picked.source.uri : picked?.source.kind === 'remote' ? picked.source.url : null;
      const ok = await downloadBattleImage(target, 'tophunt-winner.jpg');
      addToast(ok ? (Platform.OS === 'web' ? 'Winner card downloaded' : 'Choose “Save image”') : 'Could not save the image.', ok ? 'success' : 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, shareSource, addToast]);

  const onCopy = useCallback(async () => {
    await copyBattleLink(url);
    addToast('Result link copied!', 'success');
  }, [url, addToast]);

  const goBattle = () => router.replace(`/battle/${encodeURIComponent(id)}` as any);
  const goHome = () => router.replace('/home');
  const startBattle = () => router.push('/contest/photo' as any);

  // ---- render -----------------------------------------------------------------
  const header = (
    <View style={[styles.header, { borderBottomColor: isDark ? '#23262D' : '#EEF0F4' }]}>
      <BackButton size={24} color={textColor} />
      <Text style={[styles.headerTitle, { color: textColor }]} numberOfLines={1}>
        Result
      </Text>
    </View>
  );

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color="#FF4D67" size="large" />
      </View>
    );
  } else if (held) {
    body = (
      <View style={styles.center}>
        <Ionicons name="shield-checkmark-outline" size={44} color="#FF4D67" />
        <Text style={[styles.stateTitle, { color: textColor }]}>Result under review</Text>
        <Text style={[styles.stateBody, { color: sub }]}>
          Is battle ko report kiya gaya hai aur hamari team ise check kar rahi hai.
        </Text>
        <TouchableOpacity style={styles.cta} onPress={goHome} accessibilityRole="button">
          <Text style={styles.ctaText}>See more battles</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (!match || summary.outcome === 'voided') {
    body = (
      <View style={styles.center}>
        <Text style={[styles.stateTitle, { color: textColor }]}>
          {match ? 'Battle voided' : 'Result not available'}
        </Text>
        <Text style={[styles.stateBody, { color: sub }]}>
          {match
            ? 'Minimum votes poore nahi hue, isliye entry fees refund kar di gayi.'
            : 'Ye battle hata diya gaya ho sakta hai, ya link galat hai.'}
        </Text>
        <TouchableOpacity style={styles.cta} onPress={goHome} accessibilityRole="button">
          <Text style={styles.ctaText}>See more battles</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (summary.outcome === 'live' || summary.outcome === 'waiting') {
    const left = formatClock(match.expiresAt);
    body = (
      <View style={styles.center}>
        <Ionicons name="time-outline" size={44} color="#FF4D67" />
        <Text style={[styles.stateTitle, { color: textColor }]}>Battle abhi live hai</Text>
        <Text style={[styles.stateBody, { color: sub }]}>
          {summary.outcome === 'waiting' ? 'Opponent ka intezaar hai.' : left ? `Result ${left} mein aayega.` : 'Result jaldi aayega.'}
        </Text>
        <TouchableOpacity style={styles.cta} onPress={goBattle} accessibilityRole="button">
          <Text style={styles.ctaText}>Vote karo</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (summary.outcome === 'pending') {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color="#FF4D67" size="large" />
        <Text style={[styles.stateTitle, { color: textColor, marginTop: 16 }]}>Contest Ended</Text>
        <Text style={[styles.stateBody, { color: sub }]}>Result aa raha hai… votes final ho rahe hain.</Text>
        <TouchableOpacity style={[styles.secondary, { borderColor: isDark ? '#35383F' : '#E5E7EB' }]} onPress={() => refetch()} accessibilityRole="button">
          <Text style={[styles.secondaryText, { color: textColor }]}>Refresh</Text>
        </TouchableOpacity>
      </View>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.headline, { color: textColor }]}>{headline.title}</Text>
        {headline.subtitle ? <Text style={[styles.subline, { color: sub }]}>{headline.subtitle}</Text> : null}

        <View style={styles.cardShadow}>
          <WinnerCard ref={cardRef} summary={summary} width={size.width} onReady={onCardReady} />
        </View>

        <TouchableOpacity onPress={onShare} disabled={busy} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="Share winner card">
          <View style={[styles.shareBtn, busy && { opacity: 0.6 }]}>
            {busy ? <ActivityIndicator color="#FFF" /> : <Ionicons name="share-social" size={20} color="#FFF" />}
            <Text style={styles.shareText}>{role === 'winner' ? 'Share your win' : 'Share winner card'}</Text>
          </View>
        </TouchableOpacity>
        {sharePreparing ? <Text style={[styles.hint, { color: sub }]}>Preparing the image…</Text> : null}

        <View style={styles.row}>
          <SmallAction icon="download" label="Save image" onPress={onSave} color={textColor} border={isDark ? '#35383F' : '#E5E7EB'} disabled={busy} />
          <SmallAction icon="link" label="Copy link" onPress={onCopy} color={textColor} border={isDark ? '#35383F' : '#E5E7EB'} />
          <SmallAction icon="eye-outline" label="View battle" onPress={goBattle} color={textColor} border={isDark ? '#35383F' : '#E5E7EB'} />
        </View>

        <PrizeSection
          summary={summary}
          isWinner={role === 'winner'}
          isDark={isDark}
          textColor={textColor}
          sub={sub}
          onClaim={() => router.push(`/prizes/${encodeURIComponent(id)}` as any)}
          onWallet={() => router.push('/wallet' as any)}
        />

        <TouchableOpacity style={[styles.cta, styles.newBattle]} onPress={startBattle} accessibilityRole="button">
          <Text style={styles.ctaText}>{role === 'loser' ? 'Naya battle shuru karo 💪' : 'Apna battle shuru karo'}</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bg }]} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      {header}
      {body}
      {hasResult ? (
        // Page-only celebration: never part of the captured card.
        <View style={StyleSheet.absoluteFill} pointerEvents="none">
          <LottieView
            source={{ uri: 'https://assets2.lottiefiles.com/packages/lf20_u4y36v.json' }}
            autoPlay
            loop={false}
            style={StyleSheet.absoluteFill}
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

/**
 * What the winner took home — revealed here, never on the feed card. Dpcoins as
 * a minted coin, a product with its photo; a tie says the entry fees came back.
 */
function PrizeSection(props: {
  summary: ReturnType<typeof summarizeResult>;
  isWinner: boolean;
  isDark: boolean;
  textColor: string;
  sub: string;
  onClaim: () => void;
  onWallet: () => void;
}) {
  const { summary, isWinner, isDark, textColor, sub } = props;
  const prize = summary.prize;
  const winnerName = summary.winner ? `@${summary.winner.username}` : 'Winner';
  const box = [styles.prizeSection, { backgroundColor: isDark ? '#2A2410' : '#FFF8DB', borderColor: isDark ? '#5C4A12' : '#FFE08A' }];

  if (summary.outcome === 'tie') {
    return (
      <View style={box} accessible accessibilityLabel="It's a tie. Both players' entry fees were refunded.">
        <Text style={[styles.prizeKicker, { color: isDark ? '#FFD54F' : '#B07800' }]}>RESULT</Text>
        <Text style={[styles.prizeHeading, { color: textColor }]}>🤝 It&apos;s a tie!</Text>
        <Text style={[styles.prizeNote, { color: sub }]}>Dono players ki entry fee wallet mein wapas aa gayi.</Text>
      </View>
    );
  }
  if (!prize) return null;

  if (prize.kind === 'coins') {
    return (
      <View style={box} accessible accessibilityLabel={`${winnerName} won ${prize.coins} Dpcoins`}>
        <Text style={[styles.prizeKicker, { color: isDark ? '#FFD54F' : '#B07800' }]}>{isWinner ? 'AAPKA PRIZE' : 'PRIZE WON'}</Text>
        <View style={styles.prizeRow}>
          <CoinMedallion size={64} />
          <View style={styles.prizeInfo}>
            <Text style={[styles.prizeAmount, { color: textColor }]} numberOfLines={1}>
              {coinsLabel(prize.coins)} <Text style={styles.prizeUnit}>Dpcoins</Text>
            </Text>
            <Text style={[styles.prizeNote, { color: sub }]}>
              {isWinner ? 'Aapke wallet mein credit ho gaye ✅' : `${winnerName} ne jeete`}
            </Text>
          </View>
        </View>
        {isWinner ? (
          <TouchableOpacity style={[styles.cta, styles.prizeCta]} onPress={props.onWallet} accessibilityRole="button">
            <Text style={styles.ctaText}>Wallet dekho</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  return (
    <View style={box} accessible accessibilityLabel={`${winnerName} won ${prize.title}${prize.value > 0 ? `, worth ₹${prize.value}` : ''}`}>
      <Text style={[styles.prizeKicker, { color: isDark ? '#FFD54F' : '#B07800' }]}>{isWinner ? 'AAPKA PRIZE' : 'PRIZE WON'}</Text>
      <View style={styles.prizeRow}>
        <View style={[styles.productThumb, { backgroundColor: isDark ? '#1F1F24' : '#FFFFFF' }]}>
          {prize.imageUrl ? (
            <AppImage source={{ uri: prize.imageUrl }} style={styles.productImage} contentFit="cover" accessibilityLabel={prize.title} />
          ) : (
            <Ionicons name="gift" size={40} color="#E6A200" />
          )}
        </View>
        <View style={styles.prizeInfo}>
          <Text style={[styles.productTitle, { color: textColor }]} numberOfLines={3}>{prize.title}</Text>
          {prize.value > 0 ? <Text style={styles.productValue}>Worth ₹{coinsLabel(prize.value)}</Text> : null}
          <Text style={[styles.prizeNote, { color: sub }]}>
            {isWinner ? 'Address do — hum aap tak deliver karenge 🚚' : `${winnerName} ko milega`}
          </Text>
        </View>
      </View>
      {isWinner ? (
        <TouchableOpacity style={[styles.cta, styles.prizeCta]} onPress={props.onClaim} accessibilityRole="button">
          <Text style={styles.ctaText}>🎁 Claim your prize</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function SmallAction(props: { icon: string; label: string; onPress: () => void; color: string; border: string; disabled?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.small, { borderColor: props.border }, props.disabled && { opacity: 0.6 }]}
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="button"
      accessibilityLabel={props.label}
    >
      <Ionicons name={props.icon as any} size={18} color={props.color} />
      <Text style={[styles.smallText, { color: props.color }]}>{props.label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  stateTitle: { fontFamily: 'Urbanist-Bold', fontSize: 20, textAlign: 'center', marginTop: 12 },
  stateBody: { fontFamily: 'Urbanist-Regular', fontSize: 14, textAlign: 'center', marginTop: 8 },
  scroll: { alignItems: 'center', padding: 16, paddingBottom: 40 },
  headline: { fontFamily: 'Urbanist-Bold', fontSize: 24, textAlign: 'center' },
  subline: { fontFamily: 'Urbanist-Medium', fontSize: 14, textAlign: 'center', marginTop: 4, marginBottom: 14 },
  cardShadow: { marginTop: 4, borderRadius: 28, shadowColor: '#FF4D67', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 10 },
  shareBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#FF4D67', height: 54, borderRadius: 27, paddingHorizontal: 32, marginTop: 20, minWidth: 260 },
  shareText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 17 },
  hint: { fontFamily: 'Urbanist-Medium', fontSize: 12, marginTop: 6 },
  row: { flexDirection: 'row', gap: 10, marginTop: 16, flexWrap: 'wrap', justifyContent: 'center' },
  small: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, height: 40 },
  smallText: { fontFamily: 'Urbanist-SemiBold', fontSize: 13 },
  cta: { backgroundColor: '#FF4D67', height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, marginTop: 20 },
  ctaText: { color: '#fff', fontFamily: 'Urbanist-Bold', fontSize: 16 },
  prizeCta: { backgroundColor: '#E6A200', minWidth: 240, marginTop: 14 },
  prizeSection: { width: '100%', maxWidth: 420, borderWidth: 1, borderRadius: 20, padding: 16, marginTop: 22, alignItems: 'center' },
  prizeKicker: { fontFamily: 'Urbanist-Bold', fontSize: 11, letterSpacing: 1.6, marginBottom: 10 },
  prizeHeading: { fontFamily: 'Urbanist-Bold', fontSize: 20, textAlign: 'center' },
  prizeRow: { flexDirection: 'row', alignItems: 'center', gap: 14, alignSelf: 'stretch' },
  prizeInfo: { flex: 1, minWidth: 0 },
  prizeAmount: { fontFamily: 'Urbanist-Bold', fontSize: 28 },
  prizeUnit: { fontFamily: 'Urbanist-SemiBold', fontSize: 16, color: '#E6A200' },
  prizeNote: { fontFamily: 'Urbanist-Medium', fontSize: 13, marginTop: 4 },
  productThumb: { width: 96, height: 96, borderRadius: 16, borderWidth: 2, borderColor: '#FFD700', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  productImage: { width: '100%', height: '100%' },
  productTitle: { fontFamily: 'Urbanist-Bold', fontSize: 17 },
  productValue: { fontFamily: 'Urbanist-Bold', fontSize: 14, color: '#E6A200', marginTop: 2 },
  newBattle: { backgroundColor: '#1F2937', minWidth: 260 },
  secondary: { marginTop: 20, borderWidth: 1, borderRadius: 22, paddingHorizontal: 24, height: 44, justifyContent: 'center' },
  secondaryText: { fontFamily: 'Urbanist-SemiBold', fontSize: 14 },
});
