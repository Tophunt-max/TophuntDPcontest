import React from 'react';
import { StyleSheet, Text, View, Pressable, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { UserStories } from '@/src/types/stories';
import AddIcon from '@/assets/svgs/add_Icon.svg';
import { auth } from '@/src/services/firebase/initFirebase';
import { useRouter } from 'expo-router';
import { useColorScheme } from 'react-native';

interface StoryItemProps {
  item?: UserStories;
  isCurrentUser?: boolean;
  onPress: () => void;
}

export const StoryItem: React.FC<StoryItemProps> = ({ item, isCurrentUser, onPress }) => {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const username = isCurrentUser ? 'Your story' : item?.username;
  const avatarUrl = item?.avatarUrl || (isCurrentUser ? auth.currentUser?.photoURL : null);
  const hasUnseen = item?.hasUnseen;
  const hasStories = !!item && item.stories.length > 0;

  const handleAddStory = () => {
    router.push('/story/create');
  };

  const renderAvatarRing = () => {
    if (hasStories && hasUnseen) {
      // Unseen Story - Gradient Ring (Original Style)
      return (
        <LinearGradient
          colors={['#CA1D7E', '#E35157', '#F2703F']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.ring}
        >
          <View style={[styles.innerRing, isDark && styles.innerRingDark]}>
            <Image source={{ uri: avatarUrl }} style={styles.avatar} />
          </View>
        </LinearGradient>
      );
    } else if (hasStories && !hasUnseen) {
      // Seen Story - Grey Ring
      return (
        <View style={[styles.ring, styles.seenRing, isDark && styles.seenRingDark]}>
           <View style={[styles.innerRing, isDark && styles.innerRingDark]}>
              <Image source={{ uri: avatarUrl }} style={styles.avatar} />
           </View>
        </View>
      );
    } else {
      // No Story - No Ring
      return (
        <View style={styles.ring}>
           <Image 
             source={{ uri: avatarUrl || 'https://ui-avatars.com/api/?name=U' }} 
             style={styles.avatarNoRing} 
           />
        </View>
      );
    }
  };

  return (
    <Pressable onPress={onPress} style={styles.container}>
      <View style={styles.avatarContainer}>
        {renderAvatarRing()}
        
        {isCurrentUser && (
          <TouchableOpacity style={[styles.addButton, isDark && styles.addButtonDark]} onPress={handleAddStory}>
            <AddIcon width={20} height={20} />
          </TouchableOpacity>
        )}
      </View>
      <Text style={[styles.username, isDark && styles.usernameDark]} numberOfLines={1}>
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
    justifyContent: 'center',
    alignItems: 'center',
    height: 72, 
    width: 72,
  },
  ring: {
    width: 68,
    height: 68,
    borderRadius: 34,
    justifyContent: 'center',
    alignItems: 'center',
  },
  seenRing: {
    borderWidth: 1.5,
    borderColor: '#DBDBDB',
  },
  seenRingDark: {
      borderColor: '#35383F',
  },
  innerRing: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: '#FFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  innerRingDark: {
      backgroundColor: '#181A20',
  },
  avatar: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#EEE',
  },
  avatarNoRing: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#EEE',
  },
  username: {
    fontSize: 12,
    fontFamily: 'Urbanist-Regular',
    color: '#262626',
    textAlign: 'center',
  },
  usernameDark: {
      color: '#FFF',
  },
  addButton: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    backgroundColor: '#FFF',
    borderRadius: 12,
    padding: 2,
    zIndex: 10,
    borderWidth: 2,
    borderColor: '#FFF',
  },
  addButtonDark: {
      backgroundColor: '#181A20',
      borderColor: '#181A20',
  }
});
