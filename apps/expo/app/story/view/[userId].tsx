import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import {
    fetchStories,
    markStoryAsSeen,
    fetchStoryViewers,
    fetchUserHighlights,
    addStoryToHighlight,
    deleteStory
} from '@/src/services/stories/storyService';
import { auth } from '@/src/services/firebase/initFirebase';
import {
    Highlight_Story_Icon,
    Viewers_Icon,
    Delete_Icon,
    Close_Icon,
    Heart_Outline
} from '@/assets/svgs';
import { Colors } from '@/constants/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StoryVideo } from '@/src/components/stories/StoryVideo';
import { getOptimizedMediaUrl } from '@/src/utils/media';
import { getCachedMedia } from '@/src/services/media/MediaCacheService';

const { width, height } = Dimensions.get('window');
const DEFAULT_STORY_DURATION = 5000;

export default function StoryView() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const colorScheme = useColorScheme();
  const isDarkTheme = colorScheme === 'dark';
  const themeColors = isDarkTheme ? Colors.dark : Colors.light;
  const insets = useSafeAreaInsets();

  // Core State
  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [duration, setDuration] = useState(DEFAULT_STORY_DURATION);

  // UI State
  const [isPaused, setIsPaused] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [showViewers, setShowViewers] = useState(false);
  const [showHighlightModal, setShowHighlightModal] = useState(false);

  // Data State
  const [viewers, setViewers] = useState<any[]>([]);
  const [highlights, setHighlights] = useState<any[]>([]);
  const [replyText, setReplyText] = useState('');
  const [imageSource, setImageSource] = useState<string | null>(null);

  // Data Fetching
  const { data: allUserStories, isLoading: isStoriesLoading } = useQuery<any>({ 
      queryKey: ['stories'], 
      queryFn: () => fetchStories(), 
  });

  // Derived Data
  const users = allUserStories?.userStories || [];
  const currentUserIndex = users.findIndex(u => u.userId === userId);
  const currentUserStories = users[currentUserIndex];
  const currentStory = currentUserStories?.stories[currentStoryIndex];
  const isMyStory = currentUserStories?.userId === auth.currentUser?.uid;

  // Refs & Animations
  const progress = useRef(new Animated.Value(0)).current;
  const progressValue = useRef(0); 
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const viewersTranslateY = useRef(new Animated.Value(height)).current;
  const highlightTranslateY = useRef(new Animated.Value(height)).current;

  useEffect(() => {
    const listener = progress.addListener(({ value }) => {
        progressValue.current = value;
    });
    return () => progress.removeListener(listener);
  }, [progress]);

  // Handle New Story
  useEffect(() => {
    if (!currentStory) return;
    
    setIsLoading(true);
    animationRef.current?.stop();
    progress.setValue(0);
    progressValue.current = 0;
    setImageSource(null);

    markStoryAsSeen(currentStory.id);
    
    if (isMyStory) {
        loadViewers(currentStory.id);
        loadHighlights();
    }

    if (currentStory.mediaType === 'image') {
        const loadMedia = async () => {
            const optimizedUrl = getOptimizedMediaUrl(currentStory.mediaUrl);
            const cachedUrl = await getCachedMedia(optimizedUrl);
            setImageSource(cachedUrl);
        };
        loadMedia();
    }
  }, [currentStory]);

  // Keyboard Listeners
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => setIsKeyboardVisible(true));
    const hideSub = Keyboard.addListener('keyboardDidHide', () => setIsKeyboardVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Animation Control
  useEffect(() => {
    const shouldPause = isPaused || showViewers || showHighlightModal || isKeyboardVisible || isLoading;
    
    if (shouldPause) {
      animationRef.current?.stop();
    } else {
      const remainingDuration = duration * (1 - progressValue.current);
      startAnimation(remainingDuration);
    }
  }, [isPaused, showViewers, showHighlightModal, isKeyboardVisible, isLoading, duration]);

  const startAnimation = (storyDuration: number) => {
    if (storyDuration <= 0) storyDuration = 100;

    animationRef.current?.stop();
    animationRef.current = Animated.timing(progress, {
      toValue: 1,
      duration: storyDuration,
      useNativeDriver: false,
    });
    animationRef.current.start(({ finished }) => { if (finished) nextStory(); });
  };

  const nextStory = () => {
    if (!currentUserStories) return;
    if (currentStoryIndex < currentUserStories.stories.length - 1) {
      setCurrentStoryIndex(i => i + 1);
    } else if (currentUserIndex < users.length - 1) {
      router.setParams({ userId: users[currentUserIndex + 1].userId });
      setCurrentStoryIndex(0);
    } else {
      router.back();
    }
  };

  const prevStory = () => {
    if (currentStoryIndex > 0) {
      setCurrentStoryIndex(i => i - 1);
    } else if (currentUserIndex > 0) {
      const prevUser = users[currentUserIndex - 1];
      router.setParams({ userId: prevUser.userId });
      setCurrentStoryIndex(prevUser.stories.length - 1);
    }
  };

  // Data Handlers
  const loadViewers = async (id: string) => {
      const res = await fetchStoryViewers(id);
      setViewers(res.viewers || []);
  };

  const loadHighlights = async () => { if(auth.currentUser) setHighlights(await fetchUserHighlights(auth.currentUser.uid)); };
  
  const handleDelete = () => Alert.alert("Delete Story", "Are you sure you want to delete this story?", [
    { text: "Cancel", style: "cancel", onPress: () => setIsPaused(false) },
    { text: "Delete", style: "destructive", onPress: async () => {
        try {
          if (!currentStory) return;
          await deleteStory(currentStory.id);
          await queryClient.invalidateQueries({ queryKey: ['stories'] });
          nextStory();
        } catch (e) { 
            Alert.alert("Error", "Could not delete story."); 
        }
      }
    }
  ]);

  const toggleViewersSheet = (show: boolean) => {
    setShowViewers(show);
    Animated.spring(viewersTranslateY, { toValue: show ? 0 : height, useNativeDriver: true, bounciness: 0 }).start();
  };

  const toggleHighlightSheet = (show: boolean) => {
    setShowHighlightModal(show);
    Animated.spring(highlightTranslateY, { toValue: show ? 0 : height, useNativeDriver: true, bounciness: 0 }).start();
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => setIsPaused(true),
      onPanResponderMove: (_, gs) => {
        if (isMyStory && !showViewers && gs.dy < -30) toggleViewersSheet(true);
      },
      onPanResponderRelease: (_, gs) => {
        setIsPaused(false);
        if (gs.dy > 100) router.back();
      },
    })
  ).current;

  if (isStoriesLoading || !currentStory) {
    return <View style={styles.loadingContainer}><ActivityIndicator size="large" color="#FFF"/></View>;
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.container}>
      <StatusBar hidden />

      {/* --- Media Content --- */}
      <View style={styles.mediaContainer} {...panResponder.panHandlers}>
        {currentStory.mediaType === 'image' ? (
          imageSource ? (
            <Image 
              source={{ uri: imageSource }} 
              style={styles.media} 
              contentFit="cover" 
              onLoad={() => {
                  setDuration(DEFAULT_STORY_DURATION);
                  setIsLoading(false);
              }}
            />
          ) : (
            <View style={styles.loadingContainer}>
                <ActivityIndicator color="#fff" />
            </View>
          )
        ) : (
          <StoryVideo
            uri={currentStory.mediaUrl}
            thumbnail={currentStory.thumbnailUrl || currentStory.mediaUrl}
            isActive={!isPaused && !showViewers && !showHighlightModal && !isKeyboardVisible}
            isNext={currentStoryIndex < (currentUserStories?.stories?.length - 1)}
            onPlaybackFinished={nextStory}
            onLoadStart={() => setIsLoading(true)}
            onPlaybackUpdate={(status) => {
                if (status.isLoaded && status.durationMillis) {
                    setDuration(status.durationMillis);
                    setIsLoading(false);
                }
            }}
          />
        )}
      </View>

      {/* --- UI Overlay --- */}
      <View style={[styles.overlay, {paddingTop: insets.top}]} pointerEvents="box-none">
        <View style={styles.headerContainer}>
          <View style={styles.progressContainer}>
            {currentUserStories.stories.map((_, i) => (
              <View key={i} style={styles.progressBackground}>
                <Animated.View 
                  style={[
                    styles.progressBar, 
                    { 
                      width: i < currentStoryIndex 
                        ? '100%' 
                        : i === currentStoryIndex 
                          ? progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) 
                          : '0%' 
                    }
                  ]} 
                />
              </View>
            ))}
          </View>
          <View style={styles.userInfo}>
            <Image source={{ uri: currentUserStories.avatarUrl }} style={styles.avatar} />
            <Text style={styles.username}>{currentUserStories.username}</Text>
            <TouchableOpacity onPress={() => router.back()} style={styles.closeButton}>
              <Close_Icon width={30} height={30} color="white" />
            </TouchableOpacity>
          </View>
        </View>

        {/* --- Bottom Actions --- */}
        <View style={[styles.bottomActionsContainer, {paddingBottom: Math.max(insets.bottom, 20)}]}>
          {isMyStory ? (
            <View style={styles.myStoryActions}>
              <Pressable style={styles.actionBtn} onPress={() => toggleHighlightSheet(true)}>
                <Highlight_Story_Icon width={28} height={28} />
                <Text style={styles.actionText}>Highlight</Text>
              </Pressable>
              <Pressable style={styles.actionBtn} onPress={() => toggleViewersSheet(true)}>
                <Viewers_Icon width={28} height={28} />
                <Text style={styles.actionText}>{viewers.length}</Text>
              </Pressable>
              <Pressable style={styles.actionBtn} onPress={handleDelete}>
                <Delete_Icon width={24} height={24} />
                <Text style={styles.actionText}>Delete</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.replyContainer}>
              <TextInput 
                style={styles.replyInput} 
                placeholder="Send message..." 
                placeholderTextColor="#AAA" 
                value={replyText} 
                onChangeText={setReplyText} 
              />
              <TouchableOpacity>
                <Heart_Outline width={28} height={28} color="white" />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      {/* --- Tap Navigation Zones --- */}
      {!isKeyboardVisible && (
          <View style={styles.clickZonesContainer} pointerEvents="box-none">
              <Pressable style={styles.clickZone} onPress={prevStory} onLongPress={() => setIsPaused(true)} onPressOut={() => setIsPaused(false)} />
              <Pressable style={styles.clickZone} onPress={nextStory} onLongPress={() => setIsPaused(true)} onPressOut={() => setIsPaused(false)} />
          </View>
      )}

      {/* --- Viewer & Highlight Modals --- */}
      <Modal visible={showViewers} transparent onRequestClose={() => toggleViewersSheet(false)}>
        <Pressable style={styles.sheetOverlay} onPress={() => toggleViewersSheet(false)}>
            <Animated.View style={[styles.sheet, { backgroundColor: themeColors.background, transform: [{ translateY: viewersTranslateY }] }]}>
                <View style={styles.sheetHandle} />
                <Text style={[styles.sheetTitle, {color: themeColors.text}]}>Viewers</Text>
                <FlatList 
                    data={viewers} 
                    keyExtractor={item => item.uid} 
                    renderItem={({item}) => (
                        <View style={styles.viewerItem}>
                            <Image source={{uri: item.avatarUrl}} style={styles.viewerAvatar}/>
                            <Text style={{color: themeColors.text, fontFamily: 'Urbanist-Medium'}}>{item.username}</Text>
                        </View>
                    )}
                />
            </Animated.View>
        </Pressable>
      </Modal>

      <Modal visible={showHighlightModal} transparent onRequestClose={() => toggleHighlightSheet(false)}>
         <Pressable style={styles.sheetOverlay} onPress={() => toggleHighlightSheet(false)}>
            <Animated.View style={[styles.sheet, { backgroundColor: themeColors.background, transform: [{ translateY: highlightTranslateY }] }]}>
                <View style={styles.sheetHandle} />
                <Text style={[styles.sheetTitle, {color: themeColors.text}]}>Add to Highlights</Text>
                <FlatList 
                    data={highlights} 
                    keyExtractor={item => item.id} 
                    horizontal
                    renderItem={({item}) => (
                        <TouchableOpacity style={styles.highlightItem}>
                            <Image source={{uri: item.coverImageUrl}} style={styles.highlightThumb}/>
                            <Text style={{color: themeColors.text, fontSize: 12}}>{item.name}</Text>
                        </TouchableOpacity>
                    )}
                />
            </Animated.View>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  loadingContainer: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' },
  mediaContainer: { width: width, height: height, position: 'absolute' },
  media: { width: '100%', height: '100%' },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between', zIndex: 10 },
  headerContainer: { marginTop: 10 },
  progressContainer: { flexDirection: 'row', paddingHorizontal: 5 },
  progressBackground: { flex: 1, height: 2.5, backgroundColor: 'rgba(255, 255, 255, 0.3)', marginHorizontal: 2, borderRadius: 1.5 },
  progressBar: { height: '100%', backgroundColor: '#FFF' },
  userInfo: { flexDirection: 'row', alignItems: 'center', padding: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, marginRight: 10 },
  username: { flex: 1, color: 'white', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  closeButton: { padding: 5 },
  clickZonesContainer: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', zIndex: 5 },
  clickZone: { flex: 1 },
  bottomActionsContainer: { padding: 20 },
  myStoryActions: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' },
  actionBtn: { alignItems: 'center' },
  actionText: { color: 'white', fontSize: 12, marginTop: 4, fontFamily: 'Urbanist-SemiBold' },
  replyContainer: { flex: 1, flexDirection: 'row', alignItems: 'center', height: 45, borderRadius: 25, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', paddingHorizontal: 15 },
  replyInput: { flex: 1, color: 'white', fontSize: 16, marginRight: 10 },
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { height: height * 0.45, borderTopLeftRadius: 30, borderTopRightRadius: 30, padding: 20 },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#555', alignSelf: 'center', marginBottom: 15 },
  sheetTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold', textAlign: 'center', marginBottom: 20 },
  viewerItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  viewerAvatar: { width: 45, height: 45, borderRadius: 22.5, marginRight: 15 },
  highlightItem: { alignItems: 'center', marginRight: 20 },
  highlightThumb: { width: 60, height: 60, borderRadius: 30, marginBottom: 8, borderWidth: 2, borderColor: '#555' },
});
