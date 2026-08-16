import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { Portal } from 'react-native-paper';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
} from 'react-native-reanimated';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import * as Icons from '@/assets/svgs';
import { CommentSkeleton } from './CommentSkeleton';
import { commentService, Comment } from '@/src/services/comments/commentService';
import { useAuth } from '@/src/hooks/useAuth';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.75;

interface CommentSheetProps {
  postId: string;
  visible: boolean;
  onDismiss: () => void;
  isDark: boolean;
  isContestMatch?: boolean;
}

export const CommentSheet = ({ postId, visible, onDismiss, isDark, isContestMatch = false }: CommentSheetProps) => {
  const { user } = useAuth();
  const router = useRouter();
  const translateY = useSharedValue(SHEET_HEIGHT);
  const opacity = useSharedValue(0);
  const [shouldRender, setShouldRender] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isPosting, setIsPosting] = useState(false);

  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  
  const inputDefaultBg = isDark ? Colors.dark.background : Colors.light.background;
  const inputFocusedBg = isDark ? '#35383F' : '#FFEBEE';
  const inputBorderDefault = isDark ? '#35383F' : '#EEEEEE';
  const inputBorderFocused = '#FF4D67';

  const HeartIcon = isDark ? Icons.HeartIcon_Dark : Icons.HeartIcon_Light;

  useEffect(() => {
    if (visible && postId) {
      setShouldRender(true);
      translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      opacity.value = withTiming(1, { duration: 300 });
      
      setIsLoading(true);
      const collectionName = isContestMatch ? 'contestMatches' : 'posts';
      const unsubscribe = commentService.subscribeToComments(postId, (data) => {
          setComments(data);
          setIsLoading(false);
      }, collectionName);
      return () => unsubscribe();
    } else {
      translateY.value = withSpring(SHEET_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
          if (finished) {
              runOnJS(setShouldRender)(false);
          }
      });
      opacity.value = withTiming(0, { duration: 300 });
    }
  }, [visible, postId, isContestMatch]);

  const closeSheet = useCallback(() => {
    translateY.value = withSpring(SHEET_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
      if (finished) {
        runOnJS(onDismiss)();
        runOnJS(setShouldRender)(false);
      }
    });
    opacity.value = withTiming(0, { duration: 300 });
  }, [onDismiss]);

  const handlePostComment = async () => {
    if (!commentText.trim() || !user || !postId || isPosting) return;
    
    const text = commentText.trim();
    setCommentText('');
    setIsPosting(true);
    const collectionName = isContestMatch ? 'contestMatches' : 'posts';
    
    try {
        await commentService.addComment(
            postId,
            user.uid,
            user.displayName || 'User',
            user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName || 'U'}`,
            text,
            collectionName
        );
    } catch (e) {
        console.error("Error posting comment:", e);
    } finally {
        setIsPosting(false);
    }
  };

  // Open a commenter's profile — dismiss the sheet first so it doesn't stay
  // stacked over the profile screen.
  const openProfile = useCallback((userId?: string) => {
    if (!userId) return;
    closeSheet();
    router.push(`/profile?userId=${userId}`);
  }, [router, closeSheet]);

  // Toggle a like on a comment with an optimistic update + server reconcile.
  const handleLikeComment = useCallback(async (comment: Comment) => {
    if (!user) return;
    const collectionName = isContestMatch ? 'contestMatches' : 'posts';
    const next = !comment.likedByMe;
    setComments((prev) => prev.map((c) => (
      c.id === comment.id
        ? { ...c, likedByMe: next, likes: Math.max(0, (c.likes || 0) + (next ? 1 : -1)) }
        : c
    )));
    try {
      const res = await commentService.likeComment(comment.id, collectionName);
      setComments((prev) => prev.map((c) => (
        c.id === comment.id ? { ...c, likedByMe: res.liked, likes: res.likeCount } : c
      )));
    } catch {
      // Revert to the pre-tap snapshot on failure.
      setComments((prev) => prev.map((c) => (
        c.id === comment.id ? { ...c, likedByMe: comment.likedByMe, likes: comment.likes } : c
      )));
    }
  }, [user, isContestMatch]);

  const gesture = Gesture.Pan()
    .onUpdate((event) => {
      'worklet';
      if (event.translationY > 0) {
        translateY.value = event.translationY;
      }
    })
    .onEnd((event) => {
      'worklet';
      if (event.translationY > 150 || event.velocityY > 500) {
        runOnJS(closeSheet)();
      } else {
        translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, SHEET_HEIGHT], [0.5, 0], Extrapolation.CLAMP),
  }));

  // Instagram-style compact relative time: now, 5s, 8m, 3h, 2d, 4w, 1y.
  const formatTime = (timestamp: any) => {
      if (!timestamp) return 'now';
      const date = timestamp?.toDate ? timestamp.toDate() : new Date(timestamp);
      const ms = date.getTime();
      if (!Number.isFinite(ms)) return 'now';
      const secs = Math.floor((Date.now() - ms) / 1000);
      if (secs < 5) return 'now';
      if (secs < 60) return `${secs}s`;
      const mins = Math.floor(secs / 60);
      if (mins < 60) return `${mins}m`;
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return `${hrs}h`;
      const days = Math.floor(hrs / 24);
      if (days < 7) return `${days}d`;
      const weeks = Math.floor(days / 7);
      if (weeks < 52) return `${weeks}w`;
      return `${Math.floor(days / 365)}y`;
  };

  if (!shouldRender && !visible) return null;

  const renderComment = ({ item }: { item: Comment }) => {
    const liked = !!item.likedByMe;
    const CommentHeart = liked ? Icons.HeartIcon_Filled : HeartIcon;
    return (
      <View style={styles.commentItem}>
        <TouchableOpacity activeOpacity={0.8} onPress={() => openProfile(item.userId)}>
          <Image source={{ uri: item.userAvatar }} style={styles.commentAvatar} />
        </TouchableOpacity>
        <View style={styles.commentContent}>
          <View style={styles.commentHeader}>
            <Text style={[styles.commentUser, { color: textColor }]}>
              <Text onPress={() => openProfile(item.userId)}>{item.username}</Text>
              {'  '}
              <Text style={[styles.commentTime, { color: subTextColor }]}>{formatTime(item.createdAt)}</Text>
            </Text>
          </View>
          <Text style={[styles.commentText, { color: textColor }]}>{item.text}</Text>
          <View style={styles.commentFooter}>
            <TouchableOpacity>
              <Text style={[styles.replyText, { color: subTextColor }]}>Reply</Text>
            </TouchableOpacity>
          </View>
        </View>
        <TouchableOpacity
          style={styles.heartButton}
          onPress={() => handleLikeComment(item)}
          accessibilityRole="button"
          accessibilityLabel={liked ? `Unlike comment by ${item.username}` : `Like comment by ${item.username}`}
        >
          <CommentHeart width={18} height={18} color={liked ? '#FF4D67' : subTextColor} />
          {(item.likes || 0) > 0 && (
            <Text style={[styles.commentLikes, { color: liked ? '#FF4D67' : subTextColor }]}>{item.likes}</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <Portal>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
        </Animated.View>

        <GestureDetector gesture={gesture}>
          <Animated.View style={[styles.sheetContainer, animatedStyle, { backgroundColor }]}>
            <View style={styles.header}>
              <View style={[styles.handle, { backgroundColor: isDark ? '#35383F' : '#E0E0E0' }]} />
              <Text style={[styles.headerTitle, { color: textColor }]}>Comments</Text>
              <View style={[styles.divider, { backgroundColor: isDark ? '#35383F' : '#EEEEEE' }]} />
            </View>

            {isLoading ? (
               <View style={{ marginTop: 10 }}>
                  {[1, 2, 3, 4].map(i => <CommentSkeleton key={i} isDark={isDark} />)}
               </View>
            ) : (
                <FlatList
                    data={comments}
                    renderItem={renderComment}
                    keyExtractor={(item) => item.id}
                    contentContainerStyle={styles.listContent}
                    showsVerticalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    ListEmptyComponent={
                        <View style={{ alignItems: 'center', marginTop: 50 }}>
                            <Text style={{ color: subTextColor, fontFamily: 'Urbanist-Medium' }}>No comments yet. Be the first!</Text>
                        </View>
                    }
                />
            )}

            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
            >
              <View style={[styles.inputArea, { backgroundColor, borderTopColor: isDark ? '#35383F' : '#EEEEEE' }]}>
                <Image source={{ uri: user?.photoURL || 'https://ui-avatars.com/api/?name=' + (user?.displayName || 'Me') }} style={styles.myAvatar} />
                
                <View style={[
                  styles.inputBoxWrapper, 
                  { 
                    backgroundColor: isInputFocused ? inputFocusedBg : inputDefaultBg,
                    borderColor: isInputFocused ? inputBorderFocused : inputBorderDefault,
                  }
                ]}>
                  <TextInput
                    placeholder="Add a comment..."
                    placeholderTextColor={subTextColor}
                    style={[
                      styles.input, 
                      { color: textColor },
                      Platform.OS === 'web' && { outlineStyle: 'none' } as any
                    ]}
                    onFocus={() => setIsInputFocused(true)}
                    onBlur={() => setIsInputFocused(false)}
                    onChangeText={setCommentText}
                    value={commentText}
                    multiline
                  />
                </View>

                <TouchableOpacity 
                    style={[styles.sendButton, { opacity: (commentText.trim().length > 0 && !isPosting) ? 1 : 0.5 }]} 
                    disabled={commentText.trim().length === 0 || isPosting}
                    onPress={handlePostComment}
                >
                  {isPosting ? <ActivityIndicator size="small" color="#FF4D67" /> : <Icons.Send_Icon width={28} height={28} color="#FF4D67" />}
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Portal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
  },
  sheetContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: SHEET_HEIGHT,
    borderTopLeftRadius: 25,
    borderTopRightRadius: 25,
    elevation: 5,
  },
  header: {
    alignItems: 'center',
    paddingTop: 12,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 16,
  },
  headerTitle: {
    fontFamily: 'Urbanist-Bold',
    fontSize: 16,
    marginBottom: 12,
  },
  divider: {
    height: 1,
    width: '100%',
  },
  listContent: {
    padding: 16,
    paddingBottom: 20,
  },
  commentItem: {
    flexDirection: 'row',
    marginBottom: 20,
  },
  commentAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginRight: 12,
  },
  commentContent: {
    flex: 1,
  },
  commentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  commentUser: {
    fontFamily: 'Urbanist-Bold',
    fontSize: 13,
  },
  commentTime: {
    fontFamily: 'Urbanist-Regular',
    fontSize: 12,
    marginLeft: 4,
  },
  commentText: {
    fontFamily: 'Urbanist-Regular',
    fontSize: 14,
    lineHeight: 18,
  },
  commentFooter: {
    marginTop: 4,
  },
  replyText: {
    fontFamily: 'Urbanist-Bold',
    fontSize: 12,
  },
  heartButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 10,
    minWidth: 40,
  },
  commentLikes: {
    fontSize: 11,
    fontFamily: 'Urbanist-Medium',
    marginTop: 2,
  },
  inputArea: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    paddingBottom: Platform.OS === 'ios' ? 34 : 12,
  },
  myAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginRight: 12,
  },
  inputBoxWrapper: {
    flex: 1,
    height: 56,
    borderRadius: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    fontFamily: 'Urbanist-Medium',
    fontSize: 15,
    paddingVertical: 8,
  },
  sendButton: {
    marginLeft: 12,
    width: 44,
    height: 44,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
