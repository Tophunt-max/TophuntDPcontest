import React, { useState, memo, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Dimensions, Alert, Pressable } from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@/src/lib/icons';
import { CommentSheet } from '../comments/CommentSheet';
import { ShareSheet } from '../share/ShareSheet';
import { useAuth } from '@/src/hooks/useAuth';
import { contestService } from '@/src/services/contests/contestService';
import { readApi } from '@/src/services/api';
import { live } from '@/src/services/realtime';
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

const { width } = Dimensions.get('window');

interface PostCardProps {
    item: any;
    isDark: boolean;
}

const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);

export const PostCard = memo(({ item, isDark }: PostCardProps) => {
  const { user } = useAuth();
  const { addToast } = useToast();
  const [showComments, setShowComments] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  
  const cardColor = isDark ? '#1A1D23' : '#FFFFFF';
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const subTextColor = isDark ? '#BDBDBD' : '#616161';

  // Real-time states
  const [votesA, setVotesA] = useState(item.userA.votes || 0);
  const [votesB, setVotesB] = useState(item.userB?.votes || 0);
  const [likeCount, setLikeCount] = useState(item.likeCount || 0);
  const [commentCount, setCommentCount] = useState(item.commentCount || 0);
  const [shareCount, setShareCount] = useState(item.shareCount || 0);
  const [progressA, setProgressA] = useState(0.5);

  // Animation values
  const heartScale = useSharedValue(0);
  const barProgress = useSharedValue(0.5);
  const lastTap = useRef<number>(0);
  const isHeartAnimating = useRef<boolean>(false);

  useEffect(() => {
    if (!item.id) return;
    // Instant push via the match's WebSocket channel (live vote/like counts).
    const unsub = live<any>(
      `match:${item.id}`,
      () => readApi(`/read/matches/${item.id}`),
      (data) => {
        if (!data) return;
        setVotesA(data.userA?.votes || 0);
        setVotesB(data.userB?.votes || 0);
        setLikeCount(data.likeCount || 0);
        setCommentCount(data.commentCount || 0);
        setShareCount(data.shareCount || 0);

        const total = (data.userA?.votes || 0) + (data.userB?.votes || 0);
        const newProgress = total > 0 ? (data.userA?.votes || 0) / total : 0.5;
        setProgressA(newProgress);
        barProgress.value = withSpring(newProgress, { damping: 15, stiffness: 100 });
      },
    );
    return () => unsub();
  }, [item.id, user]);

  const animatedBarStyle = useAnimatedStyle(() => ({
    width: `${barProgress.value * 100}%`,
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

  const getRandomMessage = (messages: string[]) => {
    return messages[Math.floor(Math.random() * messages.length)];
  };

  const handleVote = async (votedForUid: string) => {
    if (!user) return Alert.alert("Login required", "Please login to vote.");
    triggerHaptic();
    try {
      await contestService.voteOnMatch(item.id, votedForUid, 'device_id');
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 3000);
      addToast(getRandomMessage(funnyVoteMessages), 'success');
    } catch (error: any) {
      addToast(error.message || "Vote fail ho gaya!", 'error');
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
    } catch (error) {
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
    } catch (error) {
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
    return () => clearInterval(timer);
  }, [getTimeRemaining]);

  const nameA = item.joinIdA || item.userA.username || "User A";
  const nameB = item.joinIdB || item.userB?.username || "User B";

  const isALeading = votesA > votesB;
  const isBLeading = votesB > votesA;

  const picA = item.userA.profilePic || item.userA.profileImageUrl || `https://ui-avatars.com/api/?name=${nameA}&background=random`;
  const picB = item.userB?.profilePic || item.userB?.profileImageUrl || `https://ui-avatars.com/api/?name=${nameB}&background=random`;

  return (
    <View style={[styles.postContainer, { backgroundColor: cardColor }]}>
      {showConfetti && (
        <LottieView
            source={{ uri: 'https://assets2.lottiefiles.com/packages/lf20_u4y36v.json' }}
            autoPlay
            loop={false}
            style={styles.confetti}
            pointerEvents="none"
        />
      )}
      
      <View style={styles.postHeader}>
        <View style={styles.userInfo}>
           <View style={styles.avatarContainer}>
              <View style={[styles.avatarWrapper, isALeading && styles.leadingAvatar, { zIndex: 2 }]}>
                <Image source={{ uri: picA }} style={styles.avatarImage} />
              </View>
              {item.userB && (
                <View style={[styles.avatarWrapper, isBLeading && styles.leadingAvatar, { marginLeft: -15, zIndex: 1 }]}>
                  <Image source={{ uri: picB }} style={styles.avatarImage} />
                </View>
              )}
           </View>
           <View style={styles.nameContainer}>
               <Text style={[styles.username, { color: textColor }]} numberOfLines={1}>
                   <Text style={{ fontFamily: 'Urbanist-Bold', fontSize: 16 }}>{nameA}</Text>
                   <Text style={{ fontFamily: 'Urbanist-Medium', fontSize: 13, color: subTextColor }}> vs </Text>
                   <Text style={{ fontFamily: 'Urbanist-Bold', fontSize: 16 }}>{nameB}</Text>
               </Text>
               <Text style={[styles.timeText, { color: subTextColor }]}>{item.title}</Text> 
           </View>
        </View>
        {item.entryFee > 0 && (
            <View style={[styles.prizeBadge, { flexDirection: 'row', alignItems: 'center', gap: 4 }]}>
                <Ionicons name="trophy" size={13} color="#FFD700" />
                <Text style={styles.prizeText}>{item.entryFee * 1.8} Dpcoins</Text>
            </View>
        )}
      </View>

      <Pressable onPress={handleDoubleTap} style={styles.mediaSection}>
        <View style={styles.imageWrapper}>
            <Image source={{ uri: item.userA.mediaUrl }} style={[styles.postImage, isALeading && styles.leadingImage]} />
            {isALeading && <View style={styles.crownContainer}><MaterialCommunityIcons name="crown" size={20} color="#FFD700" /></View>}
        </View>
        <View style={styles.imageWrapper}>
            <Image source={{ uri: item.userB.mediaUrl }} style={[styles.postImage, isBLeading && styles.leadingImage]} />
            {isBLeading && <View style={styles.crownContainer}><MaterialCommunityIcons name="crown" size={20} color="#FFD700" /></View>}
        </View>
        
        <Animated.View pointerEvents="none" style={[styles.largeHeart, animatedHeartStyle]}>
            <HeartIcon_Filled width={100} height={100} color="#FF4D67" />
        </Animated.View>
      </Pressable>
      
      <View style={styles.voteButtonSection}>
        <TouchableOpacity style={styles.voteButton} onPress={() => handleVote(item.userA.uid)}>
            <Text style={styles.voteButtonText}>Vote {nameA}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.voteButton, { backgroundColor: '#FF8A4D' }]} onPress={() => handleVote(item.userB.uid)}>
            <Text style={styles.voteButtonText}>Vote {nameB}</Text>
        </TouchableOpacity>
      </View>
      
      <View style={styles.pollInfoSection}>
        <View style={styles.progressBarContainer}>
            <AnimatedLinearGradient
                colors={['#FF4D7E', '#FFC54D']}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={[styles.progressBar, animatedBarStyle]}
            />
        </View>
        <View style={styles.voteLabels}>
            <Text style={[styles.votePercent, { color: textColor }]}>{Math.round(progressA * 100)}%</Text>
            <Text style={[styles.pollEnds, { color: subTextColor }]}>{timeRemaining}</Text>
            <Text style={[styles.votePercent, { color: textColor }]}>{Math.round((1 - progressA) * 100)}%</Text>
        </View>
      </View>

      <View style={styles.actionBar}>
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

const styles = StyleSheet.create({
  postContainer: { borderRadius: 24, marginHorizontal: 8, marginBottom: 20, elevation: 3, paddingBottom: 10, position: 'relative' },
  confetti: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
  postHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  userInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  avatarContainer: { flexDirection: 'row', alignItems: 'center' },
  avatarWrapper: { width: 38, height: 38, borderRadius: 19, borderWidth: 2, borderColor: '#FFF', overflow: 'hidden', backgroundColor: '#EEE' },
  avatarImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  leadingAvatar: { borderColor: '#FFD700', borderWidth: 2.5 },
  nameContainer: { marginLeft: 10, flex: 1 },
  username: { fontSize: 16 },
  timeText: { fontFamily: 'Urbanist-Medium', fontSize: 12, marginTop: 1 },
  prizeBadge: { backgroundColor: '#FFF9C4', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: '#FFD700' },
  prizeText: { fontFamily: 'Urbanist-Bold', fontSize: 11, color: '#FBC02D' },
  mediaSection: { flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: 16, gap: 10, position: 'relative' },
  imageWrapper: { flex: 1, position: 'relative' },
  postImage: { width: '100%', height: 250, borderRadius: 20, backgroundColor: '#EEE' },
  leadingImage: { borderWidth: 3, borderColor: '#FFD700' },
  crownContainer: { position: 'absolute', top: -10, left: '40%', zIndex: 10 },
  largeHeart: { position: 'absolute', top: '30%', left: '35%', zIndex: 20 },
  voteButtonSection: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 15, gap: 10 },
  voteButton: { flex: 1, backgroundColor: '#FF4D67', paddingVertical: 12, borderRadius: 20, alignItems: 'center' },
  voteButtonText: { fontFamily: 'Urbanist-Bold', fontSize: 12, color: '#FFF' },
  pollInfoSection: { paddingHorizontal: 16, marginTop: 20 },
  progressBarContainer: { width: '100%', height: 8, backgroundColor: '#E0E0E0', borderRadius: 4, overflow: 'hidden' },
  progressBar: { height: '100%', borderRadius: 4 },
  voteLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  votePercent: { fontFamily: 'Urbanist-Bold', fontSize: 12 },
  pollEnds: { fontFamily: 'Urbanist-Medium', fontSize: 11 },
  actionBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingTop: 15 },
  leftActions: { flexDirection: 'row', alignItems: 'center' },
  actionItem: { flexDirection: 'row', alignItems: 'center', marginRight: 24 },
  actionCount: { fontFamily: 'Urbanist-Bold', fontSize: 13, marginLeft: 8 },
});
