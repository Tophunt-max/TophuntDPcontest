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
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Colors } from '@/constants/theme';

dayjs.extend(relativeTime);

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

  const formatTime = (timestamp: any) => {
      if (!timestamp) return 'now';
      const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
      return dayjs(date).fromNow(true);
  };

  if (!shouldRender && !visible) return null;

  const renderComment = ({ item }: { item: Comment }) => (
    <View style={styles.commentItem}>
      <Image source={{ uri: item.userAvatar }} style={styles.commentAvatar} />
      <View style={styles.commentContent}>
        <View style={styles.commentHeader}>
          <Text style={[styles.commentUser, { color: textColor }]}>
            {item.username} <Text style={[styles.commentTime, { color: subTextColor }]}>{formatTime(item.createdAt)}</Text>
          </Text>
        </View>
        <Text style={[styles.commentText, { color: textColor }]}>{item.text}</Text>
        <View style={styles.commentFooter}>
          <TouchableOpacity>
            <Text style={[styles.replyText, { color: subTextColor }]}>Reply</Text>
          </TouchableOpacity>
        </View>
      </View>
      <TouchableOpacity style={styles.heartButton}>
        <HeartIcon width={18} height={18} color={subTextColor} />
        <Text style={[styles.commentLikes, { color: subTextColor }]}>{item.likes || 0}</Text>
      </TouchableOpacity>
    </View>
  );

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
