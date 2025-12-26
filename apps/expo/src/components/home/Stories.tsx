import React from 'react';
import { View, Text, StyleSheet, FlatList, Image, TouchableOpacity } from 'react-native';
import { StoryAddIcon } from '@/assets/svgs';
import { useRouter } from 'expo-router';

interface Story {
    id: string;
    user: string;
    avatar: any;
    isSelf?: boolean;
    hasStory?: boolean;
}

interface StoriesProps {
    stories: Story[];
    textColor: string;
}

export const Stories = ({ stories, textColor }: StoriesProps) => {
  const router = useRouter();

  const handleStoryPress = (item: Story) => {
      if (item.isSelf) {
          router.push('/story/create');
      } else {
          router.push('/story/view');
      }
  };
    
  const renderStory = ({ item }: { item: Story }) => (
      <TouchableOpacity style={styles.storyContainer} onPress={() => handleStoryPress(item)}>
          <View style={[styles.storyRing, item.hasStory && styles.storyRingActive, item.isSelf && styles.storyRingSelf]}>
              <Image source={item.avatar} style={styles.storyAvatar} />
              {item.isSelf && (
                  <View style={styles.addStoryBadge}>
                      <StoryAddIcon width={20} height={20} />
                  </View>
              )}
          </View>
          <Text style={[styles.storyUsername, { color: textColor }]} numberOfLines={1}>
              {item.user}
          </Text>
      </TouchableOpacity>
  );

  return (
    <View style={styles.storiesListContainer}>
        <FlatList 
            data={stories}
            renderItem={renderStory}
            keyExtractor={item => item.id}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.storiesContent}
        />
    </View>
  );
};

const styles = StyleSheet.create({
  storiesListContainer: {
      marginBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: '#f0f0f0',
      paddingBottom: 10,
  },
  storiesContent: {
      paddingHorizontal: 16,
  },
  storyContainer: {
      alignItems: 'center',
      marginRight: 16,
      width: 70,
  },
  storyRing: {
      width: 68,
      height: 68,
      borderRadius: 34,
      padding: 2,
      borderWidth: 2,
      borderColor: 'transparent',
      marginBottom: 4,
      justifyContent: 'center',
      alignItems: 'center',
  },
  storyRingActive: {
      borderColor: '#ff4466', // Brand color ring
  },
  storyRingSelf: {
      borderColor: 'transparent',
  },
  storyAvatar: {
      width: 60,
      height: 60,
      borderRadius: 30,
      borderWidth: 2,
      borderColor: '#fff',
  },
  addStoryBadge: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      justifyContent: 'center',
      alignItems: 'center',
  },
  storyUsername: {
      fontSize: 11,
      fontFamily: 'Urbanist-Regular',
      textAlign: 'center',
  },
});
