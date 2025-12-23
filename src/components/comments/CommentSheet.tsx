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
} from 'react-native';
import { Portal } from 'react-native-paper';
import { Ionicons } from '@expo/vector-icons';
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

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const SHEET_HEIGHT = SCREEN_HEIGHT * 0.75;

interface Comment {
  id: string;
  username: string;
  avatar: string;
  text: string;
  time: string;
  likes: number;
  isLiked: boolean;
}

const INITIAL_MOCK_COMMENTS: Comment[] = [
  { id: '1', username: 'alex_smith', avatar: 'https://i.pravatar.cc/150?u=alex', text: 'This is amazing! I love the first one. 😍', time: '2h', likes: 12, isLiked: false },
  { id: '2', username: 'carla_rodriguez', avatar: 'https://i.pravatar.cc/150?u=carla', text: 'Second one for sure! The lighting is perfect.', time: '1h', likes: 5, isLiked: true },
  { id: '3', username: 'mike_brown', avatar: 'https://i.pravatar.cc/150?u=mike', text: 'Great shots! Keep it up.', time: '45m', likes: 2, isLiked: false },
  { id: '4', username: 'emma_watson', avatar: 'https://i.pravatar.cc/150?u=emma', text: 'Wow, hard to choose, both are so good!', time: '30m', likes: 8, isLiked: false },
  { id: '5', username: 'john_doe', avatar: 'https://i.pravatar.cc/150?u=john', text: 'Excellent composition!', time: '15m', likes: 3, isLiked: false },
  { id: '6', username: 'sophia_l', avatar: 'https://i.pravatar.cc/150?u=sophia', text: 'The colors are vibrant.', time: '10m', likes: 1, isLiked: false },
];

interface CommentSheetProps {
  visible: boolean;
  onDismiss: () => void;
  isDark: boolean;
}

export const CommentSheet = ({ visible, onDismiss, isDark }: CommentSheetProps) => {
  const translateY = useSharedValue(SHEET_HEIGHT);
  const opacity = useSharedValue(0);
  const [shouldRender, setShouldRender] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const backgroundColor = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const subTextColor = isDark ? '#BDBDBD' : '#616161';
  
  const inputDefaultBg = isDark ? '#1F222A' : '#FFFFFF';
  const inputFocusedBg = isDark ? '#35383F' : '#FFEBEE';
  const inputBorderDefault = isDark ? '#35383F' : '#EEEEEE';
  const inputBorderFocused = '#FF4D67';

  const HeartIcon = isDark ? Icons.HeartIcon_Dark : Icons.HeartIcon_Light;

  useEffect(() => {
    if (visible) {
      setShouldRender(true);
      translateY.value = withSpring(0, { damping: 20, stiffness: 90 });
      opacity.value = withTiming(1, { duration: 300 });
      
      // Simulate loading comments
      setIsLoading(true);
      const timer = setTimeout(() => {
          setComments(INITIAL_MOCK_COMMENTS);
          setIsLoading(false);
      }, 1500);
      return () => clearTimeout(timer);
    } else {
      translateY.value = withSpring(SHEET_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
          if (finished) {
              runOnJS(setShouldRender)(false);
          }
      });
      opacity.value = withTiming(0, { duration: 300 });
      setComments([]); 
    }
  }, [visible]);

  const closeSheet = useCallback(() => {
    translateY.value = withSpring(SHEET_HEIGHT, { damping: 20, stiffness: 90 }, (finished) => {
      if (finished) {
        runOnJS(onDismiss)();
        runOnJS(setShouldRender)(false);
      }
    });
    opacity.value = withTiming(0, { duration: 300 });
  }, [onDismiss]);

  const toggleLikeComment = (id: string) => {
    setComments(prevComments => 
      prevComments.map(comment => 
        comment.id === id 
          ? { ...comment, isLiked: !comment.isLiked, likes: comment.isLiked ? comment.likes - 1 : comment.likes + 1 }
          : comment
      )
    );
  };

  const gesture = Gesture.Pan()
    .onUpdate((event) => {
      if (event.translationY > 0) {
        translateY.value = event.translationY;
      }
    })
    .onEnd((event) => {
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

  if (!shouldRender && !visible) return null;

  const renderComment = ({ item }: { item: Comment }) => (
    <View style={styles.commentItem}>
      <Image source={{ uri: item.avatar }} style={styles.commentAvatar} />
      <View style={styles.commentContent}>
        <View style={styles.commentHeader}>
          <Text style={[styles.commentUser, { color: textColor }]}>
            {item.username} <Text style={[styles.commentTime, { color: subTextColor }]}>{item.time}</Text>
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
        onPress={() => toggleLikeComment(item.id)}
      >
        <HeartIcon 
            width={18} 
            height={18} 
            color={item.isLiked ? "#FF4D67" : subTextColor} 
        />
        <Text style={[styles.commentLikes, { color: subTextColor }]}>{item.likes}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <Portal>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        {/* Backdrop */}
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeSheet} />
        </Animated.View>

        {/* Sheet */}
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
                />
            )}

            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
            >
              <View style={[styles.inputArea, { backgroundColor, borderTopColor: isDark ? '#35383F' : '#EEEEEE' }]}>
                {/* Profile Picture */}
                <Image source={{ uri: 'https://ui-avatars.com/api/?name=Me' }} style={styles.myAvatar} />
                
                {/* Signup Style Input Box */}
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

                {/* Custom Send Icon SVG */}
                <TouchableOpacity 
                    style={[styles.sendButton, { opacity: commentText.length > 0 ? 1 : 0.5 }]} 
                    disabled={commentText.length === 0}
                >
                  <Icons.Send_Icon width={28} height={28} color="#FF4D67" />
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
