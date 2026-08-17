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
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@/src/lib/icons';
import { fetchHighlightStories, fetchStoryViewers } from '@/src/services/stories/storyService';
import { auth } from '@/src/services/firebase/initFirebase';

const { width, height } = Dimensions.get('window');
const DEFAULT_STORY_DURATION = 5000;

export default function HighlightView() {
  const { userId, highlightId } = useLocalSearchParams<{ userId: string, highlightId: string }>();
  const router = useRouter();
  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [progress] = useState(new Animated.Value(0));
  const [isPaused, setIsPaused] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [duration, setDuration] = useState(DEFAULT_STORY_DURATION);
  const [highlightData, setHighlightData] = useState<any>(null);
  
  // Viewers Logic
  const [showViewers, setShowViewers] = useState(false);
  const [viewers, setViewers] = useState<any[]>([]);
  const [loadingViewers, setLoadingViewers] = useState(false);
  const viewersTranslateY = useRef(new Animated.Value(height)).current;

  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const progressValue = useRef(0);

  useEffect(() => {
      if (userId && highlightId) {
          loadHighlight();
      }
  }, [userId, highlightId]);

  const loadHighlight = async () => {
      const data = await fetchHighlightStories(userId, highlightId);
      if (data) {
          setHighlightData(data);
      } else {
          router.back();
      }
  };

  const stories = highlightData?.stories || [];
  const currentStory = stories[currentStoryIndex];
  const isMyProfile = userId === auth.currentUser?.uid;

  const player = useVideoPlayer(currentStory?.mediaType === 'video' ? currentStory.mediaUrl : '', (player) => {
    player.loop = false;
  });

  const nextStory = useCallback(() => {
    if (currentStoryIndex < stories.length - 1) {
      setCurrentStoryIndex(prev => prev + 1);
    } else {
      router.back();
    }
  }, [currentStoryIndex, stories]);

  const prevStory = useCallback(() => {
    if (currentStoryIndex > 0) {
      setCurrentStoryIndex(prev => prev - 1);
    }
  }, [currentStoryIndex]);

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
      setIsLoading(true);
      if (currentStory.mediaType === 'image') {
        setDuration(DEFAULT_STORY_DURATION);
        setIsLoading(false);
        startAnimation(DEFAULT_STORY_DURATION);
      }
      if (isMyProfile) {
          loadViewers(currentStory.id);
      }
    }
  }, [currentStoryIndex, currentStory]);

  const loadViewers = async (id: string) => {
      setLoadingViewers(true);
      const data = await fetchStoryViewers(id);
      setViewers(data);
      setLoadingViewers(false);
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

  useEffect(() => {
    if (currentStory?.mediaType === 'video') {
        const subscription = player.addListener('statusChange', (status) => {
            if (status.status === 'readyToPlay') {
                const videoDuration = (player.duration || 5) * 1000;
                setDuration(videoDuration);
                setIsLoading(false);
                if (!isPaused) {
                    player.play();
                    startAnimation(videoDuration);
                }
            }
        });
        return () => subscription.remove();
    }
  }, [currentStory, player, isPaused]);

  useEffect(() => {
    if (isPaused) {
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
  }, [isPaused, showViewers]);

  const mainPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => setIsPaused(true),
      onPanResponderMove: (evt, gestureState) => {
          if (isMyProfile && gestureState.dy < -20) {
              toggleViewers(true);
          }
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (showViewers) return;
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

  if (!highlightData || !currentStory) return null;

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      <View style={styles.mediaContainer} {...mainPanResponder.panHandlers}>
        {currentStory.mediaType === 'image' ? (
            <Image source={{ uri: currentStory.mediaUrl }} style={styles.media} contentFit="contain" />
        ) : (
            <VideoView player={player} style={styles.media} contentFit="contain" />
        )}
        {isLoading && <View style={styles.loader}><ActivityIndicator size="large" color="white" /></View>}
      </View>

      <SafeAreaView style={styles.overlay} pointerEvents="none">
        <View style={styles.header}>
          <View style={styles.progressContainer}>
            {stories.map((_: any, index: number) => (
              <View key={index} style={styles.progressBackground}>
                <Animated.View style={[styles.progressBar, { width: index < currentStoryIndex ? '100%' : index === currentStoryIndex ? progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) : '0%' }]} />
              </View>
            ))}
          </View>
          <View style={styles.userInfo}>
            <Image source={{ uri: highlightData.avatarUrl }} style={styles.avatar} />
            <View style={styles.userTextContainer}>
                <Text style={styles.username}>{highlightData.username}</Text>
                <Text style={styles.timeAgo}>{highlightData.name}</Text>
            </View>
            <Pressable pointerEvents="auto" onPress={() => router.back()} style={styles.closeButton}><Ionicons name="close" size={28} color="white" /></Pressable>
          </View>
        </View>

        {isMyProfile && !showViewers && (
            <View style={styles.bottomActions}>
                <Pressable pointerEvents="auto" style={styles.actionBtn} onPress={() => toggleViewers(true)}>
                    <Ionicons name="eye-outline" size={24} color="white" />
                    <Text style={styles.actionText}>{viewers.length}</Text>
                </Pressable>
            </View>
        )}
      </SafeAreaView>

      {/* Viewers Sheet */}
      <Animated.View 
        style={[styles.viewersSheet, { transform: [{ translateY: viewersTranslateY }] }]}
        {...sheetPanResponder.panHandlers}
      >
          <View style={styles.sheetHeader}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>Viewers ({viewers.length})</Text>
              <Pressable onPress={() => toggleViewers(false)} style={styles.sheetClose}>
                  <Ionicons name="close-circle" size={24} color="#666" />
              </Pressable>
          </View>
          <FlatList
              data={viewers}
              keyExtractor={(item, index) => `${item.uid}_${index}`}
              renderItem={({ item }) => (
                  <View style={styles.viewerItem}>
                      <Image source={{ uri: item.avatarUrl }} style={styles.viewerAvatar} />
                      <Text style={styles.viewerName}>{item.username}</Text>
                      <Text style={styles.viewTime}>
                          {item.viewedAt ? new Date(item.viewedAt.seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                      </Text>
                  </View>
              )}
              ListEmptyComponent={<Text style={styles.emptyText}>No views yet</Text>}
              contentContainerStyle={{ paddingBottom: 50 }}
          />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  mediaContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  media: { width: width, height: height },
  loader: { position: 'absolute' },
  overlay: { ...StyleSheet.absoluteFillObject },
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
  bottomActions: { position: 'absolute', bottom: 40, width: '100%', alignItems: 'center' },
  actionBtn: { alignItems: 'center' },
  actionText: { color: 'white', fontSize: 12, marginTop: 4, fontFamily: 'Urbanist-Medium' },
  viewersSheet: { position: 'absolute', left: 0, right: 0, height: height * 0.6, backgroundColor: 'white', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, zIndex: 100 },
  sheetHeader: { alignItems: 'center', marginBottom: 20 },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#DDD', marginBottom: 10 },
  sheetTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold', color: '#000' },
  sheetClose: { position: 'absolute', right: 0, top: 0 },
  viewerItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  viewerAvatar: { width: 45, height: 45, borderRadius: 22.5, marginRight: 12 },
  viewerName: { flex: 1, fontSize: 16, fontFamily: 'Urbanist-SemiBold', color: '#000' },
  viewTime: { fontSize: 12, color: '#666' },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 50, fontFamily: 'Urbanist-Medium' },
});
