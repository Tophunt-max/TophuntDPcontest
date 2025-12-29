import React, { useState, memo, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Icons from '@/assets/svgs';
import { CommentSheet } from '../comments/CommentSheet';
import { Battle } from '@/src/types/contest';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useAuth } from '@/src/hooks/useAuth';
import { Video, ResizeMode } from 'expo-av';
import { reactionService } from '@/src/services/contests/reactionService';
import { engagementService } from '@/src/services/contests/engagementService';
import { notificationService } from '@/src/services/notifications/notificationService';
import Animated, { 
  ZoomIn, 
  FadeOut, 
  useSharedValue, 
  useAnimatedStyle, 
  withSpring, 
  withSequence, 
  withDelay,
  withTiming,
  runOnJS
} from 'react-native-reanimated';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';

const { width } = Dimensions.get('window');

interface PostProps {
    item: Battle;
    isDark: boolean;
}

const AnimatedHeart = ({ onFinish }: { onFinish: () => void }) => {
    const scale = useSharedValue(0);
    const opacity = useSharedValue(0);

    useEffect(() => {
        scale.value = withSequence(
            withSpring(1.2),
            withDelay(500, withTiming(0, undefined, (finished) => {
                if (finished) runOnJS(onFinish)();
            }))
        );
        opacity.value = withSequence(
            withTiming(1, { duration: 100 }),
            withDelay(500, withTiming(0))
        );
    }, []);

    const style = useAnimatedStyle(() => ({
        transform: [{ scale: scale.value }],
        opacity: opacity.value
    }));

    return (
        <Animated.View style={[styles.heartOverlay, style]}>
            <Ionicons name="heart" size={80} color="#FFF" />
        </Animated.View>
    );
};

export const Post = memo(({ item, isDark }: PostProps) => {
  const { user } = useAuth();
  const [showComments, setShowComments] = useState(false);
  const [votedFor, setVotedFor] = useState<string | null>(null);
  const [isVoting, setIsVoting] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [timeLeft, setTimeLeft] = useState('');
  
  // Animation states
  const [showHeartA, setShowHeartA] = useState(false);
  const [showHeartB, setShowHeartB] = useState(false);
  
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  const borderColor = isDark ? '#35383F' : '#EEEEEE';
  const activePink = '#FF4D67';

  const [votesA, setVotesA] = useState(item.userA.votes);
  const [votesB, setVotesB] = useState(item.userB.votes);

  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date().getTime();
      const end = item.endDate.toDate().getTime();
      const distance = end - now;
      if (distance < 0) { setTimeLeft('Ended'); clearInterval(timer); }
      else {
        const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((distance % (1000 * 60)) / 1000);
        setTimeLeft(`${hours}h ${minutes}m ${seconds}s`);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [item.endDate]);

  const handleVote = useCallback(async (participantId: string, side: 'A' | 'B') => {
    if (!user || isVoting || votedFor) return;
    
    // 1. Haptic Feedback
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    // 2. Optimistic Update
    setIsVoting(true);
    setVotedFor(participantId);
    if (side === 'A') setVotesA(prev => prev + 1);
    else setVotesB(prev => prev + 1);

    try {
      const functions = getFunctions();
      const voteFn = httpsCallable(functions, 'voteInBattle');
      await voteFn({ battleId: item.id, participantId });
    } catch (error) { 
        console.error(error); 
        // Revert on failure (optional, but good practice)
    } finally { setIsVoting(false); }
  }, [user, isVoting, votedFor, item.id]);

  const onDoubleTapA = useCallback(() => {
      if (votedFor) return;
      setShowHeartA(true);
      handleVote(item.userA.userId, 'A');
  }, [votedFor, handleVote, item.userA.userId]);

  const onDoubleTapB = useCallback(() => {
      if (votedFor) return;
      setShowHeartB(true);
      handleVote(item.userB.userId, 'B');
  }, [votedFor, handleVote, item.userB.userId]);

  // Gestures
  const tapA = Gesture.Tap().numberOfTaps(2).onEnd(runOnJS(onDoubleTapA));
  const tapB = Gesture.Tap().numberOfTaps(2).onEnd(runOnJS(onDoubleTapB));

  const handleBookmark = async () => {
    if (!user) return;
    try {
      Haptics.selectionAsync();
      const result = await engagementService.toggleBookmark(item.id, user.uid);
      setIsBookmarked(result);
      if (result) notificationService.notifyBattleAction(item.id, [item.userA.userId, item.userB.userId], item.contestName, 'bookmark');
    } catch (e) { console.error(e); }
  };

  const handleShare = async () => {
    Haptics.selectionAsync();
    const shared = await engagementService.shareBattle(item.contestName, item.userA.username, item.userB.username);
    if (shared) notificationService.notifyBattleAction(item.id, [item.userA.userId, item.userB.userId], item.contestName, 'share');
  };

  return (
    <View style={[styles.postContainer, { borderBottomColor: borderColor }]}>
      <View style={styles.postHeader}>
        <View style={styles.userInfo}>
           <View style={styles.avatarContainer}>
              <Image source={{ uri: item.userA.profileImageUrl || 'https://ui-avatars.com/api/?name=A' }} style={styles.avatarMain} />
              <Image source={{ uri: item.userB.profileImageUrl || 'https://ui-avatars.com/api/?name=B' }} style={[styles.avatarSub, { borderColor: isDark ? '#181A20' : '#fff' }]} />
           </View>
           <View style={styles.nameContainer}>
               <Text style={[styles.username, { color: textColor }]} numberOfLines={1}>
                   <Text style={{ fontFamily: 'Urbanist-Bold' }}>{item.userA.displayName}</Text>
                   <Text style={[styles.mentionText, { color: subTextColor }]}> VS </Text>
                   <Text style={{ fontFamily: 'Urbanist-Bold' }}>{item.userB.displayName}</Text>
               </Text>
               <Text style={[styles.timeText, { color: subTextColor }]}>{item.contestName}</Text> 
           </View>
        </View>
        <TouchableOpacity><Ionicons name="ellipsis-horizontal" size={24} color={textColor} /></TouchableOpacity>
      </View>

      <View style={styles.mediaSection}>
        <GestureDetector gesture={tapA}>
            <TouchableOpacity activeOpacity={0.9} style={styles.imageWrapper} onPress={() => handleVote(item.userA.userId, 'A')}>
                {item.contestType === 'video' ? <Video source={{ uri: item.userA.mediaUrl }} style={styles.postImage} resizeMode={ResizeMode.COVER} shouldPlay isLooping isMuted /> : <Image source={{ uri: item.userA.mediaUrl }} style={styles.postImage} />}
                {showHeartA && <AnimatedHeart onFinish={() => setShowHeartA(false)} />}
                {votedFor === item.userA.userId && !showHeartA && <Animated.View entering={ZoomIn} style={styles.thankYouBadge}><Text style={styles.thankYouText}>Voted</Text></Animated.View>}
            </TouchableOpacity>
        </GestureDetector>

        <GestureDetector gesture={tapB}>
            <TouchableOpacity activeOpacity={0.9} style={styles.imageWrapper} onPress={() => handleVote(item.userB.userId, 'B')}>
                {item.contestType === 'video' ? <Video source={{ uri: item.userB.mediaUrl }} style={styles.postImage} resizeMode={ResizeMode.COVER} shouldPlay isLooping isMuted /> : <Image source={{ uri: item.userB.mediaUrl }} style={styles.postImage} />}
                {showHeartB && <AnimatedHeart onFinish={() => setShowHeartB(false)} />}
                {votedFor === item.userB.userId && !showHeartB && <Animated.View entering={ZoomIn} style={styles.thankYouBadge}><Text style={styles.thankYouText}>Voted</Text></Animated.View>}
            </TouchableOpacity>
        </GestureDetector>
      </View>

      <View style={styles.votingButtonsContainer}>
          <TouchableOpacity style={[styles.voteButton, votedFor === item.userA.userId && { backgroundColor: activePink }]} onPress={() => handleVote(item.userA.userId, 'A')} disabled={!!votedFor}>
             <Text style={[styles.voteButtonText, { color: votedFor === item.userA.userId ? '#FFF' : textColor }]}>{votesA} Votes</Text>
          </TouchableOpacity>
          <View style={styles.vsCenter}><Text style={{fontFamily: 'Urbanist-Bold', color: activePink}}>VS</Text></View>
          <TouchableOpacity style={[styles.voteButton, votedFor === item.userB.userId && { backgroundColor: activePink }]} onPress={() => handleVote(item.userB.userId, 'B')} disabled={!!votedFor}>
             <Text style={[styles.voteButtonText, { color: votedFor === item.userB.userId ? '#FFF' : textColor }]}>{votesB} Votes</Text>
          </TouchableOpacity>
      </View>

      <View style={styles.reactionsBar}>
          <TouchableOpacity style={styles.reactionBtn} onPress={() => { Haptics.selectionAsync(); reactionService.addReaction(item.id, user?.uid!, 'fire'); }}><Text style={{fontSize: 20}}>🔥</Text></TouchableOpacity>
          <TouchableOpacity style={styles.reactionBtn} onPress={() => { Haptics.selectionAsync(); reactionService.addReaction(item.id, user?.uid!, 'heart'); }}><Text style={{fontSize: 20}}>❤️</Text></TouchableOpacity>
          <View style={{flex: 1}} />
          <Text style={[styles.pollTimer, { color: subTextColor }]}>Ends in: <Text style={{ color: textColor }}>{timeLeft}</Text></Text>
      </View>

      <View style={styles.actionBar}>
        <View style={styles.leftActions}>
            <TouchableOpacity style={styles.actionItem} onPress={() => setShowComments(true)}>
               <Icons.ChatIcon_Light width={26} height={26} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>Discuss</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionItem} onPress={handleShare}>
               <Icons.Share_Icon width={26} height={26} color={textColor} />
            </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={handleBookmark}>
            {isBookmarked ? <Icons.Bookmark_Filled width={26} height={26} color={activePink} /> : <Icons.Bookmark_Outline width={26} height={26} color={textColor} />}
        </TouchableOpacity>
      </View>

      <CommentSheet postId={item.id} visible={showComments} onDismiss={() => setShowComments(false)} isDark={isDark} />
    </View>
  );
});

const styles = StyleSheet.create({
  postContainer: { marginBottom: 25, paddingBottom: 15, borderBottomWidth: 1 },
  postHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  userInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  avatarContainer: { width: 50, height: 44, position: 'relative' },
  avatarMain: { width: 34, height: 34, borderRadius: 17, position: 'absolute', top: 0, left: 0, zIndex: 2 },
  avatarSub: { width: 34, height: 34, borderRadius: 17, position: 'absolute', bottom: 0, right: 0, borderWidth: 2, zIndex: 1 },
  nameContainer: { marginLeft: 10, flex: 1 },
  username: { fontSize: 15 },
  mentionText: { fontFamily: 'Urbanist-Medium' },
  timeText: { fontFamily: 'Urbanist-Medium', fontSize: 12, marginTop: 1 },
  mediaSection: { flexDirection: 'row', paddingHorizontal: 16, justifyContent: 'space-between' },
  imageWrapper: { width: (width - 42) / 2, height: ((width - 42) / 2) * 1.3, borderRadius: 20, overflow: 'hidden', position: 'relative', justifyContent: 'center', alignItems: 'center', backgroundColor: '#EEE' },
  postImage: { width: '100%', height: '100%', position: 'absolute' },
  thankYouBadge: { backgroundColor: 'rgba(0, 0, 0, 0.7)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, zIndex: 10 },
  thankYouText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 14 },
  heartOverlay: { position: 'absolute', zIndex: 20, shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 5 },
  votingButtonsContainer: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 15, alignItems: 'center' },
  voteButton: { flex: 1, paddingVertical: 10, borderRadius: 12, backgroundColor: '#F5F5F5', alignItems: 'center' },
  vsCenter: { paddingHorizontal: 15 },
  voteButtonText: { fontFamily: 'Urbanist-Bold', fontSize: 14 },
  reactionsBar: { flexDirection: 'row', paddingHorizontal: 16, marginTop: 15, alignItems: 'center' },
  reactionBtn: { marginRight: 15, backgroundColor: '#F5F5F5', padding: 8, borderRadius: 20 },
  pollTimer: { fontFamily: 'Urbanist-Medium', fontSize: 12 },
  actionBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginTop: 15 },
  leftActions: { flexDirection: 'row', alignItems: 'center' },
  actionItem: { flexDirection: 'row', alignItems: 'center', marginRight: 20 },
  actionCount: { fontFamily: 'Urbanist-Bold', fontSize: 13, marginLeft: 8 }
});
