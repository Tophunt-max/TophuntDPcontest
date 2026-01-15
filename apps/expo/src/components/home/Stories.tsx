import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import { 
    View, 
    Text, 
    StyleSheet, 
    FlatList, 
    Image, 
    TouchableOpacity, 
    Platform 
} from 'react-native';
import { StoryAddIcon } from '@/assets/svgs';
import { useRouter } from 'expo-router';
import { Image as ExpoImage } from 'expo-image'; // High performance image component
import { LinearGradient } from 'expo-linear-gradient'; // For the ring gradient

interface Story {
    id: string;
    user: string;
    avatar: any;
    isSelf?: boolean;
    hasStory?: boolean;
    seen?: boolean; // Track seen state
}

interface StoriesProps {
    stories: Story[];
    textColor: string;
}

const STORY_RING_COLORS = ['#feda75', '#fa7e1e', '#d62976', '#962fbf', '#4f5bd5'];
const SEEN_RING_COLORS = ['#e0e0e0', '#e0e0e0'];

// Memoized Story Item for performance
const StoryItem = memo(({ item, textColor, onPress }: { item: Story; textColor: string; onPress: (item: Story) => void }) => {
    // Determine ring colors based on seen state
    const gradientColors = item.isSelf && !item.hasStory 
      ? ['transparent', 'transparent'] 
      : (item.seen ? SEEN_RING_COLORS : STORY_RING_COLORS);

    return (
      <TouchableOpacity 
          style={styles.storyContainer} 
          onPress={() => onPress(item)}
          activeOpacity={0.9}
      >
          <LinearGradient
              colors={gradientColors}
              start={{x: 0, y: 1}} 
              end={{x: 1, y: 0}}
              style={styles.storyRing}
          >
              <View style={styles.avatarContainer}>
                  <ExpoImage 
                      source={item.avatar} 
                      style={styles.storyAvatar} 
                      cachePolicy="memory-disk" 
                      contentFit="cover"
                      transition={200}
                      // Add a blurhash placeholder for perceived performance
                      placeholder={item.isSelf ? null : "L184i9ofbHof00ayjsay~qj[ayj["} 
                  />
              </View>
              {item.isSelf && (
                  <View style={styles.addStoryBadge}>
                      <StoryAddIcon width={20} height={20} />
                  </View>
              )}
          </LinearGradient>
          <Text style={[styles.storyUsername, { color: textColor }]} numberOfLines={1}>
              {item.isSelf ? "Your Story" : item.user}
          </Text>
      </TouchableOpacity>
    );
}, (prevProps, nextProps) => {
    // Custom comparison to prevent unnecessary re-renders
    return prevProps.item.id === nextProps.item.id && 
           prevProps.item.seen === nextProps.item.seen &&
           prevProps.item.hasStory === nextProps.item.hasStory &&
           prevProps.textColor === nextProps.textColor &&
           prevProps.item.avatar === nextProps.item.avatar;
});

export const Stories = memo(({ stories, textColor }: StoriesProps) => {
  const router = useRouter();

  const handleStoryPress = useCallback((item: Story) => {
      if (item.isSelf && !item.hasStory) {
          router.push('/story/create');
      } else {
          router.push({
              pathname: '/story/view/[userId]',
              params: { userId: item.id }
          });
      }
  }, [router]);
    
  const renderStory = useCallback(({ item }: { item: Story }) => {
      return <StoryItem item={item} textColor={textColor} onPress={handleStoryPress} />;
  }, [textColor, handleStoryPress]);

  return (
    <View style={styles.storiesListContainer}>
        <FlatList 
            data={stories}
            renderItem={renderStory}
            keyExtractor={item => item.id}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.storiesContent}
            initialNumToRender={6}
            maxToRenderPerBatch={6}
            windowSize={3}
            removeClippedSubviews={Platform.OS === 'android'}
            // Optimization for constant height items
            getItemLayout={(data, index) => ({
                length: 88, // 72 width + 16 margin
                offset: 88 * index,
                index,
            })}
        />
    </View>
  );
});

const styles = StyleSheet.create({
  storiesListContainer: {
      marginBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: 'rgba(0,0,0,0.05)',
      paddingBottom: 10,
      paddingTop: 5,
  },
  storiesContent: {
      paddingHorizontal: 16,
  },
  storyContainer: {
      alignItems: 'center',
      marginRight: 16,
      width: 72,
  },
  storyRing: {
      width: 72,
      height: 72,
      borderRadius: 36,
      padding: 2.5, // Ring thickness
      marginBottom: 4,
      justifyContent: 'center',
      alignItems: 'center',
  },
  avatarContainer: {
      width: 65,
      height: 65,
      borderRadius: 32.5,
      borderWidth: 2,
      borderColor: '#fff', // White gap between ring and image
      overflow: 'hidden',
      backgroundColor: '#f0f0f0',
  },
  storyAvatar: {
      width: '100%',
      height: '100%',
  },
  addStoryBadge: {
      position: 'absolute',
      bottom: 2,
      right: 2,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: '#fff',
      borderRadius: 12,
  },
  storyUsername: {
      fontSize: 11,
      fontFamily: 'Urbanist-Regular',
      textAlign: 'center',
      width: '100%',
  },
});
