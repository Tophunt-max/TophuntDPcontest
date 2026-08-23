import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Dimensions,
  Pressable,
  SafeAreaView,
  StatusBar,
  Text,
  Animated,
  PanResponder,
  ActivityIndicator,
  FlatList,
  Modal,
  TextInput,
  TouchableOpacity,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  useColorScheme
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView, createVideoPlayer } from 'expo-video';
import { Ionicons } from '@/src/lib/icons';
import { 
    fetchStories, 
    markStoryAsSeen, 
    fetchStoryViewers,
    fetchUserHighlights,
    createHighlight,
    addStoryToHighlight,
    reactToStory,
    createStoryRecord,
    deleteStory 
} from '@/src/services/stories/storyService';
import { auth } from '@/src/services/firebase/initFirebase';
import { 
    Highlight_Story_Icon,
    Viewers_Icon,
    Delete_Icon
} from '@/assets/svgs';
import { Colors } from '@/constants/theme';
import { formatClockTime } from '@/src/lib/formatTime';
import { playableVideoUrl } from '@/src/lib/videoSource';
import { Avatar } from '@/src/components/ui/Avatar';
import type { StoryViewer } from '@/src/types/stories';

const { width, height } = Dimensions.get('window');
const DEFAULT_STORY_DURATION = 5000;
const REACTION_EMOJIS = ['❤️', '🙌', '🔥', '😂', '😮', '😢', '👏', '🎉'];

export default function StoryView() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const colorScheme = useColorScheme();
  const isDarkTheme = colorScheme === 'dark';
  const backgroundColorTheme = isDarkTheme ? Colors.dark.background : Colors.light.background;
  const textColorTheme = isDarkTheme ? Colors.dark.text : Colors.light.text;

  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [progress] = useState(new Animated.Value(0));
  const [isPaused, setIsPaused] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [duration, setDuration] = useState(DEFAULT_STORY_DURATION);
  const [showViewers, setShowViewers] = useState(false);
  const [viewers, setViewers] = useState<StoryViewer[]>([]);
  const [loadingViewers, setLoadingViewers] = useState(false);

  // Highlights State
  const [showHighlightModal, setShowHighlightModal] = useState(false);
  const [highlights, setHighlights] = useState<any[]>([]);
  const [newHighlightName, setNewHighlightName] = useState('');
  const [isCreatingHighlight, setIsCreatingHighlight] = useState(false);
  
  // Reply State
  const [replyText, setReplyText] = useState('');
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  
  // Repost State
  const [isReposting, setIsReposting] = useState(false);

  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const progressValue = useRef(0);
  const viewersTranslateY = useRef(new Animated.Value(height)).current;
  const highlightTranslateY = useRef(new Animated.Value(height)).current;

  const [activeReaction, setActiveReaction] = useState<string | null>(null);
  const reactionAnim = useRef(new Animated.Value(0)).current;

  const { data: allUserStories } = useQuery({
    queryKey: ['stories'],
    // Wrapped, not passed by reference: react-query would otherwise pass its
    // QueryFunctionContext in as fetchStories' options argument.
    queryFn: () => fetchStories(),
  });

  const users = allUserStories || [];
  const currentUserIndex = users.findIndex(u => u.userId === userId);
  const currentUserStories = users[currentUserIndex];
  const currentStory = currentUserStories?.stories[currentStoryIndex];
  // The stories adjacent to the current one. Named *Item to stay distinct from the
  // nextStory/prevStory *navigation callbacks* declared further down.
  const nextStoryItem = currentUserStories?.stories[currentStoryIndex + 1];
  const prevStoryItem = currentUserStories?.stories[currentStoryIndex - 1];

  // Warm the adjacent videos so transitions don't stall on a cold buffer.
  // createVideoPlayer() returns a player that does NOT auto-release, so every
  // instance created here must be released in the cleanup phase or it leaks a
  // native decoder for the lifetime of the screen.
  useEffect(() => {
    const preloadUrls = [nextStoryItem, prevStoryItem]
      .filter((s) => s?.mediaType === 'video' && !!s?.mediaUrl)
      .map((s) => playableVideoUrl(s!.mediaUrl));

    const players = preloadUrls.map((uri) => {
      try {
        const p = createVideoPlayer(uri);
        p.muted = true;
        return p;
      } catch (e) {
        console.warn('[StoryView] video preload failed:', e);
        return null;
      }
    });

    return () => {
      players.forEach((p) => {
        try {
          p?.release();
        } catch {
          // Already released by the runtime; nothing to do.
        }
      });
    };
  }, [nextStoryItem?.mediaUrl, prevStoryItem?.mediaUrl]);

  const isMyStory = currentUserStories?.userId === auth.currentUser?.uid;
  const isMentioned = currentStory?.mentions?.includes(auth.currentUser?.uid || '');

  // playableVideoUrl: web swaps a Bunny HLS playlist for the MP4 fallback;
  // native plays HLS directly. R2 URLs are untouched.
  const player = useVideoPlayer(currentStory?.mediaType === 'video' ? playableVideoUrl(currentStory.mediaUrl) : '', (player) => {
    player.loop = false;
  });

  // Keyboard Listeners
  useEffect(() => {
      const showSubscription = Keyboard.addListener('keyboardDidShow', () => {
          setIsKeyboardVisible(true);
          setIsPaused(true);
      });
      const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
          setIsKeyboardVisible(false);
          setIsPaused(false);
      });
      return () => {
          showSubscription.remove();
          hideSubscription.remove();
      };
  }, []);

  const nextStory = useCallback(() => {
    if (!currentUserStories) return;
    if (currentStoryIndex < currentUserStories.stories.length - 1) {
      setCurrentStoryIndex(prev => prev + 1);
    } else if (currentUserIndex < users.length - 1) {
      const nextUser = users[currentUserIndex + 1];
      router.setParams({ userId: nextUser.userId });
      setCurrentStoryIndex(0);
    } else {
      router.back();
    }
  }, [currentStoryIndex, currentUserStories, currentUserIndex, users, router]);

  const prevStory = useCallback(() => {
    if (!currentUserStories) return;
    if (currentStoryIndex > 0) {
      setCurrentStoryIndex(prev => prev - 1);
    } else if (currentUserIndex > 0) {
      const prevUser = users[currentUserIndex - 1];
      router.setParams({ userId: prevUser.userId });
      setCurrentStoryIndex(prevUser.stories.length - 1);
    }
  }, [currentStoryIndex, currentUserStories, currentUserIndex, users, router]);

  const startAnimation = (storyDuration: number) => {
    progress.setValue(0);
    progressValue.current = 0;
    if (animationRef.current) animationRef.current.stop();
    animationRef.current = Animated.timing(progress, {
      toValue: 1,
      duration: storyDuration,
      useNativeDriver: false,
    });
    animationRef.current.start(({ finished }) => {
      if (finished) nextStory();
    });
  };

  useEffect(() => {
    if (currentStory) {
      markStoryAsSeen(currentStory.id);
      setIsLoading(true);
      if (currentStory.mediaType === 'image') {
        setDuration(DEFAULT_STORY_DURATION);
        setIsLoading(false);
        startAnimation(DEFAULT_STORY_DURATION);
      }
      if (isMyStory) {
          loadViewers(currentStory.id);
          loadHighlights();
      }
    }
  }, [currentStoryIndex, userId]);

  const loadViewers = async (id: string) => {
      setLoadingViewers(true);
      const data = await fetchStoryViewers(id);
      setViewers(data);
      setLoadingViewers(false);
  };

  const loadHighlights = async () => {
      if (auth.currentUser) {
          const data = await fetchUserHighlights(auth.currentUser.uid);
          setHighlights(data);
      }
  };

  const handleReaction = async (emoji: string) => {
      if (!currentStory) return;
      setActiveReaction(emoji);
      reactionAnim.setValue(0);
      Animated.sequence([
          Animated.spring(reactionAnim, { toValue: 1, useNativeDriver: true, tension: 50, friction: 5 }),
          Animated.delay(1000),
          Animated.timing(reactionAnim, { toValue: 0, duration: 300, useNativeDriver: true })
      ]).start(() => setActiveReaction(null));
      await reactToStory(currentStory.id, emoji);
  };

  const handleCreateHighlight = async () => {
      if (!newHighlightName.trim() || !currentStory || !auth.currentUser) return;
      setIsCreatingHighlight(true);
      try {
          await createHighlight(newHighlightName, currentStory.mediaUrl, [currentStory.id]);
          setNewHighlightName('');
          toggleHighlightSheet(false);
          loadHighlights();
          queryClient.invalidateQueries({ queryKey: ['highlights', auth.currentUser.uid] });
          Alert.alert("Success", `Highlight "${newHighlightName}" created successfully!`);
      } catch (e) {
          Alert.alert("Error", "Could not create highlight");
      } finally {
          setIsCreatingHighlight(false);
      }
  };

  const handleAddToHighlight = async (hId: string) => {
      if (!currentStory) return;
      try {
          await addStoryToHighlight(hId, currentStory.id);
          toggleHighlightSheet(false);
          Alert.alert("Success", "Added to highlight!");
      } catch (e) {
          Alert.alert("Error", "Could not add to highlight");
      }
  };

  const handleSendReply = async () => {
      if (!replyText.trim() || !currentStory || !auth.currentUser) return;
      
      const text = replyText.trim();
      setReplyText('');
      Keyboard.dismiss();

      try {
          Alert.alert("Sent", "Reply sent successfully!"); 
      } catch (error) {
          console.error("Error sending reply:", error);
      }
  };

  const handleRepostStory = async () => {
      if (!currentStory || isReposting) return;
      setIsReposting(true);
      setIsPaused(true);
      try {
          await createStoryRecord(
              currentStory.mediaUrl,
              currentStory.mediaType,
              'public',
              `Reposted from @${currentUserStories.username}`,
              { x: 0.5, y: 0.8 }
          );
          Alert.alert("Success", "Added to your story!");
          queryClient.invalidateQueries({ queryKey: ['stories'] });
      } catch (error) {
          Alert.alert("Error", "Failed to repost story");
      } finally {
          setIsReposting(false);
          setIsPaused(false);
      }
  };

  const handleDeleteStory = () => {
    setIsPaused(true);
    Alert.alert(
        "Delete Story",
        "Are you sure you want to delete this story?",
        [
            {
                text: "Cancel",
                style: "cancel",
                onPress: () => setIsPaused(false)
            },
            {
                text: "Delete",
                style: "destructive",
                onPress: async () => {
                    try {
                        if (!currentStory) return;
                        await deleteStory(currentStory.id);
                        await queryClient.invalidateQueries({ queryKey: ['stories'] });
                        
                        if (currentUserStories.stories.length <= 1) {
                            router.back();
                        } else {
                            nextStory();
                        }
                    } catch (error) {
                        console.error("Delete failed", error);
                        Alert.alert("Error", "Failed to delete story.");
                        setIsPaused(false);
                    }
                }
            }
        ]
    );
  };

  const toggleViewers = (show: boolean) => {
      setShowViewers(show);
      setIsPaused(show);
      Animated.spring(viewersTranslateY, {
          toValue: show ? height * 0.4 : height,
          useNativeDriver: true,
          tension: 50,
          friction: 8
      }).start();
  };

  const toggleHighlightSheet = (show: boolean) => {
      if (show) {
          setShowHighlightModal(true);
          setIsPaused(true);
          Animated.spring(highlightTranslateY, {
              toValue: 0,
              useNativeDriver: true,
              tension: 50,
              friction: 8
          }).start();
      } else {
          Animated.timing(highlightTranslateY, {
              toValue: height,
              duration: 300,
              useNativeDriver: true
          }).start(() => {
              setShowHighlightModal(false);
              setIsPaused(false);
          });
      }
  };

  useEffect(() => {
    if (currentStory?.mediaType === 'video') {
        const subscription = player.addListener('statusChange', (status) => {
            if (status.status === 'readyToPlay') {
                const videoDuration = (player.duration || 5) * 1000;
                setDuration(videoDuration);
                setIsLoading(false);
                if (!isPaused && !showHighlightModal) {
                    player.play();
                    startAnimation(videoDuration);
                }
            }
        });
        return () => subscription.remove();
    }
  }, [currentStory, player, isPaused, showHighlightModal]);

  useEffect(() => {
    if (isPaused || showHighlightModal || isKeyboardVisible) {
      if (animationRef.current) animationRef.current.stop();
      if (currentStory?.mediaType === 'video') player.pause();
    } else if (!showViewers) {
      if (currentStory?.mediaType === 'video') player.play();
      const remainingDuration = (1 - progressValue.current) * duration;
      animationRef.current = Animated.timing(progress, {
        toValue: 1,
        duration: remainingDuration,
        useNativeDriver: false,
      });
      animationRef.current.start(({ finished }) => {
        if (finished) nextStory();
      });
    }
  }, [isPaused, showViewers, showHighlightModal, isKeyboardVisible]);

  const mainPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => setIsPaused(true),
      onPanResponderMove: (evt, gestureState) => {
          if (isMyStory && gestureState.dy < -20 && !isKeyboardVisible) {
              toggleViewers(true);
          }
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (showViewers || showHighlightModal || isKeyboardVisible) return;
        setIsPaused(false);
        if (gestureState.dy > 100) {
          router.back();
        } else if (evt.nativeEvent.locationX < width / 3) {
          prevStory();
        } else if (evt.nativeEvent.locationX > (2 * width) / 3) {
          nextStory();
        }
      },
    })
  ).current;

  const sheetPanResponder = useRef(
    PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderMove: (evt, gestureState) => {
            if (gestureState.dy > 0) {
                viewersTranslateY.setValue(height * 0.4 + gestureState.dy);
            }
        },
        onPanResponderRelease: (evt, gestureState) => {
            if (gestureState.dy > 100) {
                toggleViewers(false);
            } else {
                toggleViewers(true);
            }
        }
    })
  ).current;

  const highlightPanResponder = useRef(
    PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderMove: (evt, gestureState) => {
            if (gestureState.dy > 0) {
                highlightTranslateY.setValue(gestureState.dy);
            }
        },
        onPanResponderRelease: (evt, gestureState) => {
            if (gestureState.dy > 100) {
                toggleHighlightSheet(false);
            } else {
                toggleHighlightSheet(true);
            }
        }
    })
  ).current;

  if (!currentUserStories?.stories?.length) {
    router.back();
    return null;
  }
  if (!currentStory) return null;

  return (
    <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
    >
        <View style={styles.container}>
        <StatusBar hidden />
        <View style={styles.mediaContainer} {...mainPanResponder.panHandlers}>
            {currentStory.mediaType === 'image' ? (
                <Image source={{ uri: currentStory.mediaUrl }} style={styles.media} contentFit="contain" />
            ) : (
                <VideoView player={player} style={styles.media} contentFit="contain" />
            )}
            {isLoading && <View style={styles.loader}><ActivityIndicator size="large" color="white" /></View>}
            
            {/* Saved Overlays */}
            {currentStory.overlayText && (
                <View style={[styles.textBubble, { 
                    position: 'absolute', 
                    left: (currentStory.textPosition?.x || 0.5) * width - 50, 
                    top: (currentStory.textPosition?.y || 0.5) * height 
                }]}>
                    <Text style={styles.overlayTextDisplay}>{currentStory.overlayText}</Text>
                </View>
            )}

            {/* Reactions Animation */}
            {activeReaction && (
                <Animated.View style={[styles.floatingReaction, { 
                    opacity: reactionAnim,
                    transform: [
                        { scale: reactionAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 2] }) },
                        { translateY: reactionAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -100] }) }
                    ] 
                }]}>
                    <Text style={{ fontSize: 60 }}>{activeReaction}</Text>
                </Animated.View>
            )}
        </View>

        <SafeAreaView style={styles.overlay} pointerEvents="box-none">
            <View style={styles.header}>
            <View style={styles.progressContainer}>
                {currentUserStories.stories.map((_, index) => (
                <View key={index} style={styles.progressBackground}>
                    <Animated.View style={[styles.progressBar, { width: index < currentStoryIndex ? '100%' : index === currentStoryIndex ? progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) : '0%' }]} />
                </View>
                ))}
            </View>
            <View style={styles.userInfo}>
                <Avatar
                  uri={currentUserStories.avatarUrlThumb || currentUserStories.avatarUrl}
                  name={currentUserStories.username}
                  size={40}
                  style={styles.avatar}
                />
                <View style={styles.userTextContainer}>
                    <Text style={styles.username}>{currentUserStories.username}</Text>
                    <Text style={styles.timeAgo}>{formatClockTime(currentStory.createdAt)}</Text>
                </View>
                <Pressable pointerEvents="auto" onPress={() => router.back()} style={styles.closeButton}><Ionicons name="close" size={28} color="white" /></Pressable>
            </View>
            </View>

            {/* Repost Button */}
            {isMentioned && !isMyStory && (
                <View style={styles.repostContainer} pointerEvents="auto">
                    <TouchableOpacity style={styles.repostBtn} onPress={handleRepostStory} disabled={isReposting}>
                        {isReposting ? <ActivityIndicator color="white" /> : (
                            <>
                                <Ionicons name="add-circle" size={24} color="white" />
                                <Text style={styles.repostText}>Add to your story</Text>
                            </>
                        )}
                    </TouchableOpacity>
                </View>
            )}

            {/* Bottom Actions or Reply Field */}
            {!isMyStory && !showViewers && (
                <View style={styles.footerContainer} pointerEvents="auto">
                    <View style={styles.replyInputContainer}>
                        <TextInput 
                            style={styles.replyInput}
                            placeholder="Send message"
                            placeholderTextColor="white"
                            value={replyText}
                            onChangeText={setReplyText}
                            onFocus={() => setIsPaused(true)}
                        />
                        {replyText.length > 0 ? (
                            <TouchableOpacity onPress={handleSendReply}>
                                <Text style={styles.sendText}>Send</Text>
                            </TouchableOpacity>
                        ) : (
                            <View style={styles.quickReactions}>
                                <TouchableOpacity onPress={() => handleReaction('❤️')} style={styles.miniReaction}><Text style={{fontSize: 20}}>❤️</Text></TouchableOpacity>
                                <TouchableOpacity onPress={() => handleReaction('😂')} style={styles.miniReaction}><Text style={{fontSize: 20}}>😂</Text></TouchableOpacity>
                            </View>
                        )}
                    </View>
                    <TouchableOpacity style={styles.likeBtn} onPress={() => handleReaction('❤️')}>
                        <Ionicons name="heart-outline" size={28} color="white" />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.shareBtn}>
                        <Ionicons name="paper-plane-outline" size={28} color="white" />
                    </TouchableOpacity>
                </View>
            )}

            {isMyStory && !showViewers && (
                <View style={styles.bottomActions} pointerEvents="auto">
                    <Pressable style={styles.actionBtn} onPress={() => toggleHighlightSheet(true)}>
                        <Highlight_Story_Icon width={28} height={28} />
                        <Text style={styles.actionText}>Highlight</Text>
                    </Pressable>
                    <Pressable style={styles.actionBtn} onPress={() => toggleViewers(true)}>
                        <Viewers_Icon width={28} height={28} />
                        <Text style={styles.actionText}>{viewers.length}</Text>
                    </Pressable>
                    <Pressable style={styles.actionBtn} onPress={handleDeleteStory}>
                        <Delete_Icon width={24} height={24} />
                        <Text style={styles.actionText}>Delete</Text>
                    </Pressable>
                </View>
            )}
        </SafeAreaView>

        {/* Highlights Modal */}
        <Modal visible={showHighlightModal} transparent animationType="none">
            <View style={styles.modalOverlay}>
                <Animated.View style={[styles.highlightModal, { backgroundColor: backgroundColorTheme, transform: [{ translateY: highlightTranslateY }] }]} {...highlightPanResponder.panHandlers}>
                    <View style={styles.modalHeader}>
                        <View style={[styles.sheetHandle, { backgroundColor: isDarkTheme ? '#35383F' : '#DDD' }]} />
                        <View style={styles.modalHeaderContent}>
                            <Text style={[styles.modalTitle, { color: textColorTheme }]}>Add to Highlights</Text>
                            <Pressable onPress={() => toggleHighlightSheet(false)}><Ionicons name="close-circle" size={24} color={isDarkTheme ? '#BDBDBD' : "#666"} /></Pressable>
                        </View>
                    </View>
                    <View style={[styles.newHighlightContainer, { borderBottomColor: isDarkTheme ? '#35383F' : '#EEE' }]}>
                        <View style={[styles.newHighlightCircle, { backgroundColor: isDarkTheme ? '#2D1F22' : '#FFF0F3' }]}><Ionicons name="add" size={30} color="#ff4466" /></View>
                        <TextInput style={[styles.highlightInput, { backgroundColor: isDarkTheme ? '#1F222A' : '#F5F5F5', color: textColorTheme }]} placeholder="New Highlight" placeholderTextColor={isDarkTheme ? '#BDBDBD' : '#999'} value={newHighlightName} onChangeText={setNewHighlightName} />
                        <TouchableOpacity style={[styles.addBtn, !newHighlightName.trim() && { opacity: 0.5 }]} onPress={handleCreateHighlight} disabled={isCreatingHighlight || !newHighlightName.trim()}>
                            {isCreatingHighlight ? <ActivityIndicator color="white" /> : <Text style={styles.addBtnText}>Add</Text>}
                        </TouchableOpacity>
                    </View>
                    <FlatList data={highlights} horizontal showsHorizontalScrollIndicator={false} keyExtractor={(item) => item.id} contentContainerStyle={{ paddingVertical: 20 }} renderItem={({ item }) => (
                        <TouchableOpacity style={styles.highlightItem} onPress={() => handleAddToHighlight(item.id)}>
                            <Image source={{ uri: item.coverImageUrl }} style={styles.highlightThumb} />
                            <Text style={[styles.highlightName, { color: textColorTheme }]} numberOfLines={1}>{item.name}</Text>
                        </TouchableOpacity>
                    )} />
                </Animated.View>
            </View>
        </Modal>

        {/* Viewers Sheet */}
        <Animated.View style={[styles.viewersSheet, { backgroundColor: backgroundColorTheme, transform: [{ translateY: viewersTranslateY }] }]} {...sheetPanResponder.panHandlers}>
            <View style={styles.sheetHeader}>
                <View style={[styles.sheetHandle, { backgroundColor: isDarkTheme ? '#35383F' : '#DDD' }]} />
                <Text style={[styles.sheetTitle, { color: textColorTheme }]}>Viewers ({viewers.length})</Text>
                <Pressable onPress={() => toggleViewers(false)} style={styles.sheetClose}><Ionicons name="close-circle" size={24} color={isDarkTheme ? '#BDBDBD' : "#666"} /></Pressable>
            </View>
            <FlatList data={viewers} keyExtractor={(item, index) => `${item.uid}_${index}`} renderItem={({ item }) => (
                <View style={[styles.viewerItem, { borderBottomColor: isDarkTheme ? '#35383F' : '#F0F0F0' }]}>
                    <Image source={{ uri: item.avatarUrl }} style={styles.viewerAvatar} />
                    <View style={{ flex: 1 }}>
                        <Text style={[styles.viewerName, { color: textColorTheme }]}>{item.username}</Text>
                        <Text style={[styles.viewTime, { color: isDarkTheme ? '#BDBDBD' : '#666' }]}>{formatClockTime(item.viewedAt)}</Text>
                    </View>
                    {item.reaction && <Text style={{ fontSize: 24 }}>{item.reaction}</Text>}
                </View>
            )} ListEmptyComponent={<Text style={styles.emptyText}>No views yet</Text>} contentContainerStyle={{ paddingBottom: 50 }} />
        </Animated.View>
        </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  mediaContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  media: { width: width, height: height },
  loader: { position: 'absolute' },
  overlay: { ...StyleSheet.absoluteFillObject },
  pauseOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.3)' },
  pauseLottie: { width: 120, height: 120 },
  header: { paddingHorizontal: 10, paddingTop: 10 },
  progressContainer: { flexDirection: 'row', height: 2, marginBottom: 10 },
  progressBackground: { flex: 1, height: 2, backgroundColor: 'rgba(255, 255, 255, 0.3)', marginHorizontal: 2, borderRadius: 1, overflow: 'hidden' },
  progressBar: { height: '100%', backgroundColor: '#FFF' },
  userInfo: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  avatar: { width: 40, height: 40, borderRadius: 20, marginRight: 10, borderWidth: 1, borderColor: 'white' },
  userTextContainer: { flex: 1 },
  username: { color: '#FFF', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  timeAgo: { color: 'rgba(255, 255, 255, 0.8)', fontSize: 12 },
  closeButton: { padding: 5 },
  bottomActions: { position: 'absolute', bottom: 40, width: '100%', flexDirection: 'row', justifyContent: 'center', gap: 40 },
  actionBtn: { alignItems: 'center' },
  actionText: { color: 'white', fontSize: 12, marginTop: 4, fontFamily: 'Urbanist-Medium' },
  floatingReaction: { position: 'absolute', width: '100%', alignItems: 'center', bottom: height * 0.4 },
  textBubble: { backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 10 },
  overlayTextDisplay: { color: 'white', fontSize: 24, fontFamily: 'Urbanist-Bold', textAlign: 'center' },
  reactionContainer: { position: 'absolute', bottom: 100, width: '100%', flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 15, paddingHorizontal: 20 },
  reactionBtn: { backgroundColor: 'rgba(255,255,255,0.2)', padding: 10, borderRadius: 25 },
  
  // Repost Styles
  repostContainer: { position: 'absolute', bottom: 180, width: '100%', alignItems: 'center' },
  repostBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0095f6', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 30, gap: 10 },
  repostText: { color: 'white', fontFamily: 'Urbanist-Bold', fontSize: 16 },

  // Footer / Reply Styles
  footerContainer: { position: 'absolute', bottom: 20, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15 },
  replyInputContainer: { flex: 1, height: 45, borderRadius: 25, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, marginRight: 15 },
  replyInput: { flex: 1, color: 'white', fontSize: 16 },
  sendText: { color: '#ff4466', fontWeight: 'bold', marginLeft: 10 },
  likeBtn: { marginRight: 15 },
  shareBtn: {},
  quickReactions: { flexDirection: 'row', gap: 10 },
  miniReaction: { padding: 0 },

  // Sheet Styles
  viewersSheet: { position: 'absolute', left: 0, right: 0, height: height * 0.6, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, zIndex: 100 },
  sheetHeader: { alignItems: 'center', marginBottom: 20 },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, marginBottom: 10 },
  sheetTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  sheetClose: { position: 'absolute', right: 0, top: 0 },
  viewerItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1 },
  viewerAvatar: { width: 45, height: 45, borderRadius: 22.5, marginRight: 12 },
  viewerName: { fontSize: 16, fontFamily: 'Urbanist-SemiBold' },
  viewTime: { fontSize: 12 },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 50, fontFamily: 'Urbanist-Medium' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  highlightModal: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, minHeight: 300 },
  modalHeader: { alignItems: 'center', marginBottom: 20 },
  modalHeaderContent: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
  modalTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  newHighlightContainer: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, paddingBottom: 15 },
  newHighlightCircle: { width: 60, height: 60, borderRadius: 30, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#ff4466' },
  highlightInput: { flex: 1, height: 45, borderRadius: 10, paddingHorizontal: 15, fontFamily: 'Urbanist-Medium' },
  addBtn: { backgroundColor: '#ff4466', paddingHorizontal: 15, paddingVertical: 10, borderRadius: 10 },
  addBtnText: { color: 'white', fontFamily: 'Urbanist-Bold' },
  highlightItem: { alignItems: 'center', marginRight: 20, width: 70 },
  highlightThumb: { width: 60, height: 60, borderRadius: 30, marginBottom: 8, borderWidth: 2, borderColor: '#ff4466' },
  highlightName: { fontSize: 12, fontFamily: 'Urbanist-SemiBold', textAlign: 'center' },
});
