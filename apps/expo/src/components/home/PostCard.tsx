
import React, { useState, memo, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Dimensions, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CommentSheet } from '../comments/CommentSheet';
import { useAuth } from '@/src/hooks/useAuth';
import { contestService } from '@/src/services/contests/contestService';
import { firestore } from '@/src/services/firebase/initFirebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { Colors } from '@/constants/theme';
import { LinearGradient } from 'expo-linear-gradient';

const { width } = Dimensions.get('window');

interface PostCardProps {
    item: any;
    isDark: boolean;
}

export const PostCard = memo(({ item, isDark }: PostCardProps) => {
  const { user } = useAuth();
  const [showComments, setShowComments] = useState(false);
  
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  const cardColor = isDark ? '#1A1D23' : '#FFFFFF';

  // State for individual user votes
  const [votesA, setVotesA] = useState(item.userA.votes);
  const [votesB, setVotesB] = useState(item.userB.votes);
  
  // State for shared engagement counts from the parent contest
  const [likeCount, setLikeCount] = useState(item.likes || 0);
  const [commentCount, setCommentCount] = useState(item.comments || 0);
  const [shareCount, setShareCount] = useState(item.shares || 0);

  const [totalVotes, setTotalVotes] = useState(0);
  const [progressA, setProgressA] = useState(0);

  // Listener for real-time vote updates on the MATCH
  useEffect(() => {
    if (!item.id) return;
    const unsub = onSnapshot(doc(firestore, 'contestMatches', item.id), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setVotesA(data.userA.votes);
        setVotesB(data.userB.votes);
      }
    });
    return () => unsub();
  }, [item.id]);
  
  // Listener for real-time shared engagement updates on the CONTEST
  useEffect(() => {
    if (!item.contestId) return;
    const unsub = onSnapshot(doc(firestore, 'contests', item.contestId), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setLikeCount(data.likeCount || 0);
        setCommentCount(data.commentCount || 0);
        setShareCount(data.shareCount || 0);
      }
    });
    return () => unsub();
  }, [item.contestId]);


  useEffect(() => {
    const total = votesA + votesB;
    setTotalVotes(total);
    if (total > 0) {
      setProgressA((votesA / total));
    } else {
      setProgressA(0.5); // Default to 50/50 if no votes
    }
  }, [votesA, votesB]);
  
  // --- Individual VOTE action ---
  const handleVote = async (votedForUid: string) => {
    if (!user) return Alert.alert("Please login to vote.");
    try {
      // This remains the same, it targets the specific match
      await contestService.voteOnMatch(item.id, votedForUid, user.uid);
    } catch (error) {
      console.error("Error voting:", error);
      Alert.alert("Error", "Could not submit your vote.");
    }
  };
  
  // --- Shared LIKE action ---
  const handleLike = async () => {
    if (!user) return Alert.alert("Please login to like.");
    try {
      // Calls the new function using the parent contestId
      await contestService.likeContest(item.contestId);
    } catch (error) {
       console.error("Error liking:", error);
       Alert.alert("Error", "Could not like the contest.");
    }
  };

  // --- Shared SHARE action ---
  const handleShare = async () => {
    if (!user) return Alert.alert("Please login to share.");
     try {
      // Calls the new function using the parent contestId
      await contestService.shareContest(item.contestId);
    } catch (error) {
       console.error("Error sharing:", error);
       Alert.alert("Error", "Could not share the contest.");
    }
  };

  const getTimeRemaining = useCallback(() => {
    if (!item.contestEndDate || !(item.contestEndDate instanceof Date)) return 'Calculating...';
    const now = new Date();
    const endDate = item.contestEndDate;
    const diff = endDate.getTime() - now.getTime();
    if (diff <= 0) return 'Poll ended';
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }, [item.contestEndDate]);

  const [timeRemaining, setTimeRemaining] = useState(getTimeRemaining());

  useEffect(() => {
    const timer = setInterval(() => setTimeRemaining(getTimeRemaining()), 1000);
    return () => clearInterval(timer);
  }, [getTimeRemaining]);


  return (
    <View style={[styles.postContainer, { backgroundColor: cardColor }]}>
      <View style={styles.postHeader}>
        <View style={styles.userInfo}>
           <View style={styles.avatarContainer}>
              <Image source={{ uri: item.userA.profilePic || 'https://ui-avatars.com/api/?name=A' }} style={styles.avatarMain} />
              <Image source={{ uri: item.userB.profilePic || 'https://ui-avatars.com/api/?name=B' }} style={[styles.avatarSub, { borderColor: cardColor }]} />
           </View>
           <View style={styles.nameContainer}>
               <Text style={[styles.username, { color: textColor }]} numberOfLines={1}>
                   <Text style={{ fontFamily: 'Urbanist-Bold' }}>{item.userA.username}</Text>
                   <Text> vs </Text>
                   <Text style={{ fontFamily: 'Urbanist-Bold' }}>{item.userB.username}</Text>
               </Text>
               <Text style={[styles.timeText, { color: subTextColor }]}>{item.title || "Photo Contest"}</Text> 
           </View>
        </View>
      </View>

      <View style={styles.mediaSection}>
        <Image source={{ uri: item.userA.mediaUrl }} style={styles.postImage} />
        <Image source={{ uri: item.userB.mediaUrl }} style={styles.postImage} />
      </View>
      
      <View style={styles.voteSection}>
        <Text style={[styles.participantName, {color: textColor}]}>{item.userA.caption}</Text>
        <Text style={[styles.participantName, {color: textColor}]}>{item.userB.caption}</Text>
      </View>

      <View style={styles.voteButtonSection}>
        <TouchableOpacity style={styles.voteButton} onPress={() => handleVote(item.userA.uid)}>
            <Text style={styles.voteButtonText}>Vote</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.voteButton} onPress={() => handleVote(item.userB.uid)}>
            <Text style={styles.voteButtonText}>Vote</Text>
        </TouchableOpacity>
      </View>
      
      <View style={styles.voteCountSection}>
        <Text style={[styles.voteCount, { color: subTextColor }]}>{votesA} votes</Text>
        <Text style={[styles.voteCount, { color: subTextColor }]}>{votesB} votes</Text>
      </View>

      <View style={styles.pollInfoSection}>
        <Text style={[styles.currentSplit, { color: subTextColor }]}>
            Current Split: <Text style={{color: textColor, fontFamily: 'Urbanist-Bold'}}>{(progressA * 100).toFixed(0)}% vs {(100 - progressA * 100).toFixed(0)}%</Text>
        </Text>
        <View style={styles.progressBarContainer}>
            <LinearGradient
                colors={['#FF4D7E', '#FFC54D']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[styles.progressBar, { width: `${progressA * 100}%` }]}
            />
        </View>
        <Text style={[styles.pollEnds, { color: subTextColor }]}>Poll ends in: {timeRemaining}</Text>
      </View>

      {/* --- ACTION BAR NOW USES NEW LOGIC --- */}
      <View style={styles.actionBar}>
        <View style={styles.leftActions}>
            <TouchableOpacity style={styles.actionItem} onPress={handleLike}>
               <Ionicons name="heart-outline" size={28} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>{likeCount}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionItem} onPress={() => setShowComments(true)}>
               <Ionicons name="chatbubble-outline" size={26} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>{commentCount}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionItem} onPress={handleShare}>
               <Ionicons name="paper-plane-outline" size={26} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>{shareCount}</Text>
            </TouchableOpacity>
        </View>
        <TouchableOpacity>
            <Ionicons name="bookmark-outline" size={26} color={textColor} />
        </TouchableOpacity>
      </View>
      
      {/* Comment sheet now needs contestId for shared comments */}
      <CommentSheet 
        postId={item.contestId} 
        visible={showComments} 
        onDismiss={() => setShowComments(false)} 
        isDark={isDark} 
        isContestMatch={true} 
      />
    </View>
  );
});

const styles = StyleSheet.create({
  postContainer: { 
    borderRadius: 24, 
    marginHorizontal: 8,
    marginBottom: 20,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    paddingBottom: 10
  },
  postHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12 },
  userInfo: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  avatarContainer: { flexDirection: 'row', alignItems: 'center' },
  avatarMain: { width: 40, height: 40, borderRadius: 20, zIndex: 1 },
  avatarSub: { width: 40, height: 40, borderRadius: 20, marginLeft: -15, borderWidth: 2, zIndex: 0 },
  nameContainer: { marginLeft: 10, flex: 1 },
  username: { fontSize: 16, fontFamily: 'Urbanist-Regular' },
  timeText: { fontFamily: 'Urbanist-Medium', fontSize: 12, marginTop: 1, color: '#9E9E9E' },
  
  mediaSection: { 
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginHorizontal: 16,
    gap: 10
  },
  postImage: { 
    width: (width - 42) / 2, // container marginHorizontal is 16*2 + gap 10
    height: 250,
    borderRadius: 20,
  },

  voteSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 26,
    marginTop: 15,
  },
  participantName: {
    fontFamily: 'Urbanist-Medium',
    fontSize: 12,
    textAlign: 'center',
    width: (width - 42) / 2,
  },
  voteButtonSection: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 16,
    marginTop: 10,
  },
  voteButton: {
    backgroundColor: '#FF4D67',
    paddingVertical: 12,
    paddingHorizontal: 40,
    borderRadius: 30,
  },
  voteButtonText: {
    fontFamily: 'Urbanist-Bold',
    fontSize: 14,
    color: '#FFF'
  },
  voteCountSection: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 16,
    marginTop: 8,
  },
  voteCount: {
    fontFamily: 'Urbanist-Medium',
    fontSize: 12,
  },
  pollInfoSection: {
    paddingHorizontal: 16,
    marginTop: 20,
    alignItems: 'center'
  },
  currentSplit: {
    fontFamily: 'Urbanist-Medium',
    fontSize: 14,
    marginBottom: 8,
  },
  progressBarContainer: {
    width: '100%',
    height: 8,
    backgroundColor: '#E0E0E0',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressBar: {
    height: '100%',
    borderRadius: 4,
  },
  pollEnds: {
    fontFamily: 'Urbanist-Medium',
    fontSize: 12,
  },
  
  actionBar: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingHorizontal: 16, 
    paddingTop: 20,
    paddingBottom: 10
  },
  leftActions: { flexDirection: 'row', alignItems: 'center' },
  actionItem: { flexDirection: 'row', alignItems: 'center', marginRight: 20 },
  actionCount: { fontFamily: 'Urbanist-Bold', fontSize: 13, marginLeft: 8 },
});
