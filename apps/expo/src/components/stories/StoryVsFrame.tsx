import React, { useCallback, useRef, useState } from 'react';
import { View, Text, StyleSheet, Dimensions, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@/src/lib/icons';
import { Avatar } from '@/src/components/ui/Avatar';
import { CoinIcon } from '@/src/components/ui/CoinIcon';
import { contestService } from '@/src/services/contests/contestService';
import { resolveVsFrame, vsImageOf } from '@/src/lib/vsStory';

const { width, height } = Dimensions.get('window');

/**
 * The head-to-head frame for a `contest_vs` story: both entries side by side with
 * a VS badge between them.
 *
 * Composed here at render time rather than baked into an image on the server,
 * because there is no server-side image composition available — see
 * `apps/worker/src/lib/matchStories.ts` for the full reasoning. The upside is that
 * this frame stays live: it reads the match, so the title, prize and both entries
 * are always current, and it needs no extra storage or cleanup.
 *
 * Visual language is deliberately the same as the feed's battle card
 * (`components/home/PostCard.tsx`): two rounded halves, a gradient VS orb
 * overlapping the gap, avatars and handles underneath.
 */

type Props = {
  matchId: string;
  /** Falls back to this while the match loads, so the frame is never empty. */
  fallbackMediaUrl?: string;
  contestTitle?: string | null;
  /**
   * Fired once when this frame is safe to screenshot: both halves are real
   * photographs that have finished decoding, and no composite exists yet.
   *
   * This exists because `captureRef` copies *painted pixels*. Capturing on a
   * timer would sometimes catch a half-decoded frame and produce a card with a
   * grey rectangle where someone's entry should be — and because the first
   * recorded card wins, that mistake would be permanent for both users. So the
   * signal comes from the images themselves.
   *
   * Deliberately never fires for a video battle: a `VideoView`'s surface is not
   * part of the view hierarchy the screenshot walks, so a captured video battle
   * is two black rectangles. Those keep the live frame instead.
   */
  onCaptureReady?: () => void;
};

/** One side of the battle. Videos show their first frame, muted and still. */
const VsSide: React.FC<{
  uri?: string | null;
  isVideo: boolean;
  label: string;
  /** Called when this side's photo has decoded — success only, never on error. */
  onPhotoLoad?: () => void;
}> = ({ uri, isVideo, label, onPhotoLoad }) => {
  // A story is a glance, not a watch — a paused first frame reads better than two
  // videos competing for attention, and avoids two decoders for one frame.
  const player = useVideoPlayer(isVideo && uri ? uri : null, (p) => {
    p.muted = true;
    p.pause();
  });

  return (
    <View style={styles.side}>
      <View style={styles.mediaWrap}>
        {isVideo && uri ? (
          <VideoView player={player} style={styles.media} contentFit="cover" nativeControls={false} />
        ) : (
          <Image
            source={uri ? { uri } : undefined}
            style={styles.media}
            contentFit="cover"
            transition={150}
            onLoad={uri ? onPhotoLoad : undefined}
          />
        )}
        {isVideo && (
          <View style={styles.videoPip}>
            <Ionicons name="videocam" size={12} color="#FFF" />
          </View>
        )}
      </View>
      <Text style={styles.sideLabel} numberOfLines={1}>@{label}</Text>
    </View>
  );
};

export const StoryVsFrame: React.FC<Props> = ({ matchId, fallbackMediaUrl, contestTitle, onCaptureReady }) => {
  const { data: match, isLoading } = useQuery({
    queryKey: ['match', matchId],
    queryFn: () => contestService.getMatchById(matchId),
    // A battle's participants never change once it is live, so this is stable
    // for the life of the story.
    staleTime: 60_000,
    enabled: !!matchId,
  });

  // Which two entries to draw and in which order — see src/lib/vsStory.ts. Null
  // means a head-to-head frame is not possible (the battle could not be loaded,
  // which happens legitimately when a participant is blocked by this viewer), so
  // fall back to the single entry this story row already carries.
  const frame = resolveVsFrame(match);

  // A composite has already been produced for this battle, so show that single
  // image rather than re-assembling the layout. It is the same picture either
  // way, but this is one decode instead of two and it is exactly what gets
  // shared, so what the user sees is what they send.
  //
  // The trade-off, accepted deliberately: the card was captured at ONE device's
  // aspect ratio, so on a differently-shaped screen `contain` letterboxes it
  // against the black story background. Cropping to fill instead could cut the VS
  // badge or someone's face off the edge, and the point of the card is that both
  // users are looking at the identical image.
  const composite = vsImageOf(match);

  // A recorded card that will not load. The cron clears the column when the
  // battle's stories expire, but a match can be read after its card is gone and
  // before that write lands — and an `Image` pointed at a 404 renders nothing at
  // all. Falling back to the live layout means a dead card degrades to the old
  // behaviour instead of an empty black story.
  const [compositeFailed, setCompositeFailed] = useState<string | null>(null);
  const useComposite = !!composite && compositeFailed !== composite;

  // Track which entry photos have decoded, so `onCaptureReady` fires on the real
  // thing rather than a guess. Keyed by URI rather than by side, and never reset:
  // an `Image` whose `uri` has not changed does NOT re-fire `onLoad`, so a second
  // battle in the same reel that reuses one participant's entry would otherwise
  // never reach two and would never produce a card. A uri that decoded once is
  // decoded.
  //
  // Held in refs: nothing rendered depends on them, and a re-render per decoded
  // image would restart the sibling's fade transition.
  const loadedUris = useRef<Set<string>>(new Set());
  const notifiedMatch = useRef<string | null>(null);

  const readyRef = useRef(onCaptureReady);
  readyRef.current = onCaptureReady;

  const leftUri = frame?.left.uri ?? null;
  const rightUri = frame?.right.uri ?? null;
  const markUriLoaded = useCallback(
    (uri: string | null) => {
      if (!uri) return;
      loadedUris.current.add(uri);
      // Once per battle, and only when BOTH halves are known-decoded.
      if (notifiedMatch.current === matchId) return;
      if (!leftUri || !rightUri) return;
      if (!loadedUris.current.has(leftUri) || !loadedUris.current.has(rightUri)) return;
      notifiedMatch.current = matchId;
      readyRef.current?.();
    },
    [matchId, leftUri, rightUri],
  );
  const onLeftLoad = useCallback(() => markUriLoaded(leftUri), [markUriLoaded, leftUri]);
  const onRightLoad = useCallback(() => markUriLoaded(rightUri), [markUriLoaded, rightUri]);

  if (isLoading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#FFF" />
      </View>
    );
  }

  if (!frame) {
    return (
      <View style={styles.container}>
        {fallbackMediaUrl ? (
          <Image source={{ uri: fallbackMediaUrl }} style={styles.fallback} contentFit="contain" />
        ) : null}
      </View>
    );
  }

  if (useComposite) {
    return (
      <View style={styles.container}>
        <Image
          source={{ uri: composite! }}
          style={styles.media}
          contentFit="contain"
          transition={150}
          onError={() => setCompositeFailed(composite!)}
        />
      </View>
    );
  }

  return (
    <LinearGradient colors={['#1B1226', '#2A1330', '#40121F']} style={styles.container}>
      <View style={styles.card}>
        <View style={styles.livePill}>
          <View style={styles.liveDot} />
          <Text style={styles.livePillText}>BATTLE LIVE</Text>
        </View>

        <Text style={styles.title} numberOfLines={2}>
          {frame.title || contestTitle || 'Battle'}
        </Text>

        {/* Both entries, side by side, with the VS badge between them. */}
        <View style={styles.row}>
          <VsSide
            uri={frame.left.uri}
            isVideo={frame.isVideo}
            label={frame.left.username}
            onPhotoLoad={frame.isVideo ? undefined : onLeftLoad}
          />
          <VsSide
            uri={frame.right.uri}
            isVideo={frame.isVideo}
            label={frame.right.username}
            onPhotoLoad={frame.isVideo ? undefined : onRightLoad}
          />

          {/* Overlaps the gap between the two halves, like the feed card. */}
          <View pointerEvents="none" style={styles.vsBadge}>
            <LinearGradient
              colors={['#FF4D7E', '#FF8A4D']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.vsBadgeGradient}
            >
              <Text style={styles.vsBadgeText}>VS</Text>
            </LinearGradient>
          </View>
        </View>

        <View style={styles.footerRow}>
          <Avatar uri={frame.left.avatarUri} name={frame.left.username} size={26} />
          <Avatar uri={frame.right.avatarUri} name={frame.right.username} size={26} style={styles.overlapAvatar} />
          {frame.prize > 0 && (
            <View style={styles.prizePill}>
              <CoinIcon size={12} color="#FFD54F" />
              <Text style={styles.prizeText}>{frame.prize}</Text>
            </View>
          )}
        </View>

        {/*
          The domain is IN the frame, not just in the share text. When this gets
          captured and sent as an image file the message is dropped — a share sheet
          attaching a picture carries no caption — so a card with no link on it
          would travel with nothing pointing back at the app.
        */}
        <Text style={styles.cta}>Vote on tophunt.in — fans decide the winner</Text>
      </View>
    </LinearGradient>
  );
};

const CARD_W = width - 32;
const SIDE_H = Math.min(height * 0.34, 320);

const styles = StyleSheet.create({
  container: { width, height, justifyContent: 'center', alignItems: 'center' },
  fallback: { width, height },
  card: { width: CARD_W, alignItems: 'center' },

  livePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#FF4D67', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 100,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FFF' },
  livePillText: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Bold', letterSpacing: 0.6 },

  title: {
    color: '#FFF', fontSize: 20, fontFamily: 'Urbanist-Bold',
    textAlign: 'center', marginTop: 12, marginBottom: 16, paddingHorizontal: 8,
  },

  row: { flexDirection: 'row', gap: 12, width: '100%', position: 'relative' },
  side: { flex: 1 },
  mediaWrap: {
    width: '100%', height: SIDE_H, borderRadius: 20, overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)',
  },
  media: { width: '100%', height: '100%' },
  videoPip: {
    position: 'absolute', top: 8, right: 8,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 100, padding: 5,
  },
  sideLabel: {
    color: '#FFF', fontSize: 13, fontFamily: 'Urbanist-Bold',
    textAlign: 'center', marginTop: 8, opacity: 0.95,
  },

  vsBadge: { position: 'absolute', top: '50%', left: 0, right: 0, alignItems: 'center', marginTop: -22, zIndex: 15 },
  vsBadgeGradient: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: '#FFF',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 5,
  },
  vsBadgeText: { fontFamily: 'Urbanist-Bold', fontSize: 15, color: '#FFF', letterSpacing: 0.5 },

  footerRow: { flexDirection: 'row', alignItems: 'center', marginTop: 18 },
  overlapAvatar: { marginLeft: -10 },
  prizePill: {
    flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 12,
    backgroundColor: 'rgba(255,213,79,0.16)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 100,
  },
  prizeText: { color: '#FFD54F', fontSize: 13, fontFamily: 'Urbanist-Bold' },

  cta: {
    color: 'rgba(255,255,255,0.7)', fontSize: 12, fontFamily: 'Urbanist-Medium',
    marginTop: 14, textAlign: 'center',
  },
});

export default StoryVsFrame;
