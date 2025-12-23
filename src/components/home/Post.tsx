import React, { useState, memo } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Icons from '@/assets/svgs';
import { CommentSheet } from '../comments/CommentSheet';
import { ShareSheet } from '../share/ShareSheet';
import Animated, { 
  ZoomIn, 
  FadeOut,
  Layout, 
} from 'react-native-reanimated';

const { width } = Dimensions.get('window');

interface PostProps {
    item: {
        id: string;
        user: {
            name: string;
            avatar: any;
        };
        time: string;
        name1: string;
        avatar1: any;
        name2: string;
        avatar2: any;
        image1: any;
        image2: any;
        votes1: number;
        votes2: number;
        pollEndsAt: string;
        likesCount: number;
        commentsCount: number;
        sharesCount: number;
        isLiked: boolean;
        isSaved: boolean;
    };
    isDark: boolean;
}

export const Post = memo(({ item, isDark }: PostProps) => {
  const [showComments, setShowComments] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [votedFor, setVotedFor] = useState<number | null>(null);
  const [isLiked, setIsLiked] = useState(item.isLiked);
  const [isSaved, setIsSaved] = useState(item.isSaved);
  const [localLikesCount, setLocalLikesCount] = useState(item.likesCount);
  
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  const borderColor = isDark ? '#35383F' : '#EEEEEE';
  const activePink = '#FF4D67';
  
  const currentVotes1 = votedFor === 1 ? item.votes1 + 1 : item.votes1;
  const currentVotes2 = votedFor === 2 ? item.votes2 + 1 : item.votes2;

  const totalVotes = currentVotes1 + currentVotes2;
  const percent1 = totalVotes > 0 ? Math.round((currentVotes1 / totalVotes) * 100) : 50;
  const percent2 = 100 - percent1;

  const HeartOutlineIcon = isDark ? Icons.HeartIcon_Dark : Icons.HeartIcon_Light;
  const HeartFilledIcon = Icons.HeartIcon_Filled;
  const ChatIcon = isDark ? Icons.ChatIcon_Dark : Icons.ChatIcon_Light;

  const handleVote = (index: number) => {
      setVotedFor(votedFor === index ? null : index);
  };

  const handleLike = () => {
    setIsLiked(!isLiked);
    setLocalLikesCount(prev => isLiked ? prev - 1 : prev + 1);
  };

  const handleSave = () => {
    setIsSaved(!isSaved);
  };

  return (
    <View style={[styles.postContainer, { borderBottomColor: borderColor }]}>
      {/* Header */}
      <View style={styles.postHeader}>
        <View style={styles.userInfo}>
           <View style={styles.avatarContainer}>
              <Image source={{ uri: item.avatar1 }} style={styles.avatarMain} />
              <Image source={{ uri: item.avatar2 }} style={[styles.avatarSub, { borderColor: isDark ? '#181A20' : '#fff' }]} />
           </View>
           
           <View style={styles.nameContainer}>
               <Text style={[styles.username, { color: textColor }]} numberOfLines={1}>
                   <Text style={{ fontFamily: 'Urbanist-Bold' }}>{item.name1}</Text>
                   <Text style={[styles.mentionText, { color: subTextColor }]}> & </Text>
                   <Text style={{ fontFamily: 'Urbanist-Bold' }}>{item.name2}</Text>
               </Text>
               <Text style={[styles.timeText, { color: subTextColor }]}>{item.time}</Text> 
           </View>
        </View>
        <TouchableOpacity style={styles.moreBtn}>
           <Ionicons name="ellipsis-horizontal" size={24} color={textColor} />
        </TouchableOpacity>
      </View>

      {/* Media Section */}
      <View style={styles.mediaSection}>
        <TouchableOpacity activeOpacity={0.9} style={styles.imageWrapper} onPress={() => handleVote(1)}>
            <Image source={typeof item.image1 === 'string' ? { uri: item.image1 } : item.image1} style={styles.postImage} resizeMode="cover" />
            {votedFor === 1 && (
                <Animated.View entering={ZoomIn.duration(400)} exiting={FadeOut.duration(200)} style={styles.thankYouBadge}>
                    <Text style={styles.thankYouText}>Thank you!</Text>
                </Animated.View>
            )}
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.9} style={styles.imageWrapper} onPress={() => handleVote(2)}>
            <Image source={typeof item.image2 === 'string' ? { uri: item.image2 } : item.image2} style={styles.postImage} resizeMode="cover" />
            {votedFor === 2 && (
                <Animated.View entering={ZoomIn.duration(400)} exiting={FadeOut.duration(200)} style={styles.thankYouBadge}>
                    <Text style={styles.thankYouText}>Thank you!</Text>
                </Animated.View>
            )}
        </TouchableOpacity>
      </View>

      {/* Voting Labels */}
      <View style={styles.votingLabels}>
          <Text style={[styles.imageLabel, { color: textColor }]}>{item.name1.toUpperCase()}</Text>
          <Text style={[styles.imageLabel, { color: textColor }]}>{item.name2.toUpperCase()}</Text>
      </View>

      {/* Voting Buttons */}
      <View style={styles.votingButtonsContainer}>
          <View style={styles.voteColumn}>
            <TouchableOpacity 
                style={[styles.voteButton, { backgroundColor: isDark ? '#1F222A' : '#F5F5F5' }, votedFor === 1 && { backgroundColor: activePink }]}
                onPress={() => handleVote(1)}
            >
                <View style={[styles.upArrowCircle, votedFor === 1 && { backgroundColor: '#FFF' }]}>
                    <Icons.Upvote_Icon width={16} height={16} color={votedFor === 1 ? activePink : '#212121'} />
                </View>
                <Text style={[styles.voteButtonText, { color: votedFor === 1 ? '#FFF' : textColor }]}>
                    {votedFor === 1 ? 'Voted' : `Vote for ${item.name1.split(' ')[0]}`}
                </Text>
            </TouchableOpacity>
            <Text style={[styles.voteCount, { color: subTextColor }]}>{currentVotes1.toLocaleString()} votes</Text>
          </View>

          <View style={styles.voteColumn}>
            <TouchableOpacity 
                style={[styles.voteButton, { backgroundColor: isDark ? '#1F222A' : '#F5F5F5' }, votedFor === 2 && { backgroundColor: activePink }]}
                onPress={() => handleVote(2)}
            >
                <View style={[styles.upArrowCircle, votedFor === 2 && { backgroundColor: '#FFF' }]}>
                    <Icons.Upvote_Icon width={16} height={16} color={votedFor === 2 ? activePink : '#212121'} />
                </View>
                <Text style={[styles.voteButtonText, { color: votedFor === 2 ? '#FFF' : textColor }]}>
                    {votedFor === 2 ? 'Voted' : `Vote for ${item.name2.split(' ')[0]}`}
                </Text>
            </TouchableOpacity>
            <Text style={[styles.voteCount, { color: subTextColor }]}>{currentVotes2.toLocaleString()} votes</Text>
          </View>
      </View>

      {/* Split Display */}
      <View style={styles.splitInfo}>
          <Text style={[styles.splitText, { color: textColor }]}>
            Current Split: <Text style={{ fontFamily: 'Urbanist-Bold' }}>{percent1}% vs {percent2}%</Text>
          </Text>
          <View style={[styles.progressBarContainer, { backgroundColor: isDark ? '#35383F' : '#EEEEEE' }]}>
              <Animated.View style={[styles.progressBar, { width: `${percent1}%`, backgroundColor: activePink }]} layout={Layout.springify().duration(500)} />
          </View>
          <Text style={[styles.pollTimer, { color: subTextColor }]}>Poll ends in: <Text style={{ color: textColor }}>{item.pollEndsAt}</Text></Text>
      </View>

      {/* Action Bar */}
      <View style={styles.actionBar}>
        <View style={styles.leftActions}>
            <TouchableOpacity style={styles.actionItem} onPress={handleLike}>
               {isLiked ? <HeartFilledIcon width={28} height={28} color={activePink} /> : <HeartOutlineIcon width={28} height={28} color={textColor} />}
               <Text style={[styles.actionCount, { color: textColor }]}>{localLikesCount.toLocaleString()}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionItem} onPress={() => setShowComments(true)}>
               <ChatIcon width={28} height={28} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>{item.commentsCount.toLocaleString()}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionItem} onPress={() => setShowShare(true)}>
               <Icons.Share_Icon width={28} height={28} color={textColor} />
               <Text style={[styles.actionCount, { color: textColor }]}>{item.sharesCount.toLocaleString()}</Text>
            </TouchableOpacity>
        </View>
        <TouchableOpacity style={styles.moreBtn} onPress={handleSave}>
            {isSaved ? <Icons.Bookmark_Filled width={28} height={28} color={textColor} /> : <Icons.Bookmark_Outline width={28} height={28} color={textColor} />}
        </TouchableOpacity>
      </View>

      <CommentSheet visible={showComments} onDismiss={() => setShowComments(false)} isDark={isDark} />
      <ShareSheet visible={showShare} onDismiss={() => setShowShare(false)} isDark={isDark} />
    </View>
  );
}, (prevProps, nextProps) => {
    return prevProps.item.id === nextProps.item.id && 
           prevProps.isDark === nextProps.isDark &&
           prevProps.item.isLiked === nextProps.item.isLiked &&
           prevProps.item.isSaved === nextProps.item.isSaved &&
           prevProps.item.likesCount === nextProps.item.likesCount &&
           prevProps.item.commentsCount === nextProps.item.commentsCount &&
           prevProps.item.votes1 === nextProps.item.votes1 &&
           prevProps.item.votes2 === nextProps.item.votes2;
});

const styles = StyleSheet.create({
  postContainer: { marginBottom: 20, paddingBottom: 15, borderBottomWidth: 1 },
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
  thankYouBadge: { backgroundColor: 'rgba(0, 0, 0, 0.7)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.4)', zIndex: 10 },
  thankYouText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 14 },
  votingLabels: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 10 },
  imageLabel: { fontFamily: 'Urbanist-Bold', fontSize: 14, letterSpacing: 0.5 },
  votingButtonsContainer: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 15 },
  voteColumn: { alignItems: 'center', width: (width - 42) / 2 },
  voteButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 15, borderRadius: 100, width: '100%', justifyContent: 'center' },
  upArrowCircle: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#E0E0E0', justifyContent: 'center', alignItems: 'center', marginRight: 8 },
  voteButtonText: { fontFamily: 'Urbanist-Bold', fontSize: 13 },
  voteCount: { fontFamily: 'Urbanist-Medium', fontSize: 12, marginTop: 6 },
  splitInfo: { alignItems: 'center', marginTop: 20, paddingHorizontal: 16 },
  splitText: { fontFamily: 'Urbanist-Medium', fontSize: 14, marginBottom: 10 },
  progressBarContainer: { height: 6, width: '100%', borderRadius: 3, overflow: 'hidden', marginBottom: 10 },
  progressBar: { height: '100%' },
  pollTimer: { fontFamily: 'Urbanist-Medium', fontSize: 13 },
  actionBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, marginTop: 20 },
  leftActions: { flexDirection: 'row', alignItems: 'center' },
  actionItem: { flexDirection: 'row', alignItems: 'center', marginRight: 15 },
  actionCount: { fontFamily: 'Urbanist-Bold', fontSize: 14, marginLeft: 6 },
  moreBtn: { padding: 4 }
});
