import React, { useState, memo, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions, Alert, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { CommentSheet } from '../comments/CommentSheet';
import { ShareSheet } from '../share/ShareSheet';
import { VotersSheet } from './VotersSheet';
import { WinnerResultSheet } from './WinnerResultSheet';
import { useAuth } from '@/src/hooks/useAuth';
import { contestService } from '@/src/services/contests/contestService';
import { firestore } from '@/src/services/firebase/initFirebase';
import { doc, onSnapshot, getDoc } from 'firebase/firestore';
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
  runOnJS,
  withTiming
} from 'react-native-reanimated';
import { 
  HeartIcon_Light, 
  HeartIcon_Filled, 
  ChatIcon_Light, 
  Share_Icon, 
  Bookmark_Outline, 
  Bookmark_Filled,
  Trophy_Icon
} from '@/assets/svgs';
import { PostSkeleton } from './PostSkeleton';
import { getCachedMedia } from '@/src/services/media/MediaCacheService';
import { getOptimizedMediaUrl } from '@/src/utils/media';
import { useRouter } from 'expo-router';

const { width } = Dimensions.get('window');

interface PostCardProps {
    item?: any;
    isDark: boolean;
    loading?: boolean;
}

const AnimatedLinearGradient = Animated.createAnimatedComponent(LinearGradient);
const blurhash =
  '|rF?hV%2WCj[ayj[a|j[az_NaeWBj@ayfRayfQfQM{M|azj[azf6fQfQfQIpWXofj[ayj[j[fQayWCoeoeaya}j[ayfQa{oLj?j[WVj[ayayj[fQoff7azayj[ayj[j[ayofayayayj[fQj[ayayj[ayfjj[j[ayjuayj[';

const PostCardContent = memo(({ item, isDark }: { item: any; isDark: boolean }) => {
  const { user } = useAuth();
  const router = useRouter();
  const { addToast } = useToast();
  const [showComments, setShowComments] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showVoters, setShowVoters] = useState(false);
  const [showWinner, setShowWinner] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [votedFor, setVotedFor] = useState<string | null>(null);
  
  const cardColor = isDark ? '#1A1D23' : '#FFFFFF';
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  const borderColor = isDark ? '#2A2D35' : '#F0F0F0';

  // Real-time states
  const [matchData, setMatchData] = useState(item);
  const [votesA, setVotesA] = useState(item.userA.votes || 0);
  const [votesB, setVotesB] = useState(item.userB?.votes || 0);
  const [likeCount, setLikeCount] = useState(item.likeCount || 0);
  const [commentCount, setCommentCount] = useState(item.commentCount || 0);
  const [shareCount, setShareCount] = useState(item.shareCount || 0);
  const [progressA, setProgressA] = useState(0.5);

  const [mediaA, setMediaA] = useState<string | null>(null);
  const [mediaB, setMediaB] = useState<string | null>(null);

  // Animation values
  const heartScale = useSharedValue(0);
  const barProgress = useSharedValue(0.5);
  const lastTap = useRef<number>(0);
  const isHeartAnimating = useRef<boolean>(false);

  useEffect(() => {
    if (!item.id) return;
    
    const unsubMatch = onSnapshot(doc(firestore, 'contestMatches', item.id), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setMatchData({ id: snapshot.id, ...data });
        setVotesA(data.userA.votes || 0);
        setVotesB(data.userB?.votes || 0);
        setLikeCount(data.likeCount || 0);
        setCommentCount(data.commentCount || 0);
        setShareCount(data.shareCount || 0);
        
        const total = (data.userA.votes || 0) + (data.userB?.votes || 0);
        const newProgress = total > 0 ? (data.userA.votes || 0) / total : 0.5;
        setProgressA(newProgress);
        barProgress.value = withSpring(newProgress, { damping: 15, stiffness: 100 });
      }
    });

    if (user) {
        const checkBookmark = async () => {
            const bookmarkRef = doc(firestore, `users/${user.uid}/bookmarks`, item.id);
            const snap = await getDoc(bookmarkRef);
            if (snap.exists()) setIsBookmarked(true);
        };
        checkBookmark();

        const checkLike = async () => {
            const likeRef = doc(firestore, `contestMatches/${item.id}/likes`, user.uid);
            const snap = await getDoc(likeRef);
            if (snap.exists()) setIsLiked(true);
        };
        checkLike();

        const checkVote = async () => {
            const voteRef = doc(firestore, 'votes', `${item.id}_${user.uid}`);
            const snap = await getDoc(voteRef);
            if (snap.exists()) {
                setVotedFor(snap.data()?.votedForUid);
            }
        };
        checkVote();
    }

    const loadMedia = async () => {
        const urlA = getOptimizedMediaUrl(item.userA.mediaUrl);
        const urlB = getOptimizedMediaUrl(item.userB.mediaUrl);
        const [cachedA, cachedB] = await Promise.all([
            getCachedMedia(urlA),
            getCachedMedia(urlB)
        ]);
        setMediaA(cachedA);
        setMediaB(cachedB);
    };
    loadMedia();

    return () => unsubMatch();
  }, [item.id, user]);

  const animatedBarStyle = useAnimatedStyle(() => ({
    width: `${barProgress.value * 100}%`,
  }));

  const triggerHaptic = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const navigateToProfile = (userId: string) => {
      router.push(`/profile?userId=${userId}`);
  };

  const handleDoubleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < 300) {
      if (!isHeartAnimating.current) {
        isHeartAnimating.current = true;
        heartScale.value = withSequence(
            withSpring(1.2, { damping: 15, stiffness: 400 }),
            withDelay(100, withTiming(0, { duration: 150 }, (finished) => {
                if (finished) runOnJS(() => { isHeartAnimating.current = false; })();
            }))
        );
        if (!isLiked) handleLike();
        triggerHaptic();
      }
    }
    lastTap.current = now;
  };

  const handleVote = async (votedForUid: string) => {
    if (!user) return Alert.alert("Login required", "Please login to vote.");
    if (votedFor) return addToast("Aap pehle hi vote kar chuke hain!", 'info');
    if (matchData.status === 'ended') return addToast("Battle khatam ho chuki hai!", 'info');
    
    triggerHaptic();
    try {
      await contestService.voteOnMatch(item.id, votedForUid, 'device_id');
      setVotedFor(votedForUid);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 3000);
      addToast("Vote cast successfully! 🚀", 'success');
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
      setLikeCount(prev => newLikedStatus ? prev + 1 : Math.max(0, prev - 1));
      await contestService.likeMatch(item.id);
    } catch (error) {
       setIsLiked(!isLiked);
       setLikeCount(item.likeCount || 0);
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
      const prevStatus = isBookmarked;
      setIsBookmarked(!prevStatus);
      const status = await engagementService.toggleBookmark(item.id, user.uid);
      setIsBookmarked(status);
    } catch (error) {
        setIsBookmarked(!isBookmarked);
    }
  };

  const animatedHeartStyle = useAnimatedStyle(() => ({
    transform: [{ scale: heartScale.value }],
    opacity: heartScale.value > 0.1 ? 1 : 0,
  }));

  const formatTimeRemaining = (endDate: Date) => {
    const diff = endDate.getTime() - Date.now();
    if (diff <= 0) return 'Ended';
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s left`;
    return `${minutes}m ${seconds}s left`;
  };

  const [timeRemaining, setTimeRemaining] = useState('');
  useEffect(() => {
    const end = matchData.endDate || item.endDate || item.expiresAt;
    if (!end) return;
    const endDate = end.toDate ? end.toDate() : new Date(end);
    const updateTimer = () => setTimeRemaining(formatTimeRemaining(endDate));
    updateTimer();
    const timer = setInterval(updateTimer, 1000);
    return () => clearInterval(timer);
  }, [matchData.endDate, item.endDate, item.expiresAt]);

  const nameA = item.userA.displayName || item.userA.username || item.joinIdA || "User A";
  const nameB = item.userB?.displayName || item.userB?.username || item.joinIdB || "User B";

  const isALeading = votesA > votesB;
  const isBLeading = votesB > votesA;
  const isEnded = matchData.status === 'ended' || timeRemaining === 'Ended';

  const picA = getOptimizedMediaUrl(item.userA.profilePic || item.userA.profileImageUrl || `https://ui-avatars.com/api/?name=${nameA}&background=random`);
  const picB = getOptimizedMediaUrl(item.userB?.profilePic || item.userB?.profileImageUrl || `https://ui-avatars.com/api/?name=${nameB}&background=random`);

  return (
    <View style={[styles.postContainer, { backgroundColor: cardColor, borderColor }]}>
      {showConfetti && (
        <LottieView
            source={{ uri: 'https://assets2.lottiefiles.com/packages/lf20_u4y36v.json' }}
            autoPlay loop={false} style={styles.confetti} pointerEvents="none"
        />
      )}
      
      <View style={styles.postHeader}>
        <View style={styles.userInfo}>
           <View style={styles.avatarContainer}>
              <TouchableOpacity onPress={() => navigateToProfile(item.userA.uid)} style={[styles.avatarWrapper, isALeading && !isEnded && styles.leadingAvatar, { zIndex: 2 }]}>
                <Image source={{ uri: picA }} style={styles.avatarImage} contentFit="cover" transition={200} />
              </TouchableOpacity>
              {item.userB && (
                <TouchableOpacity onPress={() => navigateToProfile(item.userB.uid)} style={[styles.avatarWrapper, isBLeading && !isEnded && styles.leadingAvatar, { marginLeft: -12, zIndex: 1 }]}>
                  <Image source={{ uri: picB }} style={styles.avatarImage} contentFit="cover" transition={200} />
                </TouchableOpacity>
              )}
           </View>
           <View style={styles.nameContainer}>
               <Text style={[styles.username, { color: textColor }]} numberOfLines={1}>
                   <TouchableOpacity onPress={() => navigateToProfile(item.userA.uid)}><Text style={styles.boldName}>{nameA}</Text></TouchableOpacity>
                   <Text style={[styles.vsText, { color: subTextColor }]}> vs </Text>
                   <TouchableOpacity onPress={() => navigateToProfile(item.userB?.uid)}><Text style={styles.boldName}>{nameB}</Text></TouchableOpacity>
               </Text>
               <Text style={[styles.titleText, { color: subTextColor }]}>{item.title}</Text> 
           </View>
        </View>
        {isEnded ? (
            <View style={styles.endedBadge}>
                <Text style={styles.endedText}>ENDED</Text>
            </View>
        ) : item.entryFee > 0 && (
            <LinearGradient colors={['#FFD700', '#FFA000']} style={styles.prizeBadge}>
                <Text style={styles.prizeText}>🏆 {item.entryFee * 1.8}</Text>
            </LinearGradient>
        )}
      </View>

      <Pressable onPress={handleDoubleTap} style={styles.mediaSection}>
        <View style={styles.imageWrapper}>
            <Image 
              source={{ uri: mediaA || getOptimizedMediaUrl(item.userA.mediaUrl) }} 
              style={[styles.postImage, isALeading && !isEnded && styles.leadingImage]} 
              contentFit="cover" transition={200} placeholder={blurhash}
            />
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.7)']} style={styles.imageOverlay}>
                <TouchableOpacity onPress={() => navigateToProfile(item.userA.uid)}>
                    <Text style={styles.overlayName} numberOfLines={1}>{nameA}</Text>
                </TouchableOpacity>
            </LinearGradient>
            {isALeading && !isEnded && <View style={styles.crownContainer}><Text style={{fontSize: 18}}>👑</Text></View>}
            {votedFor === item.userA.uid && (
                <View style={styles.votedBadge}>
                    <Text style={styles.votedText}>VOTED ✅</Text>
                </View>
            )}
        </View>

        <View style={styles.vsBadge}>
            <Text style={styles.vsBadgeText}>VS</Text>
        </View>

        <View style={styles.imageWrapper}>
            <Image 
              source={{ uri: mediaB || getOptimizedMediaUrl(item.userB.mediaUrl) }} 
              style={[styles.postImage, isBLeading && !isEnded && styles.leadingImage]} 
              contentFit="cover" transition={200} placeholder={blurhash}
            />
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.7)']} style={styles.imageOverlay}>
                <TouchableOpacity onPress={() => navigateToProfile(item.userB?.uid)}>
                    <Text style={styles.overlayName} numberOfLines={1}>{nameB}</Text>
                </TouchableOpacity>
            </LinearGradient>
            {isBLeading && !isEnded && <View style={styles.crownContainer}><Text style={{fontSize: 18}}>👑</Text></View>}
            {votedFor === item.userB.uid && (
                <View style={styles.votedBadge}>
                    <Text style={styles.votedText}>VOTED ✅</Text>
                </View>
            )}
        </View>
        
        <Animated.View pointerEvents="none" style={[styles.largeHeart, animatedHeartStyle]}>
            <HeartIcon_Filled width={100} height={100} color="#FF4D67" />
        </Animated.View>
      </Pressable>
      
      {isEnded ? (
          <View style={styles.resultContainer}>
              <TouchableOpacity style={styles.resultButton} onPress={() => setShowWinner(true)}>
                  <LinearGradient colors={['#FFD700', '#FFA500']} start={{x:0, y:0}} end={{x:1, y:0}} style={styles.resultGradient}>
                      <Trophy_Icon width={20} height={20} color="#FFF" />
                      <Text style={styles.resultButtonText}>VIEW WINNER & RESULTS</Text>
                  </LinearGradient>
              </TouchableOpacity>
              <Text style={[styles.finalVotesText, { color: subTextColor }]}>Total {votesA + votesB} votes cast</Text>
          </View>
      ) : (
          <View style={styles.voteButtonSection}>
            <View style={styles.voteButtonWrapper}>
                <TouchableOpacity 
                    style={[styles.voteButton, !!votedFor && votedFor !== item.userA.uid && { opacity: 0.5 }]} 
                    onPress={() => handleVote(item.userA.uid)}
                    disabled={!!votedFor}
                >
                    <LinearGradient 
                        colors={votedFor === item.userA.uid ? ['#4CAF50', '#81C784'] : ['#FF4D67', '#FF7388']} 
                        style={styles.voteButtonGradient}
                    >
                        <Text style={styles.voteButtonText}>
                            {votedFor === item.userA.uid ? 'VOTED' : `Vote ${nameA.split(' ')[0]}`}
                        </Text>
                    </LinearGradient>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setShowVoters(true)}>
                    <Text style={[styles.voteCountLabel, { color: votedFor === item.userA.uid ? '#4CAF50' : textColor }]}>{votesA} votes</Text>
                </TouchableOpacity>
            </View>
            
            <View style={styles.voteButtonWrapper}>
                <TouchableOpacity 
                    style={[styles.voteButton, !!votedFor && votedFor !== item.userB.uid && { opacity: 0.5 }]} 
                    onPress={() => handleVote(item.userB.uid)}
                    disabled={!!votedFor}
                >
                    <LinearGradient 
                        colors={votedFor === item.userB.uid ? ['#4CAF50', '#81C784'] : ['#FF8A4D', '#FFA776']} 
                        style={styles.voteButtonGradient}
                    >
                        <Text style={styles.voteButtonText}>
                            {votedFor === item.userB.uid ? 'VOTED' : `Vote ${nameB.split(' ')[0]}`}
                        </Text>
                    </LinearGradient>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setShowVoters(true)}>
                    <Text style={[styles.voteCountLabel, { color: votedFor === item.userB.uid ? '#4CAF50' : textColor }]}>{votesB} votes</Text>
                </TouchableOpacity>
            </View>
          </View>
      )}
      
      <View style={styles.pollInfoSection}>
        {!isEnded && (
            <View style={styles.progressBarContainer}>
                <AnimatedLinearGradient
                    colors={['#FF4D67', '#FF8A4D']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={[styles.progressBar, animatedBarStyle]}
                />
            </View>
        )}
        <View style={styles.voteLabels}>
            <Text style={[styles.votePercent, { color: textColor }]}>{Math.round(progressA * 100)}%</Text>
            <View style={styles.timerRow}>
                <Text style={[styles.pollEnds, { color: isEnded ? '#FF4D67' : subTextColor }]}>
                    {isEnded ? 'Battle Ended' : timeRemaining}
                </Text>
            </View>
            <Text style={[styles.votePercent, { color: textColor }]}>{Math.round((1 - progressA) * 100)}%</Text>
        </View>
      </View>

      <View style={styles.actionBar}>
        <View style={styles.leftActions}>
            <TouchableOpacity style={styles.actionItem} onPress={handleLike}>
               {isLiked ? <HeartIcon_Filled width={24} height={24} color="#FF4D67" /> : <HeartIcon_Light width={24} height={24} color={textColor} />}
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
      <VotersSheet visible={showVoters} onDismiss={() => setShowVoters(false)} matchId={item.id} isDark={isDark} userA={{ uid: item.userA.uid, name: nameA }} userB={{ uid: item.userB.uid, name: nameB }} />
      <WinnerResultSheet visible={showWinner} onDismiss={() => setShowWinner(false)} match={matchData} isDark={isDark} />
    </View>
  );
});

export const PostCard = memo(({ item, isDark, loading }: PostCardProps) => {
    if (loading || !item) {
        return <PostSkeleton isDark={isDark} />;
    }
    return <PostCardContent item={item} isDark={isDark} />;
});

const styles = StyleSheet.create({
  postContainer: { 
    borderRadius: 24, marginHorizontal: 12, marginBottom: 24, borderWidth: 1, paddingBottom: 16, 
    overflow: 'hidden', shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 10, elevation: 5,
  },
  confetti: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100 },
  postHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 14 },
  userInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  avatarContainer: { flexDirection: 'row', alignItems: 'center' },
  avatarWrapper: { width: 36, height: 36, borderRadius: 18, borderWidth: 2, borderColor: '#FFF', overflow: 'hidden', backgroundColor: '#F0F0F0' },
  avatarImage: { width: '100%', height: '100%' },
  leadingAvatar: { borderColor: '#FFD700', borderWidth: 2 },
  nameContainer: { marginLeft: 12, flex: 1 },
  username: { fontSize: 14, fontFamily: 'Urbanist-Bold', flexDirection: 'row', alignItems: 'center' },
  boldName: { fontFamily: 'Urbanist-Bold' },
  vsText: { fontFamily: 'Urbanist-Medium', fontSize: 11 },
  titleText: { fontFamily: 'Urbanist-Medium', fontSize: 11, marginTop: 1 },
  prizeBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, elevation: 2 },
  prizeText: { fontFamily: 'Urbanist-Bold', fontSize: 10, color: '#FFF' },
  endedBadge: { backgroundColor: '#FFEBEE', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  endedText: { color: '#FF4D67', fontSize: 10, fontFamily: 'Urbanist-Black' },
  mediaSection: { flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: 16, gap: 8, position: 'relative', marginTop: 4 },
  imageWrapper: { flex: 1, position: 'relative', height: 220, borderRadius: 16, overflow: 'hidden' },
  postImage: { width: '100%', height: '100%', backgroundColor: '#F5F5F5' },
  leadingImage: { borderWidth: 2, borderColor: '#FFD700' },
  imageOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 40, justifyContent: 'flex-end', padding: 8 },
  overlayName: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Bold' },
  vsBadge: { 
    position: 'absolute', top: '45%', left: '42.5%', width: 34, height: 34, borderRadius: 17, 
    backgroundColor: '#000', zIndex: 15, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#FFF'
  },
  vsBadgeText: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Black' },
  crownContainer: { position: 'absolute', top: -8, left: '40%', zIndex: 20 },
  votedBadge: { position: 'absolute', top: 10, right: 10, backgroundColor: 'rgba(76, 175, 80, 0.9)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, zIndex: 20 },
  votedText: { color: '#FFF', fontSize: 8, fontFamily: 'Urbanist-Black' },
  largeHeart: { position: 'absolute', top: '30%', left: '35%', zIndex: 30 },
  voteButtonSection: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 16, gap: 10 },
  voteButtonWrapper: { flex: 1, alignItems: 'center' },
  voteButton: { width: '100%' },
  voteButtonGradient: { paddingVertical: 10, borderRadius: 12, alignItems: 'center' },
  voteButtonText: { fontFamily: 'Urbanist-Bold', fontSize: 11, color: '#FFF' },
  voteCountLabel: { fontFamily: 'Urbanist-Bold', fontSize: 10, marginTop: 4, opacity: 0.8 },
  resultContainer: { paddingHorizontal: 16, marginTop: 16, alignItems: 'center' },
  resultButton: { width: '100%' },
  resultGradient: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 12, gap: 10 },
  resultButtonText: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Black' },
  finalVotesText: { fontSize: 10, fontFamily: 'Urbanist-Medium', marginTop: 8, opacity: 0.7 },
  pollInfoSection: { paddingHorizontal: 16, marginTop: 18 },
  progressBarContainer: { width: '100%', height: 6, backgroundColor: '#EEEEEE', borderRadius: 3, overflow: 'hidden' },
  progressBar: { height: '100%', borderRadius: 3 },
  voteLabels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 },
  votePercent: { fontFamily: 'Urbanist-Bold', fontSize: 12 },
  timerRow: { flexDirection: 'row', alignItems: 'center' },
  pollEnds: { fontFamily: 'Urbanist-Medium', fontSize: 10 },
  actionBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 18 },
  leftActions: { flexDirection: 'row', alignItems: 'center' },
  actionItem: { flexDirection: 'row', alignItems: 'center', marginRight: 20 },
  actionCount: { fontFamily: 'Urbanist-Bold', fontSize: 12, marginLeft: 6 },
});
