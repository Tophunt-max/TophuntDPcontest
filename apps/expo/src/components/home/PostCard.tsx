import React, { useState, memo, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Pressable, ActivityIndicator, AccessibilityInfo } from 'react-native';
import { AppImage as ExpoImage } from '../ui/AppImage';
import { useDesignWindow } from '@/src/lib/layout';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons, MaterialCommunityIcons } from '@/src/lib/icons';
import { CommentSheet } from '../comments/CommentSheet';
import { ShareSheet } from '../share/ShareSheet';
import { useAuth } from '@/src/hooks/useAuth';
import { useAuthGate } from '@/src/hooks/useAuthGate';
import { contestService } from '@/src/services/contests/contestService';
import { readApi } from '@/src/services/api';
import { live } from '@/src/services/realtime';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { LinearGradient } from 'expo-linear-gradient';
import { useToast } from '../toast/ToastProvider';
import { BATTLE_REPORT_REASONS, useReportReason } from '../modals/ReportReasonDialog';
import { engagementService } from '@/src/services/contests/engagementService';
import { Avatar } from '../ui/Avatar';
import { VerifiedBadge } from '../ui/VerifiedBadge';
import { useVideoStatus } from '@/src/hooks/useVideoStatus';
import { useCountdown } from '@/src/hooks/useCountdown';
import { useHlsVideo } from '@/src/hooks/useHlsVideo';
import { matchPrize } from '@/src/lib/contestPrize';
import * as Haptics from 'expo-haptics';
import LottieView from 'lottie-react-native';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withSpring, 
  withSequence, 
  withDelay,
  withTiming,
  withRepeat,
  runOnJS
} from 'react-native-reanimated';
import { 
  HeartIcon_Light, 
  HeartIcon_Filled, 
  ChatIcon_Light, 
  Share_Icon, 
  Bookmark_Outline, 
  Bookmark_Filled 
} from '@/assets/svgs';
import { needsCatchUp, shouldListen } from '@/src/lib/liveWindow';
import { battleResultPath, RESULT_REFETCH_DELAYS_MS } from '@/src/lib/battleResult';
import { ArrowIcon } from '../ui/ArrowIcon';
import { Alert } from '@/src/lib/appAlert';
import { enqueueOutbox, isNetworkFailure, pendingIntent } from '@/src/sync';
import { overlayFlag, overlayLike } from '@/src/sync/overlay';

interface PostCardProps {
    item: any;
    isDark: boolean;
    onMatchEnded?: (matchId: string) => void;
    /**
     * Ranked feeds only (Home). When set, the flag button becomes a "More options"
     * menu with "Not interested" and "Report"; the callback removes the card once
     * the server has recorded the dismissal.
     */
    onNotInterested?: (matchId: string) => void;
    /**
     * Whether this card should hold a live `match:<id>` subscription. Defaults to
     * true. The Home feed passes false for cards that are mounted but off screen,
     * so a long feed holds only a few sockets (see src/lib/liveWindow.ts).
     */
    liveActive?: boolean;
    /**
     * Whether this card's videos may play now (on screen, screen focused, app
     * in the foreground, no reduce-motion). Defaults to true for screens that
     * do not track visibility. See src/lib/playbackPolicy.ts.
     */
    playActive?: boolean;
}

const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);
const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

// --- Media (cached images + autoplay video) --------------------------------
// expo-image gives disk caching + a smooth fade, so re-scrolling a feed doesn't
// re-download every image (less R2 bandwidth, faster paint).
//
// Whole picture, never cropped: the slot is a fixed 260 tall and ~0.65 wide-to-
// tall, but entries are 4:5 (photos), 9:16 (videos) or anything (older uploads).
// `cover` cut ~19% off a 4:5 photo's sides. Now the media is drawn with
// `contain`, and the space it leaves is filled with a blurred copy of the same
// image (same URI, so it comes from the memory cache, not a second download).

/** Blurred, dimmed fill behind contained media. Decorative only. */
const FitBackdrop = ({ uri }: { uri?: string | null }) =>
  uri ? (
    <>
      <ExpoImage
        source={uri}
        // Blurred to mush anyway: the smallest variant (128) is plenty and is
        // usually already in the cache from a thumbnail elsewhere.
        displayWidth={40}
        noPreview
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        blurRadius={24}
        accessible={false}
        pointerEvents="none"
      />
      <View style={[StyleSheet.absoluteFill, styles.fitDim]} pointerEvents="none" />
    </>
  ) : null;

const PhotoMedia = ({ uri, style, width }: { uri?: string; style: any; width?: number }) => (
  <View style={[style, styles.fitFrame]}>
    <FitBackdrop uri={uri} />
    {/* Loaded at the slot's real width (half the card): the 640 variant on a
        typical phone instead of the 1080 one, with a 128 preview underneath. */}
    <ExpoImage source={uri} displayWidth={width} style={StyleSheet.absoluteFill} contentFit="contain" />
  </View>
);

// Photo/Video are SEPARATE components so a photo battle never instantiates a
// video player (the useVideoPlayer hook only runs inside VideoMedia). Video
// battles autoplay muted + looping; FlatList virtualization unmounts off-screen
// cards, which releases their players.
const VideoMedia = ({ uri, style, active }: { uri: string; style: any; active: boolean }) => {
  // Bunny videos need ~10-60s of encoding after upload. Until then there is no
  // playlist to play, so show the poster frame instead of mounting a player that
  // would just error. R2 videos report status null and skip all of this.
  const { isProcessing, isFailed, thumbnailUrl } = useVideoStatus(uri);
  // Resolves playback per platform: the HLS playlist (plus expo-video's disk
  // cache) on native, and on web hls.js attached to the player's own <video>, so
  // the browser plays that same playlist instead of a guessed `play_720p.mp4`
  // that 404s whenever Bunny never encoded that rendition.
  // Web: only download segments while this card may play.
  const { hostRef, playerSource, failed: streamFailed } = useHlsVideo(uri, { load: active });

  const player = useVideoPlayer(isProcessing || isFailed ? null : playerSource, (p) => {
    p.loop = true;
    p.muted = true;
    // No play() here: whether this card may play is `active`'s decision
    // (src/lib/playbackPolicy.ts). It also could not work on web, where the
    // <video> element does not exist yet when this setup callback runs.
  });

  useEffect(() => {
    try {
      if (active) player.play();
      else player.pause();
    } catch {
      /* the player was released while unmounting */
    }
  }, [active, player]);

  // The poster stays up until the first frame is drawn, instead of a black box
  // while the stream starts.
  const [firstFrame, setFirstFrame] = useState(false);
  useEffect(() => setFirstFrame(false), [playerSource]);

  if (isProcessing || isFailed || streamFailed) {
    return (
      <View style={[style, styles.videoPlaceholder]}>
        {!!thumbnailUrl && (
          <>
            <FitBackdrop uri={thumbnailUrl} />
            <ExpoImage source={{ uri: thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="contain" />
          </>
        )}
        <View style={styles.videoPlaceholderOverlay}>
          {isFailed || streamFailed ? (
            <Text style={styles.videoPlaceholderText}>Video unavailable</Text>
          ) : (
            <>
              <ActivityIndicator color="#FFF" />
              <Text style={styles.videoPlaceholderText}>Processing…</Text>
            </>
          )}
        </View>
      </View>
    );
  }

  // The wrapper carries `hostRef` so hls.js can find the <video> on web; on
  // native the ref is undefined and this is an inert View.
  return (
    <View ref={hostRef} style={[style, styles.fitFrame]}>
      {/* The poster, blurred, fills the bars around the contained video. */}
      <FitBackdrop uri={thumbnailUrl} />
      <VideoView
        player={player}
        style={[StyleSheet.absoluteFill, styles.videoClear]}
        contentFit="contain"
        nativeControls={false}
        onFirstFrameRender={() => setFirstFrame(true)}
      />
      {!firstFrame && !!thumbnailUrl && (
        <ExpoImage
          source={{ uri: thumbnailUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          pointerEvents="none"
          accessibilityIgnoresInvertColors
        />
      )}
    </View>
  );
};

const BattleMedia = ({
  isVideo,
  uri,
  style,
  active,
  width,
}: {
  isVideo: boolean;
  uri?: string;
  style: any;
  active: boolean;
  width?: number;
}) =>
  isVideo && uri ? <VideoMedia uri={uri} style={style} active={active} /> : <PhotoMedia uri={uri} style={style} width={width} />;

/** Compact vote count formatting (1.2k / 3.4M) for the on-image chips. */
const formatVotes = (n: number): string => {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  return String(value);
};

export const PostCard = memo(({ item, isDark, onMatchEnded, onNotInterested, liveActive = true, playActive = true }: PostCardProps) => {
  const { user } = useAuth();
  const { requireAuth } = useAuthGate();
  // Each A/B slot: the card column minus mediaSection's 16px side margins and
  // 12px gap, halved. Drives the responsive image size (src/lib/imageVariants.ts).
  const { width: columnWidth } = useDesignWindow();
  const slotWidth = Math.max(1, (columnWidth - 32 - 12) / 2);
  const router = useRouter();
  const { addToast } = useToast();

  /** Open a participant's public profile. No-op if the uid is missing. */
  const openProfile = useCallback((uid?: string | null) => {
    if (!uid) return;
    router.push(`/profile?userId=${uid}`);
  }, [router]);
  const [showComments, setShowComments] = useState(false);
  const [showShare, setShowShare] = useState(false);
  // Seed from the server-provided per-viewer state so a like/bookmark survives
  // a refresh (the feed list + /matches/:id now both return these flags).
  // A like/bookmark made offline and still queued wins over the server's
  // older answer (src/sync/overlay.ts), so a refetch does not undo it.
  const initialLike = overlayLike(!!item.isLiked, item.likeCount || 0, pendingIntent('match.like', item.id));
  const [isLiked, setIsLiked] = useState(initialLike.liked);
  const [isBookmarked, setIsBookmarked] = useState(
    overlayFlag(!!item.isBookmarked, pendingIntent('match.bookmark', item.id)?.bookmarked),
  );
  const [showConfetti, setShowConfetti] = useState(false);
  
  const cardColor = isDark ? '#181B21' : '#FFFFFF';
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  const trackColor = isDark ? '#2A2E37' : '#EEF0F4';

  // Real-time states
  const initialVotesA = Number(item.userA.votes || 0);
  const initialVotesB = Number(item.userB?.votes || 0);
  const initialTotal = initialVotesA + initialVotesB;
  const initialProgressA = initialTotal > 0 ? initialVotesA / initialTotal : 0.5;
  const [votesA, setVotesA] = useState(initialVotesA);
  const [votesB, setVotesB] = useState(initialVotesB);
  const [likeCount, setLikeCount] = useState(initialLike.count);
  const [commentCount, setCommentCount] = useState(item.commentCount || 0);
  const [shareCount, setShareCount] = useState(item.shareCount || 0);
  const [progressA, setProgressA] = useState(initialProgressA);
  const [matchStatus, setMatchStatus] = useState(item.status || 'active');
  const [isVoting, setIsVoting] = useState(false);
  const [submittingForUid, setSubmittingForUid] = useState<string | null>(null);
  const [hasVoted, setHasVoted] = useState(!!item.hasVoted);
  const [votedForUid, setVotedForUid] = useState<string | null>(item.votedForUid || null);

  // Animation values
  const heartScale = useSharedValue(0);
  const barProgress = useSharedValue(initialProgressA);
  const voteScaleA = useSharedValue(1);
  const voteScaleB = useSharedValue(1);
  const livePulse = useSharedValue(1);
  const lastTap = useRef<number>(0);
  const lastVoteTotal = useRef(initialTotal);
  const isHeartAnimating = useRef<boolean>(false);
  const likeInFlight = useRef<boolean>(false);

  const voteAnimA = useAnimatedStyle(() => ({ transform: [{ scale: voteScaleA.value }] }));
  const voteAnimB = useAnimatedStyle(() => ({ transform: [{ scale: voteScaleB.value }] }));
  const liveDotStyle = useAnimatedStyle(() => ({ opacity: livePulse.value }));

  // A quick tap "squash" so pressing a vote button feels responsive.
  const pulseButton = useCallback((sv: typeof voteScaleA) => {
    sv.value = withSequence(
      withTiming(0.92, { duration: 90 }),
      withSpring(1, { damping: 9, stiffness: 220 }),
    );
  }, []);

  const applyTally = useCallback((nextVotesA: number, nextVotesB: number) => {
    const total = nextVotesA + nextVotesB;
    // waitUntil publishes and in-flight HTTP reads may complete out of order.
    // Active vote totals only increase, so never let an older snapshot roll back.
    if (total < lastVoteTotal.current) return;
    lastVoteTotal.current = total;
    setVotesA(nextVotesA);
    setVotesB(nextVotesB);
    const nextProgress = total > 0 ? nextVotesA / total : 0.5;
    setProgressA(nextProgress);
    barProgress.value = withSpring(nextProgress, { damping: 15, stiffness: 100 });
  }, [barProgress]);

  // When the card last stopped listening — seeded with the MOUNT time, because
  // FlatList mounts cards well below the screen and such a card has been "not
  // listening" since then. A return after a long gap catches up once instead of
  // showing counts that froze while it was away.
  const liveEndedAtRef = useRef<number | null>(Date.now());
  const canListen = shouldListen({ liveActive, signedIn: !!user?.uid, status: matchStatus });

  /** Apply a full `/read/matches/:id` answer to the card. */
  const applyDetail = useCallback((data: any) => {
    if (!data) return;
    applyTally(Number(data.userA?.votes || 0), Number(data.userB?.votes || 0));
    const like = overlayLike(
      typeof data.isLiked === 'boolean' ? data.isLiked : false,
      data.likeCount || 0,
      typeof data.isLiked === 'boolean' ? pendingIntent('match.like', item.id) : undefined,
    );
    setLikeCount(like.count);
    setCommentCount(data.commentCount || 0);
    setShareCount(data.shareCount || 0);
    setMatchStatus(data.status || 'active');
    if (typeof data.hasVoted === 'boolean') setHasVoted(data.hasVoted);
    if ('votedForUid' in data) setVotedForUid(data.votedForUid || null);
    // Keep the viewer's own like/bookmark state in sync (survives refresh).
    if (typeof data.isLiked === 'boolean') setIsLiked(like.liked);
    if (typeof data.isBookmarked === 'boolean') {
      setIsBookmarked(overlayFlag(data.isBookmarked, pendingIntent('match.bookmark', item.id)?.bookmarked));
    }
  }, [applyTally, item.id]);

  useEffect(() => {
    if (!item.id || !canListen) return;
    const catchUp = needsCatchUp(liveEndedAtRef.current);
    liveEndedAtRef.current = null;

    // Self-contained vote/status events update the card immediately. Other
    // engagement events refetch details; live() coalesces overlapping refreshes.
    const unsub = live<any>(
      `match:${item.id}`,
      () => readApi(`/read/matches/${item.id}`),
      applyDetail,
      {
        // The feed/profile list already hydrated this card (votes, counts,
        // isLiked/hasVoted, winner), so skip the redundant initial GET of
        // /read/matches/:id — a big saving of D1 reads + DO calls across a feed.
        // The WebSocket keeps it live; the safety-net poll is slow (WS handles
        // real-time) so idle cards barely touch the backend.
        // …unless it was off screen long enough to have missed events, in which case
        // one catch-up read is cheaper than leaving stale counts (see liveWindow.ts).
        immediate: catchUp,
        fallbackMs: 180000,
        // Self-contained push payloads update counts instantly. This avoids a
        // refetch that would otherwise read D1's batched (up to ~5s stale)
        // counters — the reason like/comment counts felt slow to move.
        onEvent: (event) => {
          switch (event.type) {
            case 'vote':
            case 'match_status':
              applyTally(Number(event.votesA || 0), Number(event.votesB || 0));
              if (event.type === 'match_status' && event.status) setMatchStatus(String(event.status));
              break;
            case 'like':
              if (typeof event.likeCount === 'number') setLikeCount(event.likeCount);
              break;
            case 'comment':
              if (typeof event.commentCount === 'number') setCommentCount(event.commentCount);
              break;
            case 'share':
              if (typeof event.shareCount === 'number') setShareCount(event.shareCount);
              break;
          }
        },
        shouldRefresh: (event) => {
          switch (event.type) {
            case 'vote':
            case 'match_status':
              return false;
            case 'like':
              return typeof event.likeCount !== 'number';
            case 'comment':
              return typeof event.commentCount !== 'number';
            case 'share':
              return typeof event.shareCount !== 'number';
            default:
              return true;
          }
        },
      },
    );
    return () => {
      unsub();
      liveEndedAtRef.current = Date.now();
    };
  }, [applyTally, applyDetail, item.id, user?.uid, canListen]);

  useEffect(() => {
    // Cancelled/voided battles disappear; completed ones stay to show the result.
    if (matchStatus === 'cancelled') onMatchEnded?.(item.id);
  }, [item.id, matchStatus, onMatchEnded]);

  const animatedBarStyleA = useAnimatedStyle(() => ({
    width: `${barProgress.value * 100}%`,
  }));
  const animatedBarStyleB = useAnimatedStyle(() => ({
    width: `${(1 - barProgress.value) * 100}%`,
  }));

  const triggerHaptic = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const handleDoubleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      // A guest's double-tap asks them to sign in rather than animating a like
      // that cannot happen.
      if (!user) {
        lastTap.current = 0;
        requireAuth('like');
        return;
      }
      if (!isHeartAnimating.current) {
        isHeartAnimating.current = true;
        // Fast pop-in, brief hold, quick fade-out so the heart doesn't linger.
        heartScale.value = withSequence(
            withTiming(1.25, { duration: 130 }),
            withDelay(110, withTiming(0, { duration: 140 }, (finished) => {
                if (finished) runOnJS(() => { isHeartAnimating.current = false; })();
            }))
        );
        if (!isLiked) handleLike();
        triggerHaptic();
      }
    }
    lastTap.current = now;
  };

  const funnyVoteMessages = [
    "Dhanyawaad! Aapka vote swikar kar liya gaya hai.",
    "Wah! Kya baat hai. Aapka favorite khiladi khush hoga!",
    "Zabardast! Aapka vote count ho chuka hai.",
    "Aapne toh game hi badal diya! Vote done!",
    "Shukriya! Aapne sahi jagah apna nishana lagaya."
  ];

  // Show the real username in the header, names and vote buttons; the join ID
  // is only a fallback when a participant snapshot has no username.
  const nameA = item.userA?.username || item.joinIdA || "User A";
  const nameB = item.userB?.username || item.joinIdB || "User B";

  const getRandomMessage = (messages: string[]) => {
    return messages[Math.floor(Math.random() * messages.length)];
  };

  const handleVote = async (selectedUid: string) => {
    if (!user) return void requireAuth('vote');
    if (isVoting || hasVoted) return;
    const endDate = item.expiresAt?.toDate ? item.expiresAt.toDate() : new Date(item.expiresAt);
    if (matchStatus !== 'active' || !item.expiresAt || endDate.getTime() <= Date.now()) {
      addToast('Voting has closed for this battle.', 'info');
      return;
    }

    triggerHaptic();
    setIsVoting(true);
    setSubmittingForUid(selectedUid);
    try {
      // contestService owns the stable per-install identifier. Never pass a
      // shared placeholder from UI code.
      const result = await contestService.voteOnMatch(item.id, selectedUid);
      const nextVotesA = Number(result?.votesA ?? votesA);
      const nextVotesB = Number(result?.votesB ?? votesB);
      applyTally(nextVotesA, nextVotesB);
      setHasVoted(true);
      setVotedForUid(selectedUid);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 3000);
      const successMessage = getRandomMessage(funnyVoteMessages);
      addToast(successMessage, 'success');
      AccessibilityInfo.announceForAccessibility(`Vote submitted for ${selectedUid === item.userA.uid ? nameA : nameB}.`);
    } catch (error: any) {
      if (String(error?.code || '').includes('already-exists')) {
        setHasVoted(true);
        try {
          const detail: any = await contestService.getMatchById(item.id);
          setVotedForUid(detail?.votedForUid || null);
          if (detail?.userA && detail?.userB) {
            applyTally(
              Number(detail.userA.votes || 0),
              Number(detail.userB.votes || 0),
            );
          }
        } catch {
          // Keep voting disabled even if state restoration temporarily fails.
        }
      }
      const message = error.message || "Vote fail ho gaya!";
      addToast(message, 'error');
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setIsVoting(false);
      setSubmittingForUid(null);
    }
  };
  
  const handleLike = async () => {
    if (!user) return void requireAuth('like');
    // In-flight guard: rapid taps must not fire overlapping toggle requests
    // (which desync the count and hammer the DB).
    if (likeInFlight.current) return;
    likeInFlight.current = true;
    triggerHaptic();
    const next = !isLiked;
    // Optimistic: flip the heart AND move the count immediately.
    setIsLiked(next);
    setLikeCount((c: number) => Math.max(0, c + (next ? 1 : -1)));
    try {
      const res: any = await contestService.likeMatch(item.id, next);
      // Trust the server's final liked state; the broadcast 'like' event
      // carries the authoritative count and reconciles it for everyone.
      if (res && typeof res.liked === 'boolean') setIsLiked(res.liked);
      if (next) addToast("Zabardast Like!", 'success');
    } catch (error) {
      // No answer at all (offline, dropped connection): keep the heart and
      // send it later. It used to roll back without a word.
      if (isNetworkFailure(error) && (await enqueueOutbox('match.like', item.id, { liked: next }))) {
        addToast(next ? 'Like saved. It will sync when you are back online.' : 'Will sync when you are back online.', 'info');
        return;
      }
      // The server answered with a refusal: follow it.
      setIsLiked(!next);
      setLikeCount((c: number) => Math.max(0, c + (next ? -1 : 1)));
    } finally {
      likeInFlight.current = false;
    }
  };

  const handleShare = async () => {
    // Sharing a public battle needs no account (the sheet gates DMs itself).
    triggerHaptic();
    setShowShare(true);
  };

  const handleBookmark = async () => {
    if (!user) return void requireAuth('bookmark');
    triggerHaptic();
    const prevStatus = isBookmarked;
    const next = !prevStatus;
    // Optimistic.
    setIsBookmarked(next);
    try {
      const status = await engagementService.toggleBookmark(item.id, user.uid, next);
      setIsBookmarked(status);
      addToast(status ? "Saved to your profile!" : "Removed from bookmarks!", 'info');
    } catch (error) {
      if (isNetworkFailure(error) && (await enqueueOutbox('match.bookmark', item.id, { bookmarked: next }))) {
        addToast('Saved offline. It will sync when you are back online.', 'info');
        return;
      }
      // Roll back to the value BEFORE the tap. This used `!isBookmarked`, which
      // read the stale pre-tap value and re-applied the optimistic state, so a
      // failed bookmark stayed shown as saved.
      setIsBookmarked(prevStatus);
    }
  };

  const animatedHeartStyle = useAnimatedStyle(() => ({
    transform: [{ scale: heartScale.value }],
    opacity: heartScale.value > 0.1 ? 1 : 0,
  }));

  // Shared with the contest cards — see src/hooks/useCountdown.ts. A match with
  // no expiresAt has always been treated as closed here (unlike a contest with
  // no endsAt, which never expires), so that mapping is kept explicit.
  // Per-second: the card shows a live HH:MM:SS clock.
  const countdown = useCountdown(item.expiresAt, { precision: 'second' });
  const timeRemaining = countdown.label ?? 'Ended';

  const votingClosed = matchStatus !== 'active' || countdown.ended || countdown.label === null;
  const votingDisabled = isVoting || hasVoted || votingClosed;

  // Pulse the little "live" dot in the countdown while voting is still open.
  useEffect(() => {
    if (votingClosed) {
      livePulse.value = 1;
      return;
    }
    livePulse.value = withRepeat(
      withSequence(withTiming(0.35, { duration: 700 }), withTiming(1, { duration: 700 })),
      -1,
      false,
    );
  }, [votingClosed, livePulse]);

  // Urgency: highlight the countdown chip in the final hour of an open battle.
  const isUrgent = !votingClosed && countdown.urgent;

  // Voting is over but the server has not declared the result yet. Normally a
  // few seconds: the first re-read below kicks the Worker's settlement
  // (lib/settleDue.ts) and the realtime `match_status` event lands right after.
  const isPendingResult = matchStatus === 'active' && countdown.ended;
  useEffect(() => {
    // Only for a card someone can see: a long feed must not poll for every
    // off-screen battle that happened to end.
    if (!isPendingResult || !item.id || !liveActive) return;
    let cancelled = false;
    const timers = RESULT_REFETCH_DELAYS_MS.map((delay) =>
      setTimeout(async () => {
        if (cancelled) return;
        try {
          const data = await readApi(`/read/matches/${item.id}`);
          if (!cancelled) applyDetail(data);
        } catch {
          /* the next attempt, the socket event or the safety-net poll will retry */
        }
      }, delay),
    );
    // Remaining attempts are cancelled the moment the status changes.
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [isPendingResult, item.id, liveActive, applyDetail]);

  // The result landing WHILE the card is on screen gets a small celebration.
  // (Not on first render: a feed full of finished battles must not all burst.)
  const prevStatusRef = useRef(matchStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = matchStatus;
    if (prev === 'active' && matchStatus === 'completed') {
      setShowConfetti(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const t = setTimeout(() => setShowConfetti(false), 3500);
      return () => clearTimeout(t);
    }
  }, [matchStatus]);

  /**
   * Report spam / QR-payment scams / fake entries with a reason, in the same
   * dialog as the profile report. Server dedupes per user.
   */
  const { askReason, dialog: reportDialog } = useReportReason();
  const handleReport = useCallback(async () => {
    if (!user) return void requireAuth('report');
    let failed = false;
    const sent = await askReason({
      title: 'Report this battle?',
      message: 'Kya galat hai? Hamari team review karegi. Report anonymous hai.',
      reasons: BATTLE_REPORT_REASONS,
      onSubmit: async (reason) => {
        try {
          await contestService.reportMatch(item.id, reason);
        } catch (e) {
          failed = true;
          throw e;
        }
      },
    });
    if (sent) addToast('Thanks — report submit ho gaya. Team review karegi.', 'success');
    else if (failed) addToast('Report submit nahi ho paya. Dobara try karein.', 'error');
  }, [user, requireAuth, askReason, item.id, addToast]);

  const isOwnBattle = !!user && (item.userA?.uid === user.uid || item.userB?.uid === user.uid);
  // Signed-in viewers on a ranked feed, and never on their own battle (the server refuses that).
  const showMoreMenu = !!onNotInterested && !!user && !isOwnBattle;

  const handleNotInterested = useCallback(async () => {
    try {
      await contestService.setFeedDismissal(item.id, true);
      // The list removes the card and offers Undo (app/home.tsx).
      onNotInterested?.(item.id);
    } catch {
      addToast('Save nahi ho paya. Dobara try karein.', 'error');
    }
  }, [item.id, onNotInterested, addToast]);

  const openMoreMenu = useCallback(() => {
    Alert.alert('More options', undefined, [
      { text: 'Not interested', onPress: () => void handleNotInterested() },
      { text: 'Report', style: 'destructive', onPress: () => void handleReport() },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [handleNotInterested, handleReport]);

  const openResult = useCallback(() => {
    if (item.id) router.push(battleResultPath(item.id) as any);
  }, [item.id, router]);

  const isVideo = item.type === 'video';
  const isALeading = votesA > votesB;
  const isBLeading = votesB > votesA;
  const votedForA = votedForUid === item.userA.uid;
  const votedForB = votedForUid === item.userB?.uid;

  // Finished battle ('ended' is the legacy spelling of 'completed').
  const isCompleted = matchStatus === 'completed' || matchStatus === 'ended';
  // The live tally (meter, percentages, vote counts, leader crown) is shown ONLY
  // while voting is open. Once the deadline passes the card reveals nothing about
  // who is ahead or who won — the votes, the winner and the prize are revealed on
  // the result page (app/battle/[id]/result.tsx), which "View Result" opens.
  const showTally = !votingClosed;
  // Visual highlight of the live leader, while voting is open only.
  const aWins = showTally && isALeading;
  const bWins = showTally && isBLeading;

  // Null when the user has no photo — <Avatar> renders local initials.
  // profilePicThumb / mediaUrlOptimized come from the Worker's enrichMatchMedia
  // and are identical to the originals until Transformations is enabled, so
  // preferring them is safe today and gets lighter automatically at cutover.
  const picA = item.userA.profilePicThumb || item.userA.profilePic || item.userA.profileImageUrl || null;
  const picB = item.userB?.profilePicThumb || item.userB?.profilePic || item.userB?.profileImageUrl || null;

  /**
   * The opponent side, and what this battle pays.
   *
   * `userB` is absent on a `waiting_for_opponent` match. The rest of this file has
   * always treated it as nullable (`item.userB?.votes`, and the header avatar is
   * wrapped in `{item.userB && …}`), but four places dereferenced it directly — the
   * hero media uri and three on the B vote button. Nothing crashed only because the
   * Worker filters one-sided matches out of every list that feeds this component,
   * and `routes/read.ts` says so out loud: "waiting_for_opponent (no userB -> would
   * crash the card)". That makes client stability depend on a server WHERE clause,
   * and this component is rendered from four different screens. Binding the side
   * once here means a one-sided match renders a placeholder instead of
   * red-screening the feed.
   */
  const userB = item.userB ?? null;
  const prize = matchPrize(item);

  return (
    <View style={[styles.postContainer, { backgroundColor: cardColor }]}>
      {showConfetti && (
        <View style={styles.confetti} pointerEvents="none">
          <LottieView
              source={{ uri: 'https://assets2.lottiefiles.com/packages/lf20_u4y36v.json' }}
              autoPlay
              loop={false}
              style={styles.confettiAnimation}
          />
        </View>
      )}

      {/* Header: avatars + names at the top */}
      <View style={styles.postHeader}>
        <View style={styles.userInfo}>
           <View style={styles.avatarContainer}>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => openProfile(item.userA?.uid)}
                style={[styles.avatarWrapper, aWins && styles.leadingAvatar, { zIndex: 2 }]}
                accessibilityRole="button"
                accessibilityLabel={`Open ${nameA}'s profile`}
              >
                <Avatar uri={picA} name={nameA} fill size={28} />
              </TouchableOpacity>
              {item.userB && (
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => openProfile(item.userB?.uid)}
                  style={[styles.avatarWrapper, bWins && styles.leadingAvatar, { marginLeft: -14, zIndex: 1 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${nameB}'s profile`}
                >
                  <Avatar uri={picB} name={nameB} fill size={28} />
                </TouchableOpacity>
              )}
           </View>
           <View style={styles.nameContainer}>
               <View style={styles.nameRow}>
                   <TouchableOpacity
                     activeOpacity={0.7}
                     onPress={() => openProfile(item.userA?.uid)}
                     style={styles.nameTouch}
                     accessibilityRole="button"
                     accessibilityLabel={`Open ${nameA}'s profile`}
                   >
                     <Text style={[styles.nameText, { color: textColor }]} numberOfLines={1}>{nameA}</Text>
                     <VerifiedBadge verified={item.userA?.verified} size={13} />
                   </TouchableOpacity>
                   <View style={styles.vsPill}><Text style={styles.vsPillText}>VS</Text></View>
                   <TouchableOpacity
                     activeOpacity={0.7}
                     onPress={() => openProfile(item.userB?.uid)}
                     style={styles.nameTouch}
                     accessibilityRole="button"
                     accessibilityLabel={`Open ${nameB}'s profile`}
                   >
                     <Text style={[styles.nameText, { color: textColor }]} numberOfLines={1}>{nameB}</Text>
                     <VerifiedBadge verified={item.userB?.verified} size={13} />
                   </TouchableOpacity>
               </View>
               <Text style={[styles.timeText, { color: subTextColor }]} numberOfLines={1}>{item.title}</Text>
           </View>
        </View>
        {/*
          * What this battle actually pays, from the match's own prize snapshot.
          *
          * This used to render `item.entryFee * 1.8`. `entryFee` on a match is the
          * pot for BOTH players, so that advertised 180% of the money that existed
          * against a server payout hard-capped at the pot; it had no rounding, so a
          * 7-coin pot displayed "12.6" coins; and it showed a coin figure even for
          * battles whose prize is a physical product. Explore showed a different
          * number again for the same battle. `matchPrize` is now the single answer
          * for both.
          */}
        {prize.type === 'product' ? (
          <LinearGradient
            colors={['#FFF4C2', '#FFE68A']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.prizeBadge}
          >
            <Ionicons name="gift" size={12} color="#E6A200" />
            <Text style={styles.prizeText} numberOfLines={1}>{prize.product.title}</Text>
          </LinearGradient>
        ) : prize.coins > 0 ? (
          <LinearGradient
            colors={['#FFF4C2', '#FFE68A']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.prizeBadge}
          >
            <Ionicons name="trophy" size={12} color="#E6A200" />
            <Text style={styles.prizeText}>{prize.coins}</Text>
          </LinearGradient>
        ) : null}
      </View>

      {/* Hero media */}
      <Pressable onPress={handleDoubleTap} style={styles.mediaSection}>
        <View style={[styles.imageWrapper, aWins && styles.leadingImage]}>
          <BattleMedia
            isVideo={isVideo}
            uri={item.userA.mediaUrlOptimized || item.userA.mediaUrl}
            style={styles.postImage}
            active={playActive}
            width={slotWidth}
          />
          {aWins && <View style={styles.crownContainer}><MaterialCommunityIcons name="crown" size={20} color="#FFD700" /></View>}
        </View>

        <View style={[styles.imageWrapper, bWins && styles.leadingImage]}>
          {userB ? (
            <BattleMedia
              isVideo={isVideo}
              uri={userB.mediaUrlOptimized || userB.mediaUrl}
              style={styles.postImage}
              active={playActive}
              width={slotWidth}
            />
          ) : (
            // Waiting for an opponent: the slot stays, empty, rather than throwing.
            <View style={[styles.postImage, styles.waitingSlot]}>
              <Ionicons name="hourglass-outline" size={22} color="#9BA1A6" />
              <Text style={styles.waitingSlotText}>Waiting for opponent</Text>
            </View>
          )}
          {bWins && <View style={styles.crownContainer}><MaterialCommunityIcons name="crown" size={20} color="#FFD700" /></View>}
        </View>

        <View pointerEvents="none" style={styles.vsBadge}>
          <LinearGradient
            colors={['#FF4D7E', '#FF8A4D']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.vsBadgeGradient}
          >
            <Text style={styles.vsBadgeText}>VS</Text>
          </LinearGradient>
        </View>

        <Animated.View pointerEvents="none" style={[styles.largeHeart, animatedHeartStyle]}>
          <HeartIcon_Filled width={90} height={90} color="#FF4D67" />
        </Animated.View>
      </Pressable>

      {/* Battle meter — live battles only (see showTally) */}
      {showTally && (
      <View
        style={styles.pollInfoSection}
        accessible
        accessibilityLabel={`${nameA} has ${votesA} votes, ${nameB} has ${votesB} votes. ${votingClosed ? 'Voting ended.' : timeRemaining}`}
      >
        <View style={[styles.progressTrack, { backgroundColor: trackColor }]}>
          <AnimatedLinearGradient
            colors={['#FF4D7E', '#FF6FA0']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            style={[styles.progressSegment, animatedBarStyleA]}
          />
          <AnimatedLinearGradient
            colors={['#FFA24D', '#FF8A4D']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
            style={[styles.progressSegment, animatedBarStyleB]}
          />
        </View>
        <View style={styles.voteLabels}>
          <Text style={[styles.votePercent, { color: '#FF4D7E' }]}>{Math.round(progressA * 100)}%</Text>
          <View
            style={[styles.timeChip, { backgroundColor: trackColor }, isUrgent && styles.timeChipUrgent]}
            accessibilityRole="timer"
            accessibilityLabel={votingClosed ? 'Contest ended' : `Time left ${timeRemaining}`}
          >
            {votingClosed
              ? <Ionicons name="lock-closed" size={11} color={subTextColor} />
              : <Animated.View style={[styles.liveDot, isUrgent && styles.liveDotUrgent, liveDotStyle]} />}
            <Text
              style={[
                styles.timeChipText,
                // Fixed-width digits so the chip does not jitter every second.
                !votingClosed && styles.timeChipClock,
                countdown.finalMinute && styles.timeChipFinal,
                { color: isUrgent ? '#FFF' : (votingClosed ? subTextColor : textColor) },
              ]}
            >
              {votingClosed ? 'Ended' : countdown.clock ?? timeRemaining}
            </Text>
          </View>
          <Text style={[styles.votePercent, { color: '#FF8A4D' }]}>{Math.round((1 - progressA) * 100)}%</Text>
        </View>
      </View>

      )}

      {/* Live vote counts, placed right above the vote buttons — live battles only */}
      {showTally && (
      <View style={styles.voteCountRow}>
        <View style={styles.voteCountItem}>
          <Ionicons name="flame" size={13} color="#FF4D67" />
          <Text style={[styles.voteCountNum, { color: '#FF4D67' }]}>{formatVotes(votesA)}</Text>
          <Text style={[styles.voteCountLabel, { color: subTextColor }]}>votes</Text>
        </View>
        <View style={[styles.voteCountItem, styles.voteCountItemRight]}>
          <Ionicons name="flame" size={13} color="#FF8A4D" />
          <Text style={[styles.voteCountNum, { color: '#FF8A4D' }]}>{formatVotes(votesB)}</Text>
          <Text style={[styles.voteCountLabel, { color: subTextColor }]}>votes</Text>
        </View>
      </View>
      )}

      {/* Deadline passed, result being declared (normally seconds). */}
      {isPendingResult && (
        <View style={styles.resultSection}>
          <View style={[styles.resultBanner, styles.resultPending]} accessibilityLiveRegion="polite">
            <ActivityIndicator size="small" color="#FFF" />
            <Text style={styles.resultPendingText} numberOfLines={1}>Contest Ended · Result aa raha hai…</Text>
          </View>
        </View>
      )}

      {/* Finished battle → "Contest Ended" and the way into the result. The card
          itself does not say who won: winner, votes and prize are revealed on the
          result page. */}
      {isCompleted && (
        <View style={styles.resultSection}>
          <Text style={[styles.endedLabel, { color: subTextColor }]}>🏁 CONTEST ENDED</Text>
          <Pressable
            onPress={openResult}
            accessibilityRole="button"
            accessibilityLabel="Result declared. View result to see the winner, votes and prize"
            style={({ pressed }) => [styles.resultBanner, styles.resultTeaser, pressed && { opacity: 0.85 }]}
          >
            <MaterialCommunityIcons name="trophy" size={18} color="#8A5A00" />
            <View style={styles.resultTeaserTextWrap}>
              <Text style={styles.resultTeaserTitle} numberOfLines={1}>Result declare ho gaya! Kaun jeeta?</Text>
              <Text style={styles.resultTeaserSub} numberOfLines={1}>Winner, votes aur prize — View Result mein</Text>
            </View>
          </Pressable>
          <TouchableOpacity onPress={openResult} activeOpacity={0.85} accessibilityRole="button" accessibilityLabel="View result">
            <LinearGradient colors={['#FF4D67', '#FF8A4D']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.viewResultBtn}>
              <Ionicons name="trophy" size={16} color="#FFF" />
              <Text style={styles.viewResultText}>View Result</Text>
              <ArrowIcon variant="chevron" direction="right" size={16} color="#FFF" />
            </LinearGradient>
          </TouchableOpacity>
        </View>
      )}

      {/* Vote buttons (hidden once voting is over) */}
      {showTally && (
      <View style={styles.voteButtonSection}>
        <AnimatedTouchable
          style={[
            styles.voteButton,
            styles.voteButtonA,
            votedForA && styles.selectedVoteButton,
            votingDisabled && !votedForA && styles.disabledVoteButton,
            voteAnimA,
          ]}
          onPress={() => { pulseButton(voteScaleA); handleVote(item.userA.uid); }}
          disabled={votingDisabled}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`Vote for ${nameA}`}
          accessibilityHint={votingClosed ? 'Voting has ended' : 'Submits your one vote for this battle'}
          accessibilityState={{ disabled: votingDisabled, busy: submittingForUid === item.userA.uid, selected: votedForA }}
        >
          {submittingForUid === item.userA.uid
            ? <ActivityIndicator size="small" color="#FFF" />
            : votedForA
              ? <View style={styles.voteButtonInner}>
                  <Ionicons name="checkmark-circle" size={16} color="#FFF" />
                  <Text style={styles.voteButtonText}>Voted</Text>
                </View>
              : <View style={styles.voteButtonInner}>
                  <Ionicons name="heart" size={14} color="#FFF" />
                  <Text style={styles.voteButtonText} numberOfLines={1}>{nameA}</Text>
                </View>}
        </AnimatedTouchable>
        <AnimatedTouchable
          style={[
            styles.voteButton,
            styles.voteButtonB,
            votedForB && styles.selectedVoteButton,
            votingDisabled && !votedForB && styles.disabledVoteButton,
            voteAnimB,
          ]}
          onPress={() => { if (!userB) return; pulseButton(voteScaleB); handleVote(userB.uid); }}
          disabled={votingDisabled || !userB}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`Vote for ${nameB}`}
          accessibilityHint={votingClosed ? 'Voting has ended' : 'Submits your one vote for this battle'}
          accessibilityState={{ disabled: votingDisabled || !userB, busy: submittingForUid === userB?.uid, selected: votedForB }}
        >
          {submittingForUid === userB?.uid
            ? <ActivityIndicator size="small" color="#FFF" />
            : votedForB
              ? <View style={styles.voteButtonInner}>
                  <Ionicons name="checkmark-circle" size={16} color="#FFF" />
                  <Text style={styles.voteButtonText}>Voted</Text>
                </View>
              : <View style={styles.voteButtonInner}>
                  <Ionicons name="heart" size={14} color="#FFF" />
                  <Text style={styles.voteButtonText} numberOfLines={1}>{nameB}</Text>
                </View>}
        </AnimatedTouchable>
      </View>
      )}

      <View style={[styles.actionBar, { borderTopColor: trackColor }]}>
        <View style={styles.leftActions}>
            <TouchableOpacity style={styles.actionItem} onPress={handleLike}>
               {isLiked ? <HeartIcon_Filled width={26} height={26} /> : <HeartIcon_Light width={26} height={26} color={textColor} />}
               <Text style={[styles.actionCount, { color: textColor }]}>{likeCount}</Text>
            </TouchableOpacity>
            
            {/* Guests can read the thread; posting is gated inside the sheet. */}
            <TouchableOpacity style={styles.actionItem} onPress={() => setShowComments(true)}>
               <ChatIcon_Light width={26} height={26} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>{commentCount}</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.actionItem} onPress={handleShare}>
               <Share_Icon width={26} height={26} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>{shareCount}</Text>
            </TouchableOpacity>
        </View>
        
        <View style={styles.rightActions}>
          {showMoreMenu ? (
            <TouchableOpacity
              onPress={openMoreMenu}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="More options"
              accessibilityHint="Not interested, or report this battle"
              style={styles.reportBtn}
            >
              <Ionicons name="ellipsis-horizontal" size={20} color={subTextColor} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={handleReport}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Report this battle"
              style={styles.reportBtn}
            >
              <Ionicons name="flag-outline" size={20} color={subTextColor} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleBookmark}>
              {isBookmarked ? <Bookmark_Filled width={26} height={26} color="#FF4D67" /> : <Bookmark_Outline width={26} height={26} color={textColor} />}
          </TouchableOpacity>
        </View>
      </View>
      
      <CommentSheet postId={item.id} visible={showComments} onDismiss={() => setShowComments(false)} isDark={isDark} isContestMatch={true} />
      {reportDialog}
      <ShareSheet visible={showShare} onDismiss={() => setShowShare(false)} isDark={isDark} matchId={item.id} match={item} />
    </View>
  );
});

PostCard.displayName = 'PostCard';

const styles = StyleSheet.create({
  postContainer: {
    borderRadius: 24,
    marginHorizontal: 10,
    marginBottom: 20,
    paddingBottom: 14,
    position: 'relative',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  confetti: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
  confettiAnimation: { width: '100%', height: '100%' },

  // Header (avatars + names at top)
  postHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12 },
  userInfo: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 10 },
  avatarContainer: { flexDirection: 'row', alignItems: 'center' },
  avatarWrapper: { width: 32, height: 32, borderRadius: 16, borderWidth: 2, borderColor: '#FFF', overflow: 'hidden', backgroundColor: '#EEE' },
  avatarImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  videoPlaceholder: { backgroundColor: '#15171C', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  videoPlaceholderOverlay: { alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
  videoPlaceholderText: { color: '#FFF', fontFamily: 'Urbanist-SemiBold', fontSize: 12 },
  leadingAvatar: { borderColor: '#FFD700', borderWidth: 2.5 },
  nameContainer: { marginLeft: 10, flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  nameTouch: { flexShrink: 1, maxWidth: '42%', flexDirection: 'row', alignItems: 'center' },
  nameText: { fontFamily: 'Urbanist-Bold', fontSize: 16, fontWeight: '800' },
  vsPill: { backgroundColor: '#FF4D67', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, marginHorizontal: 6 },
  vsPillText: { fontFamily: 'Urbanist-Bold', fontSize: 9, color: '#FFF', letterSpacing: 0.5 },
  timeText: { fontFamily: 'Urbanist-Medium', fontSize: 12, marginTop: 2 },
  prizeBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, borderWidth: 1, borderColor: '#FFD700' },
  prizeText: { fontFamily: 'Urbanist-Bold', fontSize: 11, color: '#B57E00' },

  // Media
  mediaSection: { flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: 16, gap: 12, position: 'relative' },
  imageWrapper: { flex: 1, position: 'relative', borderRadius: 20, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  postImage: { width: '100%', height: 260, backgroundColor: '#EEE' },
  fitFrame: { overflow: 'hidden', backgroundColor: '#15171C' },
  fitDim: { backgroundColor: 'rgba(0,0,0,0.18)' },
  // Lets the blurred poster show through the letterbox bars around the video.
  videoClear: { backgroundColor: 'transparent' },
  // Shown in place of the B entry when a battle has no opponent yet.
  waitingSlot: { alignItems: 'center', justifyContent: 'center', gap: 6 },
  waitingSlotText: { fontFamily: 'Urbanist-SemiBold', fontSize: 12, color: '#9BA1A6' },
  leadingImage: { borderColor: '#FFD700' },
  crownContainer: { position: 'absolute', top: 8, alignSelf: 'center', left: 0, right: 0, alignItems: 'center', zIndex: 10 },

  // Vote counts above the buttons
  voteCountRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 20, marginTop: 16 },
  voteCountItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  voteCountItemRight: { flexDirection: 'row-reverse' },
  voteCountNum: { fontFamily: 'Urbanist-Bold', fontSize: 16 },
  voteCountLabel: { fontFamily: 'Urbanist-Medium', fontSize: 12 },

  // Center VS orb
  vsBadge: { position: 'absolute', top: '50%', left: 0, right: 0, alignItems: 'center', marginTop: -22, zIndex: 15 },
  vsBadgeGradient: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#FFF', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 5 },
  vsBadgeText: { fontFamily: 'Urbanist-Bold', fontSize: 15, color: '#FFF', letterSpacing: 0.5 },
  largeHeart: { position: 'absolute', top: '30%', left: '35%', zIndex: 20 },

  // Battle meter
  pollInfoSection: { paddingHorizontal: 16, marginTop: 16 },
  progressTrack: { width: '100%', height: 9, borderRadius: 5, overflow: 'hidden', flexDirection: 'row' },
  progressSegment: { height: '100%' },
  voteLabels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  votePercent: { fontFamily: 'Urbanist-Bold', fontSize: 13 },
  timeChip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, minWidth: 108 },
  timeChipUrgent: { backgroundColor: '#F0413E' },
  timeChipText: { fontFamily: 'Urbanist-Bold', fontSize: 12, letterSpacing: 0.3 },
  timeChipClock: { fontVariant: ['tabular-nums'] },
  timeChipFinal: { fontSize: 14 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#22A559' },
  liveDotUrgent: { backgroundColor: '#FFF' },

  // Vote buttons
  voteButtonSection: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 8, gap: 12 },
  resultSection: { paddingHorizontal: 16, marginTop: 8 },
  resultBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 46, borderRadius: 16, paddingHorizontal: 12 },
  resultTeaser: { backgroundColor: '#FFF4C2', borderWidth: 1, borderColor: '#FFD700', justifyContent: 'flex-start', paddingVertical: 8 },
  resultTeaserTextWrap: { flex: 1, minWidth: 0 },
  resultTeaserTitle: { fontFamily: 'Urbanist-Bold', fontSize: 14, color: '#5A3A00' },
  resultTeaserSub: { fontFamily: 'Urbanist-Medium', fontSize: 12, color: '#8A5A00', marginTop: 1 },
  resultPending: { backgroundColor: '#5B5F6B' },
  resultPendingText: { fontFamily: 'Urbanist-Bold', fontSize: 14, color: '#FFF', flexShrink: 1 },
  endedLabel: { fontFamily: 'Urbanist-Bold', fontSize: 11, letterSpacing: 1.2, textAlign: 'center', marginBottom: 6 },
  viewResultBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, borderRadius: 16, marginTop: 8 },
  viewResultText: { fontFamily: 'Urbanist-Bold', fontSize: 15, color: '#FFF' },
  voteButton: { flex: 1, minHeight: 46, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  voteButtonA: { backgroundColor: '#FF4D67' },
  voteButtonB: { backgroundColor: '#FF8A4D' },
  voteButtonInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  selectedVoteButton: { backgroundColor: '#22A559', opacity: 1 },
  disabledVoteButton: { opacity: 0.4 },
  voteButtonText: { fontFamily: 'Urbanist-Bold', fontSize: 13, color: '#FFF' },

  // Action bar
  actionBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8, marginTop: 16, borderTopWidth: 1 },
  leftActions: { flexDirection: 'row', alignItems: 'center' },
  rightActions: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  reportBtn: { padding: 2 },
  actionItem: { flexDirection: 'row', alignItems: 'center', marginRight: 28 },
  actionCount: { fontFamily: 'Urbanist-Bold', fontSize: 14, marginLeft: 8 },
});
