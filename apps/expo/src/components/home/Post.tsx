import React, { useState, memo, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Icons from '@/assets/svgs';
import { CommentSheet } from '../comments/CommentSheet';
import { useAuth } from '@/src/hooks/useAuth';
import { useVideoPlayer, VideoView } from 'expo-video';
import { contestService } from '@/src/services/contests/contestService';
import { firestore } from '@/src/services/firebase/initFirebase';
import { doc, onSnapshot } from 'firebase/firestore';
import Animated, { 
  ZoomIn, 
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
import { Colors } from '@/constants/theme';

const { width } = Dimensions.get('window');

interface PostProps {
    item: any;
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

const VideoPostItem = ({ mediaUrl }: { mediaUrl: string }) => {
  const player = useVideoPlayer(mediaUrl, (player) => {
    player.loop = true;
    player.play();
    player.muted = true;
  });

  return <VideoView player={player} style={styles.postImage} contentFit="cover" />;
};

export const Post = memo(({ item, isDark }: PostProps) => {
  const { user } = useAuth();
  const [showComments, setShowComments] = useState(false);
  const [votedFor, setVotedFor] = useState<string | null>(null);
  const [isVoting, setIsVoting] = useState(false);
  const [timeLeft, setTimeLeft] = useState('');
  const [deviceId, setDeviceId] = useState('temp-device-id'); 
  
  const [showHeartA, setShowHeartA] = useState(false);
  const [showHeartB, setShowHeartB] = useState(false);
  
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  const borderColor = isDark ? '#35383F' : '#EEEEEE';
  const activePink = '#FF4D67';

  const [votesA, setVotesA] = useState(item.userA.votes);
  const [votesB, setVotesB] = useState(item.userB.votes);

  // REAL-TIME VOTE LISTENER
  useEffect(() => {
    if (!item.id) return;
    
    // Listen to this specific match document for real-time updates
    const unsub = onSnapshot(doc(firestore, 'contestMatches', item.id), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setVotesA(data.userA.votes);
        setVotesB(data.userB.votes);
        
        // If the match is completed, we could handle UI state here
      }
    }, (error) => {
      console.error("Error listening to match updates:", error);
    });

    return () => unsub();
  }, [item.id]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!item.expiresAt) return;
      const now = new Date().getTime();
      const end = item.expiresAt.toDate().getTime();
      const distance = end - now;
      if (distance < 0) { setTimeLeft('Ended'); clearInterval(timer); }
      else {
        const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((distance % (1000 * 60)) / 1000);
        timeLeft(`${hours}h ${minutes}m ${seconds}s`);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [item.expiresAt]);

  const handleVote = useCallback(async (participantUid: string, side: 'A' | 'B') => {
    if (!user || isVoting || votedFor) return;
    
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    setIsVoting(true);
    setVotedFor(participantUid);
    
    // Optimistic UI update (optional since onSnapshot will update it too)
    if (side === 'A') setVotesA(prev => prev + 1);
    else setVotesB(prev => prev + 1);

    try {
      await contestService.submitVote(item.id, participantUid, deviceId);
    } catch (error) { 
        console.error("Vote failed:", error); 
        // Logic to revert state if needed
    } finally { setIsVoting(false); }
  }, [user, isVoting, votedFor, item.id, deviceId]);

  const onDoubleTapA = useCallback(() => {
      if (votedFor) return;
      setShowHeartA(true);
      handleVote(item.userA.uid, 'A');
  }, [votedFor, handleVote, item.userA.uid]);

  const onDoubleTapB = useCallback(() => {
      if (votedFor) return;
      setShowHeartB(true);
      handleVote(item.userB.uid, 'B');
  }, [votedFor, handleVote, item.userB.uid]);

  const tapA = Gesture.Tap().numberOfTaps(2).onEnd(runOnJS(onDoubleTapA));
  const tapB = Gesture.Tap().numberOfTaps(2).onEnd(runOnJS(onDoubleTapB));

  return (
    <View style={[styles.postContainer, { borderBottomColor: borderColor }]}>
      <View style={styles.postHeader}>
        <View style={styles.userInfo}>
           <View style={styles.avatarContainer}>
              <Image source={{ uri: item.userA.profilePic || 'https://ui-avatars.com/api/?name=A' }} style={styles.avatarMain} />
              <Image source={{ uri: item.userB.profilePic || 'https://ui-avatars.com/api/?name=B' }} style={[styles.avatarSub, { borderColor: backgroundColor }]} />
           </View>
           <View style={styles.nameContainer}>
               <Text style={[styles.username, { color: textColor }]} numberOfLines={1}>
                   <Text style={{ fontFamily: 'Urbanist-Bold' }}>{item.userA.username}</Text>
                   <Text style={[styles.mentionText, { color: subTextColor }]}> VS </Text>
                   <Text style={{ fontFamily: 'Urbanist-Bold' }}>{item.userB.username}</Text>
               </Text>
               <Text style={[styles.timeText, { color: subTextColor }]}>{item.title}</Text> 
           </View>
        </View>
        <TouchableOpacity><Ionicons name="ellipsis-horizontal" size={24} color={textColor} /></TouchableOpacity>
      </View>

      <View style={styles.mediaSection}>
        <GestureDetector gesture={tapA}>
            <TouchableOpacity activeOpacity={0.9} style={[styles.imageWrapper, { backgroundColor: isDark ? '#1F222A' : '#EEE' }]} onPress={() => handleVote(item.userA.uid, 'A')}>
                {item.type === 'video' ? <VideoPostItem mediaUrl={item.userA.mediaUrl} /> : <Image source={{ uri: item.userA.mediaUrl }} style={styles.postImage} />}
                {showHeartA && <AnimatedHeart onFinish={() => setShowHeartA(false)} />}
                {votedFor === item.userA.uid && !showHeartA && <Animated.View entering={ZoomIn} style={styles.thankYouBadge}><Text style={styles.thankYouText}>Voted</Text></Animated.View>}
            </TouchableOpacity>
        </GestureDetector>

        <GestureDetector gesture={tapB}>
            <TouchableOpacity activeOpacity={0.9} style={[styles.imageWrapper, { backgroundColor: isDark ? '#1F222A' : '#EEE' }]} onPress={() => handleVote(item.userB.uid, 'B')}>
                {item.type === 'video' ? <VideoPostItem mediaUrl={item.userB.mediaUrl} /> : <Image source={{ uri: item.userB.mediaUrl }} style={styles.postImage} />}
                {showHeartB && <AnimatedHeart onFinish={() => setShowHeartB(false)} />}
                {votedFor === item.userB.uid && !showHeartB && <Animated.View entering={ZoomIn} style={styles.thankYouBadge}><Text style={styles.thankYouText}>Voted</Text></Animated.View>}
            </TouchableOpacity>
        </GestureDetector>
      </View>

      <View style={styles.votingButtonsContainer}>
          <TouchableOpacity style={[styles.voteButton, { backgroundColor: isDark ? '#1F222A' : '#F5F5F5' }, votedFor === item.userA.uid && { backgroundColor: activePink }]} onPress={() => handleVote(item.userA.uid, 'A')} disabled={!!votedFor}>
             <Text style={[styles.voteButtonText, { color: votedFor === item.userA.uid ? '#FFF' : textColor }]}>{votesA} Votes</Text>
          </TouchableOpacity>
          <View style={styles.vsCenter}><Text style={{fontFamily: 'Urbanist-Bold', color: activePink}}>VS</Text></View>
          <TouchableOpacity style={[styles.voteButton, { backgroundColor: isDark ? '#1F222A' : '#F5F5F5' }, votedFor === item.userB.uid && { backgroundColor: activePink }]} onPress={() => handleVote(item.userB.uid, 'B')} disabled={!!votedFor}>
             <Text style={[styles.voteButtonText, { color: votedFor === item.userB.uid ? '#FFF' : textColor }]}>{votesB} Votes</Text>
          </TouchableOpacity>
      </View>

      <View style={styles.actionBar}>
        <View style={styles.leftActions}>
            <TouchableOpacity style={styles.actionItem} onPress={() => setShowComments(true)}>
               <Icons.ChatIcon_Light width={26} height={26} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>Discuss</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionItem}>
               <Icons.Share_Icon width={26} height={26} color={textColor} />
            </TouchableOpacity>
        </View>
        <Text style={[styles.pollTimer, { color: subTextColor }]}>Ends in: <Text style={{ color: textColor }}>{timeLeft}</Text></Text>
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
  imageWrapper: { width: (width - 42) / 2, height: ((width - 42) / 2) * 1.3, borderRadius: 20, overflow: 'hidden', position: 'relative', justifyContent: 'center', alignItems: 'center' },
  postImage: { width: '100%', height: '100%', position: 'absolute' },
  thankYouBadge: { backgroundColor: 'rgba(0, 0, 0, 0.7)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, zIndex: 10 },
  thankYouText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 14 },
  heartOverlay: { position: 'absolute', zIndex: 20, shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 5 },
  votingButtonsContainer: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 15, alignItems: 'center' },
  voteButton: { flex: 1, paddingVertical: 10, borderRadius: 12, alignItems: 'center' },
  vsCenter: { paddingHorizontal: 15 },
  voteButtonText: { fontFamily: 'Urbanist-Bold', fontSize: 14 },
  actionBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginTop: 15 },
  leftActions: { flexDirection: 'row', alignItems: 'center' },
  actionItem: { flexDirection: 'row', alignItems: 'center', marginRight: 20 },
  actionCount: { fontFamily: 'Urbanist-Bold', fontSize: 13, marginLeft: 8 },
  pollTimer: { fontFamily: 'Urbanist-Medium', fontSize: 12 }
});
