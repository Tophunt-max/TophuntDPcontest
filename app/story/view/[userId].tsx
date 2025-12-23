import React, { useState, useEffect, useRef } from 'react';
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
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { fetchStories, markStoryAsSeen } from '@/src/services/stories/storyService';
import { UserStories, Story } from '@/src/types/stories';

const { width, height } = Dimensions.get('window');

const STORY_DURATION = 5000;

export default function StoryView() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const [currentUserIndex, setCurrentUserIndex] = useState(0);
  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [progress, setProgress] = useState(new Animated.Value(0));
  const [isPaused, setIsPaused] = useState(false);
  
  const { data: allUserStories } = useQuery({
    queryKey: ['stories'],
    queryFn: fetchStories,
  });

  const users = allUserStories || [];
  const currentUserStories = users.find(u => u.userId === userId) || (users[0] || null);

  useEffect(() => {
    if (currentUserStories) {
      const index = users.findIndex(u => u.userId === currentUserStories.userId);
      setCurrentUserIndex(index);
    }
  }, [currentUserStories, users]);

  const currentStory = currentUserStories?.stories[currentStoryIndex];

  // Initialize video player
  const player = useVideoPlayer(currentStory?.mediaUrl || '', (player) => {
    player.loop = false;
    player.play();
  });

  useEffect(() => {
    if (currentStory) {
      markStoryAsSeen(currentStory.id);
      startAnimation();
    }
  }, [currentStoryIndex, currentUserIndex, currentStory?.id]);

  useEffect(() => {
    if (isPaused) {
      player.pause();
    } else if (currentStory?.mediaType === 'video') {
      player.play();
    }
  }, [isPaused, currentStory?.mediaType]);

  const startAnimation = () => {
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: STORY_DURATION,
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (finished) {
        nextStory();
      }
    });
  };

  const nextStory = () => {
    if (!currentUserStories) return;
    if (currentStoryIndex < currentUserStories.stories.length - 1) {
      setCurrentStoryIndex(currentStoryIndex + 1);
    } else if (currentUserIndex < users.length - 1) {
      const nextUser = users[currentUserIndex + 1];
      router.setParams({ userId: nextUser.userId });
      setCurrentStoryIndex(0);
    } else {
      router.back();
    }
  };

  const prevStory = () => {
    if (!currentUserStories) return;
    if (currentStoryIndex > 0) {
      setCurrentStoryIndex(currentStoryIndex - 1);
    } else if (currentUserIndex > 0) {
      const prevUser = users[currentUserIndex - 1];
      router.setParams({ userId: prevUser.userId });
      setCurrentStoryIndex(prevUser.stories.length - 1);
    }
  };

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        setIsPaused(true);
        progress.stopAnimation();
      },
      onPanResponderRelease: (evt, gestureState) => {
        setIsPaused(false);
        if (gestureState.dy > 50) {
          router.back();
        } else if (evt.nativeEvent.locationX < width / 3) {
          prevStory();
        } else {
          nextStory();
        }
      },
    })
  ).current;

  if (!currentUserStories || !currentStory) return null;

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      <StatusBar hidden />
      
      {currentStory.mediaType === 'image' ? (
        <Image
          source={{ uri: currentStory.mediaUrl }}
          style={styles.media}
          contentFit="cover"
        />
      ) : (
        <VideoView
          player={player}
          style={styles.media}
          contentFit="cover"
        />
      )}

      <SafeAreaView style={styles.overlay}>
        <View style={styles.header}>
          <View style={styles.progressContainer}>
            {currentUserStories.stories.map((_, index) => (
              <View key={index} style={styles.progressBackground}>
                <Animated.View
                  style={[
                    styles.progressBar,
                    {
                      width:
                        index < currentStoryIndex
                          ? '100%'
                          : index === currentStoryIndex
                          ? progress.interpolate({
                              inputRange: [0, 1],
                              outputRange: ['0%', '100%'],
                            })
                          : '0%',
                    },
                  ]}
                />
              </View>
            ))}
          </View>
          
          <View style={styles.userInfo}>
            <Image source={{ uri: currentUserStories.avatarUrl }} style={styles.avatar} />
            <Text style={styles.username}>{currentUserStories.username}</Text>
            <Pressable onPress={() => router.back()} style={styles.closeButton}>
              <Ionicons name="close" size={28} color="white" />
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  media: {
    width: width,
    height: height,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  header: {
    paddingHorizontal: 10,
    paddingTop: 10,
  },
  progressContainer: {
    flexDirection: 'row',
    height: 2,
    marginBottom: 10,
  },
  progressBackground: {
    flex: 1,
    height: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    marginHorizontal: 2,
    borderRadius: 1,
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    backgroundColor: '#FFF',
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginRight: 10,
  },
  username: {
    color: '#FFF',
    fontSize: 14,
    fontFamily: 'Urbanist-Bold',
    flex: 1,
  },
  closeButton: {
    padding: 5,
  },
});
