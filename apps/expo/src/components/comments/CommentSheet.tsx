import React, { useEffect, useState, useCallback, useRef } from 'react';
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
} from "react-native";
import { Alert } from '@/src/lib/appAlert';
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
import { mergeComments } from '@/src/services/comments/commentUtils';
import { useAuth } from '@/src/hooks/useAuth';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { Avatar } from '@/src/components/ui/Avatar';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.75;
const PAGE_SIZE = 20;
const MAX_COMMENT_LEN = 500;

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
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPosting, setIsPosting] = useState(false);

  const inputRef = useRef<TextInput>(null);
  const collectionName = isContestMatch ? 'contestMatches' : 'posts';

  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const subTextColor = isDark ? '#BDBDBD' : '#616161';

  const inputDefaultBg = isDark ? Colors.dark.background : Colors.light.background;
  const inputFocusedBg = isDark ? '#35383F' : '#FFEBEE';
  const inputBorderDefault = isDark ? '#35383F' : '#EEEEEE';
  const inputBorderFocused = '#FF4D67';

  const HeartIcon = isDark ? Icons.HeartIcon_Dark : Icons.HeartIcon_Light;

  // --- data loading --------------------------------------------------------
  const loadFirstPage = useCallback(async (showSpinner = true) => {
    if (!postId) return;
    if (showSpinner) setIsLoading(true);
    try {
      const page = await commentService.getComments(postId, collectionName, null, PAGE_SIZE);
      setComments(page.items);
      setNextCursor(page.nextCursor);
      setLoadError(null);
    } catch (e: any) {
      setLoadError(e?.message || 'Comments load nahi ho sake.');
    } finally {
      setIsLoading(false);
    }
  }, [postId, collectionName]);

  // Re-fetch just the newest page and merge (used on realtime bumps / after post).
  const refreshFirstPage = useCallback(async () => {
    if (!postId) return;
    try {
      const page = await commentService.getComments(postId, collectionName, null, PAGE_SIZE);
      setComments((prev) => mergeComments(prev, page.items));
    } catch {
      /* transient — keep what we have */
    }
  }, [postId, collectionName]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const page = await commentService.getComments(postId, collectionName, nextCursor, PAGE_SIZE);
      setComments((prev) => mergeComments(prev, page.items));
      setNextCursor(page.nextCursor);
    } catch {
      /* keep current cursor so the user can retry by scrolling */
    } finally {
      setIsLoadingMore(false);
    }
  }, [nextCursor, isLoadingMore, postId, collectionName]);

  useEffect(() => {
    if (visible && postId) {
      setShouldRender(true);
      translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      opacity.value = withTiming(1, { duration: 300 });

      setComments([]);
      setNextCursor(null);
      loadFirstPage(true);
      // Live: refresh the newest page whenever a new comment is pushed.
      const unsub = commentService.onCommentEvent(postId, collectionName, refreshFirstPage);
      return () => unsub();
    } else {
      translateY.value = withSpring(SHEET_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
        if (finished) runOnJS(setShouldRender)(false);
      });
      opacity.value = withTiming(0, { duration: 300 });
    }
  }, [visible, postId, collectionName, loadFirstPage, refreshFirstPage]);

  const closeSheet = useCallback(() => {
    translateY.value = withSpring(SHEET_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
      if (finished) {
        runOnJS(onDismiss)();
        runOnJS(setShouldRender)(false);
      }
    });
    opacity.value = withTiming(0, { duration: 300 });
  }, [onDismiss]);

  // --- actions -------------------------------------------------------------
  const openProfile = useCallback((userId?: string) => {
    if (!userId) return;
    closeSheet();
    router.push(`/profile?userId=${userId}`);
  }, [router, closeSheet]);

  const handlePostComment = async () => {
    const text = commentText.trim();
    if (!text || !user || !postId || isPosting) return;
    if (text.length > MAX_COMMENT_LEN) {
      Alert.alert('Too long', `Comment ${MAX_COMMENT_LEN} characters se chhota rakhein.`);
      return;
    }

    const clientId = commentService.clientToken();
    // Optimistic insert at the top; reconciled when the server echo arrives.
    const optimistic: Comment = {
      id: clientId,
      postId,
      userId: user.uid,
      username: user.displayName || 'You',
      // No remote placeholder: null means "render initials locally".
      userAvatar: user.photoURL || null,
      text,
      createdAt: Date.now(),
      likes: 0,
      likedByMe: false,
      pending: true,
    };
    setComments((prev) => [optimistic, ...prev]);
    setCommentText('');
    setIsPosting(true);
    try {
      await commentService.addComment(postId, text, collectionName, clientId);
      // The realtime bump (refreshFirstPage) reconciles the confirmed row.
      refreshFirstPage();
    } catch (e: any) {
      // Roll back the optimistic comment and restore the draft.
      setComments((prev) => prev.filter((c) => c.id !== clientId));
      setCommentText(text);
      Alert.alert('Could not post', e?.message || 'Please try again.');
    } finally {
      setIsPosting(false);
    }
  };

  const handleLikeComment = useCallback(async (comment: Comment) => {
    if (!user || comment.pending) return;
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
      setComments((prev) => prev.map((c) => (
        c.id === comment.id ? { ...c, likedByMe: comment.likedByMe, likes: comment.likes } : c
      )));
    }
  }, [user, collectionName]);

  const handleReply = useCallback((comment: Comment) => {
    setCommentText((prev) => {
      const mention = `@${comment.username} `;
      return prev.includes(mention) ? prev : `${mention}${prev}`;
    });
    inputRef.current?.focus();
  }, []);

  // Long-press: delete your own comment, or report someone else's.
  const handleLongPress = useCallback((comment: Comment) => {
    if (!user || comment.pending) return;
    if (comment.userId === user.uid) {
      Alert.alert('Delete comment?', 'This cannot be undone.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const snapshot = comments;
            setComments((prev) => prev.filter((c) => c.id !== comment.id));
            try {
              await commentService.deleteComment(postId, comment.id, collectionName);
            } catch {
              setComments(snapshot); // restore on failure
              Alert.alert('Error', 'Could not delete the comment.');
            }
          },
        },
      ]);
    } else {
      Alert.alert('Report comment?', 'Our team will review it.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Report',
          style: 'destructive',
          onPress: async () => {
            try {
              await commentService.reportComment(comment.id, collectionName);
              Alert.alert('Thanks', 'Report submitted.');
            } catch {
              Alert.alert('Error', 'Could not submit the report.');
            }
          },
        },
      ]);
    }
  }, [user, comments, postId, collectionName]);

  const gesture = Gesture.Pan()
    .onUpdate((event) => {
      'worklet';
      if (event.translationY > 0) translateY.value = event.translationY;
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
      <Pressable
        style={[styles.commentItem, item.pending && { opacity: 0.55 }]}
        onLongPress={() => handleLongPress(item)}
        delayLongPress={350}
      >
        <TouchableOpacity activeOpacity={0.8} onPress={() => openProfile(item.userId)}>
          <Avatar
            uri={item.userAvatar}
            name={item.username}
            size={36}
            style={styles.commentAvatar}
          />
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
            <TouchableOpacity onPress={() => handleReply(item)}>
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
      </Pressable>
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
                {[1, 2, 3, 4].map((i) => <CommentSkeleton key={i} isDark={isDark} />)}
              </View>
            ) : loadError && comments.length === 0 ? (
              <View style={styles.centerState}>
                <Text style={{ color: subTextColor, fontFamily: 'Urbanist-Medium', marginBottom: 12 }}>{loadError}</Text>
                <TouchableOpacity style={styles.retryButton} onPress={() => loadFirstPage(true)}>
                  <Text style={styles.retryText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <FlatList
                data={comments}
                renderItem={renderComment}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                onEndReached={loadMore}
                onEndReachedThreshold={0.4}
                ListFooterComponent={
                  isLoadingMore
                    ? <ActivityIndicator size="small" color="#FF4D67" style={{ marginVertical: 16 }} />
                    : null
                }
                ListEmptyComponent={
                  <View style={styles.centerState}>
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
                <Avatar
                  uri={user?.photoURL}
                  name={user?.displayName || 'Me'}
                  size={40}
                  style={styles.myAvatar}
                />

                <View style={[
                  styles.inputBoxWrapper,
                  {
                    backgroundColor: isInputFocused ? inputFocusedBg : inputDefaultBg,
                    borderColor: isInputFocused ? inputBorderFocused : inputBorderDefault,
                  },
                ]}>
                  <TextInput
                    ref={inputRef}
                    placeholder="Add a comment..."
                    placeholderTextColor={subTextColor}
                    style={[
                      styles.input,
                      { color: textColor },
                      Platform.OS === 'web' && { outlineStyle: 'none' } as any,
                    ]}
                    onFocus={() => setIsInputFocused(true)}
                    onBlur={() => setIsInputFocused(false)}
                    onChangeText={setCommentText}
                    value={commentText}
                    maxLength={MAX_COMMENT_LEN}
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
    flexGrow: 1,
  },
  centerState: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 50,
    paddingHorizontal: 24,
  },
  retryButton: {
    minHeight: 44,
    paddingHorizontal: 24,
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: '#FF4D67',
  },
  retryText: { color: '#FFF', fontFamily: 'Urbanist-Bold' },
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
