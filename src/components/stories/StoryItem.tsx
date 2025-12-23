import React from 'react';
import { StyleSheet, Text, View, Pressable, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { UserStories } from '@/src/types/stories';
import AddIcon from '@/assets/svgs/add_Icon.svg';
import { auth } from '@/src/services/firebase/initFirebase';
import { useRouter } from 'expo-router';

interface StoryItemProps {
  item?: UserStories;
  isCurrentUser?: boolean;
  onPress: () => void;
}

export const StoryItem: React.FC<StoryItemProps> = ({ item, isCurrentUser, onPress }) => {
  const router = useRouter();
  const username = isCurrentUser ? 'Your story' : item?.username;
  const avatarUrl = item?.avatarUrl || (isCurrentUser ? auth.currentUser?.photoURL : null);
  const hasUnseen = item?.hasUnseen;
  const hasStories = !!item && item.stories.length > 0;

  const handleAddStory = () => {
    router.push('/story/create');
  };

  const renderAvatarRing = () => {
    if (hasStories && hasUnseen) {
      // Unseen Story - Gradient Ring
      return (
        <LinearGradient
          colors={['#CA1D7E', '#E35157', '#F2703F']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.ring}
        >
          <View style={styles.innerRing}>
            <Image source={{ uri: avatarUrl }} style={styles.avatar} />
          </View>
        </LinearGradient>
      );
    } else if (hasStories && !hasUnseen) {
      // Seen Story - Grey Ring
      return (
        <View style={[styles.ring, styles.seenRing]}>
           <Image source={{ uri: avatarUrl }} style={styles.avatar} />
        </View>
      );
    } else {
      // No Story - No Ring (or transparent)
      return (
        <View style={styles.ring}>
           <Image source={{ uri: avatarUrl }} style={styles.avatar} />
        </View>
      );
    }
  };

  return (
    <Pressable onPress={onPress} style={styles.container}>
      <View style={styles.avatarContainer}>
        {renderAvatarRing()}
        
        {/* Always show Add Button for Current User */}
        {isCurrentUser && (
          <TouchableOpacity style={styles.addButton} onPress={handleAddStory}>
            <AddIcon width={20} height={20} />
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.username} numberOfLines={1}>
        {username}
      </Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    marginHorizontal: 8,
    width: 72,
  },
  avatarContainer: {
    position: 'relative',
    marginBottom: 4,
  },
  ring: {
    width: 68,
    height: 68,
    borderRadius: 34,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 0,
    borderColor: 'transparent',
  },
  seenRing: {
    borderWidth: 1,
    borderColor: '#DBDBDB',
  },
  innerRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#FFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#EEE',
  },
  username: {
    fontSize: 12,
    fontFamily: 'Urbanist-Regular',
    color: '#262626',
    textAlign: 'center',
  },
  addButton: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: '#FFF',
    borderRadius: 10,
    padding: 2,
    zIndex: 10,
  },
});
