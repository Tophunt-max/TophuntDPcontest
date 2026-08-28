import React, { useState, memo, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Pressable, ActivityIndicator, AccessibilityInfo } from 'react-native';
import { Alert } from '@/src/lib/appAlert';
import { AppImage as ExpoImage } from '../ui/AppImage';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons, MaterialCommunityIcons } from '@/src/lib/icons';
import { CommentSheet } from '../comments/CommentSheet';
import { ShareSheet } from '../share/ShareSheet';
import { useAuth } from '@/src/hooks/useAuth';
import { contestService } from '@/src/services/contests/contestService';
import { readApi } from '@/src/services/api';
import { live } from '@/src/services/realtime';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { LinearGradient } from 'expo-linear-gradient';
import { useToast } from '../toast/ToastProvider';
import { engagementService } from '@/src/services/contests/engagementService';
import { Avatar } from '../ui/Avatar';
import { useVideoStatus } from '@/src/hooks/useVideoStatus';
import { videoSourceFor } from '@/src/lib/videoSource';
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

interface PostCardProps {
    item: any;
    isDark: boolean;
    onMatchEnded?: (matchId: string) => void;
}

const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);
const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

// --- Media (cached images + autoplay video) --------------------------------
// expo-image gives disk caching + a smooth fade, so re-scrolling a feed doesn't
// re-download every image (less R2 bandwidth, faster paint).
const PhotoMedia = ({ uri, style }: { uri?: string; style: any }) => (
  <ExpoImage source={uri} style={style} contentFit="cover" />
);

// Photo/Video are SEPARATE components so a photo battle never instantiates a
// video player (the useVideoPlayer hook only runs inside VideoMedia). Video
// battles autoplay muted + looping; FlatList virtualization unmounts off-screen
// cards, which releases their players.
const VideoMedia = ({ uri, style }: { uri: string; style: any }) => {
  // Bunny videos need ~10-60s of encoding after upload. Until then there is no
  // playlist to play, so show the poster frame instead of mounting a player that
  // would just error. R2 videos report status null and skip all of this.
  const { isProcessing, isFailed, thumbnailUrl } = useVideoStatus(uri);
  // videoSourceFor picks the right URL for the platform (HLS on native, Bunny's
  // MP4 fallback on web) AND enables expo-video's disk cache, so the same clip is
  // not re-downloaded every time this card scrolls back into view.
  const source = videoSourceFor(uri);

  const player = useVideoPlayer(isProcessing || isFailed ? null : source, (p) => {
    p.loop = true;
    p.muted = true;
    p.play();
  });

  if (isProcessing || isFailed) {
    return (
      <View style={[style, styles.videoPlaceholder]}>
        {!!thumbnailUrl && (
          <ExpoImage source={{ uri: thumbnailUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
        )}
        <View style={styles.videoPlaceholderOverlay}>
          {isFailed ? (
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

  return <VideoView player={player} style={style} contentFit="cover" nativeControls={false} />;
};

const BattleMedia = ({ isVideo, uri, style }: { isVideo: boolean; uri?: string; style: any }) =>
  isVideo && uri ? <VideoMedia uri={uri} style={style} /> : <PhotoMedia uri={uri} style={style} />;

/** Compact vote count formatting (1.2k / 3.4M) for the on-image chips. */
const formatVotes = (n: number): string => {
  const value = Number(n) || 0;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}k`;
  return String(value);
};

export const PostCard = memo(({ item, isDark, onMatchEnded }: PostCardProps) => {
  const { user } = useAuth();
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
  const [isLiked, setIsLiked] = useState(!!item.isLiked);
  const [isBookmarked, setIsBookmarked] = useState(!!item.isBookmarked);
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
  const [likeCount, setLikeCount] = useState(item.likeCount || 0);
  const [commentCount, setCommentCount] = useState(item.commentCount || 0);
  const [shareCount, setShareCount] = useState(item.shareCount || 0);
  const [progressA, setProgressA] = useState(initialProgressA);
  const [matchStatus, setMatchStatus] = useState(item.status || 'active');
  const [isVoting, setIsVoting] = useState(false);
  const [submittingForUid, setSubmittingForUid] = useState<string | null>(null);
  const [hasVoted, setHasVoted] = useState(!!item.hasVoted);
  const [votedForUid, setVotedForUid] = useState<string | null>(item.votedForUid || null);
  const [winnerUid, setWinnerUid] = useState<string | null>(item.winnerUid || null);

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

  useEffect(() => {
    if (!item.id) return;

    // Self-contained vote/status events update the card immediately. Other
    // engagement events refetch details; live() coalesces overlapping refreshes.
    const unsub = live<any>(
      `match:${item.id}`,
      () => readApi(`/read/matches/${item.id}`),
      (data) => {
        if (!data) return;
        applyTally(Number(data.userA?.votes || 0), Number(data.userB?.votes || 0));
        setLikeCount(data.likeCount || 0);
        setCommentCount(data.commentCount || 0);
        setShareCount(data.shareCount || 0);
        setMatchStatus(data.status || 'active');
        if (typeof data.hasVoted === 'boolean') setHasVoted(data.hasVoted);
        if ('votedForUid' in data) setVotedForUid(data.votedForUid || null);
        if ('winnerUid' in data) setWinnerUid(data.winnerUid || null);
        // Keep the viewer's own like/bookmark state in sync (survives refresh).
        if (typeof data.isLiked === 'boolean') setIsLiked(data.isLiked);
        if (typeof data.isBookmarked === 'boolean') setIsBookmarked(data.isBookmarked);
      },
      {
        // The feed/profile list already hydrated this card (votes, counts,
        // isLiked/hasVoted, winner), so skip the redundant initial GET of
        // /read/matches/:id — a big saving of D1 reads + DO calls across a feed.
        // The WebSocket keeps it live; the safety-net poll is slow (WS handles
        // real-time) so idle cards barely touch the backend.
        immediate: false,
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
              if (event.type === 'match_status') setWinnerUid(event.winnerUid ?? null);
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
    return () => unsub();
  }, [applyTally, item.id, user?.uid]);

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
    if (!user) return Alert.alert("Login required", "Please login to vote.");
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
    if (!user) return Alert.alert("Login required", "Please login to like.");
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
      const res: any = await contestService.likeMatch(item.id);
      // Trust the server's final liked state; the broadcast 'like' event
      // carries the authoritative count and reconciles it for everyone.
      if (res && typeof res.liked === 'boolean') setIsLiked(res.liked);
      if (next) addToast("Zabardast Like!", 'success');
    } catch {
      // Roll back the optimistic update on failure.
      setIsLiked(!next);
      setLikeCount((c: number) => Math.max(0, c + (next ? -1 : 1)));
    } finally {
      likeInFlight.current = false;
    }
  };

  const handleShare = async () => {
    if (!user) return Alert.alert("Login required", "Please login to share.");
    triggerHaptic();
    setShowShare(true);
  };

  const handleBookmark = async () => {
    if (!user) return Alert.alert("Login required", "Please login to bookmark.");
    triggerHaptic();
    try {
      // Toggle local state immediately for better UX
      const prevStatus = isBookmarked;
      setIsBookmarked(!prevStatus);
      
      const status = await engagementService.toggleBookmark(item.id, user.uid);
      setIsBookmarked(status);
      addToast(status ? "Saved to your profile!" : "Removed from bookmarks!", 'info');
    } catch {
        setIsBookmarked(!isBookmarked);
    }
  };

  const animatedHeartStyle = useAnimatedStyle(() => ({
    transform: [{ scale: heartScale.value }],
    opacity: heartScale.value > 0.1 ? 1 : 0,
  }));

  const getTimeRemaining = useCallback(() => {
    if (!item.expiresAt) return 'Ended';
    const endDate = item.expiresAt.toDate ? item.expiresAt.toDate() : new Date(item.expiresAt);
    const diff = endDate.getTime() - Date.now();
    if (diff <= 0) return 'Ended';
    // Live countdown — the most significant units, seconds ticking under an hour.
    const totalSec = Math.floor(diff / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }, [item.expiresAt]);

  const [timeRemaining, setTimeRemaining] = useState(getTimeRemaining());
  useEffect(() => {
    // Tick every second for a live countdown feel.
    const timer = setInterval(() => setTimeRemaining(getTimeRemaining()), 1000);
    const endDate = item.expiresAt?.toDate ? item.expiresAt.toDate() : new Date(item.expiresAt);
    const msUntilEnd = endDate.getTime() - Date.now();
    const endTimer = Number.isFinite(msUntilEnd) && msUntilEnd > 0
      ? setTimeout(() => setTimeRemaining('Ended'), Math.min(msUntilEnd + 50, 2_147_000_000))
      : null;
    return () => {
      clearInterval(timer);
      if (endTimer) clearTimeout(endTimer);
    };
  }, [getTimeRemaining, item.expiresAt]);

  const votingClosed = matchStatus !== 'active' || timeRemaining === 'Ended';
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
  const endMs = item.expiresAt
    ? (item.expiresAt.toDate ? item.expiresAt.toDate() : new Date(item.expiresAt)).getTime()
    : 0;
  const msLeft = endMs - Date.now();
  const isUrgent = !votingClosed && msLeft > 0 && msLeft < 3_600_000;

  const isVideo = item.type === 'video';
  const isALeading = votesA > votesB;
  const isBLeading = votesB > votesA;
  const votedForA = votedForUid === item.userA.uid;
  const votedForB = votedForUid === item.userB?.uid;

  // Completed-battle result. Winner = declared winnerUid, else the higher tally.
  const isCompleted = matchStatus === 'completed';
  const winnerSide: 'A' | 'B' | null =
    winnerUid === item.userA.uid ? 'A'
    : winnerUid === item.userB?.uid ? 'B'
    : isCompleted ? (votesA > votesB ? 'A' : votesB > votesA ? 'B' : null) : null;
  const isTie = isCompleted && !winnerSide;
  const winnerName = winnerSide === 'A' ? nameA : winnerSide === 'B' ? nameB : null;
  // Visual highlight: the winner once finished, otherwise the live leader.
  const aWins = isCompleted ? winnerSide === 'A' : isALeading;
  const bWins = isCompleted ? winnerSide === 'B' : isBLeading;

  // Null when the user has no photo — <Avatar> renders local initials.
  // profilePicThumb / mediaUrlOptimized come from the Worker's enrichMatchMedia
  // and are identical to the originals until Transformations is enabled, so
  // preferring them is safe today and gets lighter automatically at cutover.
  const picA = item.userA.profilePicThumb || item.userA.profilePic || item.userA.profileImageUrl || null;
  const picB = item.userB?.profilePicThumb || item.userB?.profilePic || item.userB?.profileImageUrl || null;

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
                   </TouchableOpacity>
               </View>
               <Text style={[styles.timeText, { color: subTextColor }]} numberOfLines={1}>{item.title}</Text>
           </View>
        </View>
        {item.entryFee > 0 && (
          <LinearGradient
            colors={['#FFF4C2', '#FFE68A']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.prizeBadge}
          >
            <Ionicons name="trophy" size={12} color="#E6A200" />
            <Text style={styles.prizeText}>{item.entryFee * 1.8}</Text>
          </LinearGradient>
        )}
      </View>

      {/* Hero media */}
      <Pressable onPress={handleDoubleTap} style={styles.mediaSection}>
        <View style={[styles.imageWrapper, aWins && styles.leadingImage]}>
          <BattleMedia
            isVideo={isVideo}
            uri={item.userA.mediaUrlOptimized || item.userA.mediaUrl}
            style={styles.postImage}
          />
          {aWins && <View style={styles.crownContainer}><MaterialCommunityIcons name="crown" size={20} color="#FFD700" /></View>}
        </View>

        <View style={[styles.imageWrapper, bWins && styles.leadingImage]}>
          <BattleMedia
            isVideo={isVideo}
            uri={item.userB.mediaUrlOptimized || item.userB.mediaUrl}
            style={styles.postImage}
          />
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

      {/* Battle meter */}
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
          <View style={[styles.timeChip, { backgroundColor: trackColor }, isUrgent && styles.timeChipUrgent]}>
            {votingClosed
              ? <Ionicons name="lock-closed" size={11} color={subTextColor} />
              : <Animated.View style={[styles.liveDot, isUrgent && styles.liveDotUrgent, liveDotStyle]} />}
            <Text
              style={[
                styles.timeChipText,
                { color: isUrgent ? '#FFF' : (votingClosed ? subTextColor : textColor) },
              ]}
            >
              {votingClosed ? 'Ended' : timeRemaining}
            </Text>
          </View>
          <Text style={[styles.votePercent, { color: '#FF8A4D' }]}>{Math.round((1 - progressA) * 100)}%</Text>
        </View>
      </View>

      {/* Live vote counts, placed right above the vote buttons */}
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

      {/* Finished battle → show the result banner instead of vote buttons */}
      {isCompleted && (
        <View style={styles.resultSection}>
          {isTie ? (
            <View style={[styles.resultBanner, styles.resultTie]}>
              <Ionicons name="hand-left" size={16} color="#8A6D00" />
              <Text style={styles.resultTieText}>It&apos;s a tie!</Text>
            </View>
          ) : (
            <View style={[styles.resultBanner, styles.resultWin]}>
              <MaterialCommunityIcons name="crown" size={16} color="#FFF" />
              <Text style={styles.resultWinText} numberOfLines={1}>Winner: {winnerName}</Text>
            </View>
          )}
        </View>
      )}

      {/* Vote buttons (hidden once the battle is finished) */}
      {!isCompleted && (
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
          onPress={() => { pulseButton(voteScaleB); handleVote(item.userB.uid); }}
          disabled={votingDisabled}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={`Vote for ${nameB}`}
          accessibilityHint={votingClosed ? 'Voting has ended' : 'Submits your one vote for this battle'}
          accessibilityState={{ disabled: votingDisabled, busy: submittingForUid === item.userB.uid, selected: votedForB }}
        >
          {submittingForUid === item.userB.uid
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
            
            <TouchableOpacity style={styles.actionItem} onPress={() => setShowComments(true)}>
               <ChatIcon_Light width={26} height={26} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>{commentCount}</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.actionItem} onPress={handleShare}>
               <Share_Icon width={26} height={26} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>{shareCount}</Text>
            </TouchableOpacity>
        </View>
        
        <TouchableOpacity onPress={handleBookmark}>
            {isBookmarked ? <Bookmark_Filled width={26} height={26} color="#FF4D67" /> : <Bookmark_Outline width={26} height={26} color={textColor} />}
        </TouchableOpacity>
      </View>
      
      <CommentSheet postId={item.id} visible={showComments} onDismiss={() => setShowComments(false)} isDark={isDark} isContestMatch={true} />
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
  nameTouch: { flexShrink: 1, maxWidth: '42%' },
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
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#22A559' },
  liveDotUrgent: { backgroundColor: '#FFF' },

  // Vote buttons
  voteButtonSection: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 8, gap: 12 },
  resultSection: { paddingHorizontal: 16, marginTop: 8 },
  resultBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 46, borderRadius: 16, paddingHorizontal: 12 },
  resultWin: { backgroundColor: '#22A559' },
  resultWinText: { fontFamily: 'Urbanist-Bold', fontSize: 14, color: '#FFF', flexShrink: 1 },
  resultTie: { backgroundColor: '#FFE68A', borderWidth: 1, borderColor: '#FFD700' },
  resultTieText: { fontFamily: 'Urbanist-Bold', fontSize: 14, color: '#8A6D00' },
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
  actionItem: { flexDirection: 'row', alignItems: 'center', marginRight: 28 },
  actionCount: { fontFamily: 'Urbanist-Bold', fontSize: 14, marginLeft: 8 },
});
