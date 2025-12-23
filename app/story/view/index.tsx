import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, Image, TouchableOpacity, Animated, Dimensions, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

const { width, height } = Dimensions.get('window');
const STORY_DURATION = 5000;

// Custom SVG for Close Icon
const CloseIcon = ({ color = "white", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M18 6L6 18M6 6L18 18" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// Custom SVG for Paper Plane (Share) Icon
const PaperPlaneIcon = ({ color = "white", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M22 2L11 13M22 2L15 22L11 13M11 13L2 9L22 2" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// Custom SVG for Heart (Like) Icon
const HeartIcon = ({ color = "white", size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export default function ViewStoryScreen() {
  const router = useRouter();
  const progress = useRef(new Animated.Value(0)).current;
  
  const stories = [
      {
          id: '1',
          image: require('../../../assets/images/onBordingLight1.png'), 
          user: 'Your Story',
          time: '2h',
      },
      {
          id: '2',
          image: require('../../../assets/images/onBordingLight2.png'),
          user: 'Your Story',
          time: '1h',
      }
  ];

  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const currentStory = stories[currentStoryIndex];

  useEffect(() => {
      startProgress();
  }, [currentStoryIndex]);

  const startProgress = () => {
      progress.setValue(0);
      Animated.timing(progress, {
          toValue: 1,
          duration: STORY_DURATION,
          useNativeDriver: false,
      }).start(({ finished }) => {
          if (finished) {
              handleNext();
          }
      });
  };

  const handleNext = () => {
      if (currentStoryIndex < stories.length - 1) {
          setCurrentStoryIndex(currentStoryIndex + 1);
      } else {
          router.back();
      }
  };

  const handlePrevious = () => {
      if (currentStoryIndex > 0) {
          setCurrentStoryIndex(currentStoryIndex - 1);
      } else {
          startProgress();
      }
  };

  const widthInterpolated = progress.interpolate({
      inputRange: [0, 1],
      outputRange: ['0%', '100%'],
  });

  return (
    <SafeAreaView style={styles.container}>
      {/* Story Content */}
      <View style={styles.storyContainer}>
          <Image 
            source={currentStory.image} 
            style={styles.storyImage} 
            resizeMode="contain" 
          />
      </View>

      {/* Overlays */}
      <View style={styles.overlayContainer}>
          {/* Progress Bars */}
          <View style={styles.progressContainer}>
              {stories.map((story, index) => (
                  <View key={story.id} style={styles.progressBar}>
                      <Animated.View 
                          style={[
                              styles.progressIndicator, 
                              { 
                                  width: index === currentStoryIndex ? widthInterpolated : 
                                         index < currentStoryIndex ? '100%' : '0%' 
                              }
                          ]} 
                      />
                  </View>
              ))}
          </View>

          {/* Header */}
          <View style={styles.header}>
              <View style={styles.userInfo}>
                  <Image source={require('../../../assets/images/userLight.png')} style={styles.avatar} />
                  <Text style={styles.username}>
                    {currentStory.user} <Text style={styles.time}>{currentStory.time}</Text>
                  </Text>
              </View>
              <TouchableOpacity onPress={() => router.back()} style={styles.closeBtn}>
                  {Platform.OS === 'web' ? <CloseIcon size={24} /> : <Text style={{color: 'white', fontSize: 24, fontWeight: 'bold'}}>✕</Text>}
              </TouchableOpacity>
          </View>

          {/* Tappable Areas */}
          <View style={styles.tapContainer}>
              <TouchableOpacity style={styles.tapArea} onPress={handlePrevious} />
              <TouchableOpacity style={styles.tapArea} onPress={handleNext} />
          </View>

          {/* Footer */}
          <View style={styles.footer}>
              <View style={styles.replyInput}>
                  <Text style={styles.replyPlaceholder}>Send message</Text>
              </View>
              <TouchableOpacity style={styles.actionIcon}>
                  {Platform.OS === 'web' ? <HeartIcon size={26} /> : <Text style={{color: 'white', fontSize: 24}}>♡</Text>}
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionIcon}>
                  {Platform.OS === 'web' ? <PaperPlaneIcon size={26} /> : <Text style={{color: 'white', fontSize: 24}}>✈</Text>}
              </TouchableOpacity>
          </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
  },
  storyContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'black',
    justifyContent: 'center',
    alignItems: 'center',
  },
  storyImage: {
    width: Platform.OS === 'web' ? '100%' : width,
    height: Platform.OS === 'web' ? '100%' : height,
    maxWidth: Platform.OS === 'web' ? 500 : undefined,
  },
  overlayContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },
  progressContainer: {
      flexDirection: 'row',
      paddingHorizontal: 10,
      marginTop: 10,
      gap: 5,
      height: 2,
  },
  progressBar: {
      flex: 1,
      height: 2,
      backgroundColor: 'rgba(255,255,255,0.3)',
      borderRadius: 1,
      overflow: 'hidden',
  },
  progressIndicator: {
      height: '100%',
      backgroundColor: 'white',
  },
  header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 15,
      paddingVertical: 15,
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
      backgroundColor: '#333',
  },
  username: {
      color: 'white',
      fontWeight: '600',
      fontSize: 14,
      fontFamily: Platform.OS === 'web' ? 'sans-serif' : 'Urbanist-SemiBold',
  },
  time: {
      fontWeight: '400',
      color: 'rgba(255,255,255,0.7)',
  },
  closeBtn: {
      padding: 5,
  },
  footer: {
      position: 'absolute',
      bottom: 20,
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 15,
  },
  replyInput: {
      flex: 1,
      height: 44,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.5)',
      borderRadius: 22,
      justifyContent: 'center',
      paddingHorizontal: 20,
  },
  replyPlaceholder: {
      color: 'white',
      fontSize: 14,
      opacity: 0.8,
  },
  actionIcon: {
      marginLeft: 15,
      justifyContent: 'center',
      alignItems: 'center',
  },
  tapContainer: {
      flex: 1,
      flexDirection: 'row',
  },
  tapArea: {
      flex: 1,
  },
});
