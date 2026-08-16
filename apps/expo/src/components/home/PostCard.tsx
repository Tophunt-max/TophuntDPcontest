import React, { useState, memo, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Alert, Pressable, ActivityIndicator, AccessibilityInfo } from 'react-native';
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
import * as Haptics from 'expo-haptics';
import LottieView from 'lottie-react-native';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withSpring, 
  withSequence, 
  withDelay,
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
  const [isLiked, setIsLiked] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  
  const cardColor = isDark ? '#1A1D23' : '#FFFFFF';
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

  // Animation values
  const heartScale = useSharedValue(0);
  const barProgress = useSharedValue(initialProgressA);
  const lastTap = useRef<number>(0);
  const lastVoteTotal = useRef(initialTotal);
  const isHeartAnimating = useRef<boolean>(false);

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
      },
      {
        onEvent: (event) => {
          if (event.type === 'vote' || event.type === 'match_status') {
            applyTally(Number(event.votesA || 0), Number(event.votesB || 0));
          }
          if (event.type === 'match_status' && event.status) setMatchStatus(String(event.status));
        },
        shouldRefresh: (event) => event.type !== 'vote' && event.type !== 'match_status',
      },
    );
    return () => unsub();
  }, [applyTally, item.id, user?.uid]);

  useEffect(() => {
    if (matchStatus !== 'active') onMatchEnded?.(item.id);
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
        heartScale.value = withSequence(
            withSpring(1.5, { damping: 10, stiffness: 100 }),
            withDelay(300, withSpring(0, {}, (finished) => {
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
    triggerHaptic();
    try {
      const newLikedStatus = !isLiked;
      setIsLiked(newLikedStatus);
      await contestService.likeMatch(item.id);
      if (newLikedStatus) addToast("Zabardast Like!", 'success');
    } catch {
       setIsLiked(!isLiked);
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
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours}h ${minutes}m left`;
  }, [item.expiresAt]);

  const [timeRemaining, setTimeRemaining] = useState(getTimeRemaining());
  useEffect(() => {
    const timer = setInterval(() => setTimeRemaining(getTimeRemaining()), 60000);
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

  // Urgency: highlight the countdown chip in the final hour of an open battle.
  const endMs = item.expiresAt
    ? (item.expiresAt.toDate ? item.expiresAt.toDate() : new Date(item.expiresAt)).getTime()
    : 0;
  const msLeft = endMs - Date.now();
  const isUrgent = !votingClosed && msLeft > 0 && msLeft < 3_600_000;

  const isALeading = votesA > votesB;
  const isBLeading = votesB > votesA;
  const votedForA = votedForUid === item.userA.uid;
  const votedForB = votedForUid === item.userB?.uid;

  const picA = item.userA.profilePic || item.userA.profileImageUrl || `https://ui-avatars.com/api/?name=${nameA}&background=random`;
  const picB = item.userB?.profilePic || item.userB?.profileImageUrl || `https://ui-avatars.com/api/?name=${nameB}&background=random`;

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
      
      <View style={styles.postHeader}>
        <View style={styles.userInfo}>
           <View style={styles.avatarContainer}>
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => openProfile(item.userA?.uid)}
                style={[styles.avatarWrapper, isALeading && styles.leadingAvatar, { zIndex: 2 }]}
                accessibilityRole="button"
                accessibilityLabel={`Open ${nameA}'s profile`}
              >
                <Image source={{ uri: picA }} style={styles.avatarImage} />
              </TouchableOpacity>
              {item.userB && (
                <TouchableOpacity
                  activeOpacity={0.8}
                  onPress={() => openProfile(item.userB?.uid)}
                  style={[styles.avatarWrapper, isBLeading && styles.leadingAvatar, { marginLeft: -14, zIndex: 1 }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${nameB}'s profile`}
                >
                  <Image source={{ uri: picB }} style={styles.avatarImage} />
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

      <Pressable onPress={handleDoubleTap} style={styles.mediaSection}>
        <View style={[styles.imageWrapper, isALeading && styles.leadingImage]}>
            <Image source={{ uri: item.userA.mediaUrl }} style={styles.postImage} />
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.6)']} style={styles.imageOverlay} pointerEvents="none" />
            {isALeading && <View style={styles.crownContainer}><MaterialCommunityIcons name="crown" size={18} color="#FFD700" /></View>}
            <View style={[styles.voteCountChip, styles.voteChipA]}>
                <Ionicons name="flame" size={11} color="#FFF" />
                <Text style={styles.voteCountText}>{formatVotes(votesA)}</Text>
            </View>
        </View>
        <View style={[styles.imageWrapper, isBLeading && styles.leadingImage]}>
            <Image source={{ uri: item.userB.mediaUrl }} style={styles.postImage} />
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.6)']} style={styles.imageOverlay} pointerEvents="none" />
            {isBLeading && <View style={styles.crownContainer}><MaterialCommunityIcons name="crown" size={18} color="#FFD700" /></View>}
            <View style={[styles.voteCountChip, styles.voteChipB]}>
                <Ionicons name="flame" size={11} color="#FFF" />
                <Text style={styles.voteCountText}>{formatVotes(votesB)}</Text>
            </View>
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
      
      <View style={styles.voteButtonSection}>
        <TouchableOpacity
          style={[
            styles.voteButton,
            styles.voteButtonA,
            votedForA && styles.selectedVoteButton,
            votingDisabled && !votedForA && styles.disabledVoteButton,
          ]}
          onPress={() => handleVote(item.userA.uid)}
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
              : <Text style={styles.voteButtonText} numberOfLines={1}>Vote {nameA}</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.voteButton,
            styles.voteButtonB,
            votedForB && styles.selectedVoteButton,
            votingDisabled && !votedForB && styles.disabledVoteButton,
          ]}
          onPress={() => handleVote(item.userB.uid)}
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
              : <Text style={styles.voteButtonText} numberOfLines={1}>Vote {nameB}</Text>}
        </TouchableOpacity>
      </View>
      
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
                <Ionicons
                    name={votingClosed ? 'lock-closed' : 'time-outline'}
                    size={11}
                    color={isUrgent ? '#FFF' : subTextColor}
                />
                <Text style={[styles.timeChipText, { color: isUrgent ? '#FFF' : subTextColor }]}>
                    {votingClosed ? 'Ended' : timeRemaining}
                </Text>
            </View>
            <Text style={[styles.votePercent, { color: '#FF8A4D' }]}>{Math.round((1 - progressA) * 100)}%</Text>
        </View>
      </View>

      <View style={[styles.actionBar, { borderTopColor: trackColor }]}>
        <View style={styles.leftActions}>
            <TouchableOpacity style={styles.actionItem} onPress={handleLike}>
               {isLiked ? <HeartIcon_Filled width={24} height={24} /> : <HeartIcon_Light width={24} height={24} color={textColor} />}
               <Text style={[styles.actionCount, { color: textColor }]}>{likeCount}</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.actionItem} onPress={() => setShowComments(true)}>
               <ChatIcon_Light width={24} height={24} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>{commentCount}</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.actionItem} onPress={handleShare}>
               <Share_Icon width={24} height={24} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>{shareCount}</Text>
            </TouchableOpacity>
        </View>
        
        <TouchableOpacity onPress={handleBookmark}>
            {isBookmarked ? <Bookmark_Filled width={24} height={24} color="#FF4D67" /> : <Bookmark_Outline width={24} height={24} color={textColor} />}
        </TouchableOpacity>
      </View>
      
      <CommentSheet postId={item.id} visible={showComments} onDismiss={() => setShowComments(false)} isDark={isDark} isContestMatch={true} />
      <ShareSheet visible={showShare} onDismiss={() => setShowShare(false)} isDark={isDark} matchId={item.id} />
    </View>
  );
});

PostCard.displayName = 'PostCard';

const styles = StyleSheet.create({
  postContainer: {
    borderRadius: 24,
    marginHorizontal: 10,
    marginBottom: 20,
    paddingBottom: 6,
    position: 'relative',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 4,
  },
  confetti: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
  confettiAnimation: { width: '100%', height: '100%' },
  postHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  userInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  avatarContainer: { flexDirection: 'row', alignItems: 'center' },
  avatarWrapper: { width: 40, height: 40, borderRadius: 20, borderWidth: 2, borderColor: '#FFF', overflow: 'hidden', backgroundColor: '#EEE' },
  avatarImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  leadingAvatar: { borderColor: '#FFD700', borderWidth: 2.5 },
  nameContainer: { marginLeft: 10, flex: 1 },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  nameTouch: { flexShrink: 1, maxWidth: '42%' },
  nameText: { fontFamily: 'Urbanist-Bold', fontSize: 15 },
  vsPill: { backgroundColor: '#FF4D67', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1, marginHorizontal: 6 },
  vsPillText: { fontFamily: 'Urbanist-Bold', fontSize: 9, color: '#FFF', letterSpacing: 0.5 },
  timeText: { fontFamily: 'Urbanist-Medium', fontSize: 12, marginTop: 2 },
  prizeBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, borderWidth: 1, borderColor: '#FFD700' },
  prizeText: { fontFamily: 'Urbanist-Bold', fontSize: 11, color: '#B57E00' },
  mediaSection: { flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: 16, gap: 12, position: 'relative' },
  imageWrapper: { flex: 1, position: 'relative', borderRadius: 20, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  postImage: { width: '100%', height: 260, backgroundColor: '#EEE' },
  imageOverlay: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 70 },
  leadingImage: { borderColor: '#FFD700' },
  crownContainer: { position: 'absolute', top: 8, alignSelf: 'center', left: 0, right: 0, alignItems: 'center', zIndex: 10 },
  voteCountChip: { position: 'absolute', bottom: 10, left: 10, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 4, borderRadius: 12 },
  voteChipA: { backgroundColor: 'rgba(255,77,126,0.9)' },
  voteChipB: { backgroundColor: 'rgba(255,138,77,0.9)' },
  voteCountText: { fontFamily: 'Urbanist-Bold', fontSize: 11, color: '#FFF' },
  vsBadge: { position: 'absolute', top: '50%', left: 0, right: 0, alignItems: 'center', marginTop: -22, zIndex: 15 },
  vsBadgeGradient: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 3, borderColor: '#FFF', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 5 },
  vsBadgeText: { fontFamily: 'Urbanist-Bold', fontSize: 15, color: '#FFF', letterSpacing: 0.5 },
  largeHeart: { position: 'absolute', top: '30%', left: '35%', zIndex: 20 },
  voteButtonSection: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 16, gap: 12 },
  voteButton: { flex: 1, minHeight: 46, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  voteButtonA: { backgroundColor: '#FF4D67' },
  voteButtonB: { backgroundColor: '#FF8A4D' },
  voteButtonInner: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  selectedVoteButton: { backgroundColor: '#22A559', opacity: 1 },
  disabledVoteButton: { opacity: 0.4 },
  voteButtonText: { fontFamily: 'Urbanist-Bold', fontSize: 13, color: '#FFF' },
  pollInfoSection: { paddingHorizontal: 16, marginTop: 18 },
  progressTrack: { width: '100%', height: 9, borderRadius: 5, overflow: 'hidden', flexDirection: 'row' },
  progressSegment: { height: '100%' },
  voteLabels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  votePercent: { fontFamily: 'Urbanist-Bold', fontSize: 13 },
  timeChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  timeChipUrgent: { backgroundColor: '#F0413E' },
  timeChipText: { fontFamily: 'Urbanist-SemiBold', fontSize: 11 },
  actionBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 14, marginTop: 14, borderTopWidth: 1 },
  leftActions: { flexDirection: 'row', alignItems: 'center' },
  actionItem: { flexDirection: 'row', alignItems: 'center', marginRight: 24 },
  actionCount: { fontFamily: 'Urbanist-Bold', fontSize: 13, marginLeft: 8 },
});
