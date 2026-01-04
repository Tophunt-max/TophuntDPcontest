import React, { useEffect, useState, useMemo } from 'react';
import { StyleSheet, FlatList, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { StoryItem } from './StoryItem';
import { fetchStories } from '@/src/services/stories/storyService';
import { auth } from '@/src/services/firebase/initFirebase';
import { StoriesSkeleton } from './StoriesSkeleton';
import { useColorScheme } from 'react-native';
import { onAuthStateChanged } from 'firebase/auth';
import { Colors } from '@/constants/theme';

export const StoriesBar: React.FC = () => {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [currentUser, setCurrentUser] = useState(auth.currentUser);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
    });
    return () => unsubscribe();
  }, []);

  const { data: userStories, isLoading } = useQuery({
    queryKey: ['stories', currentUser?.uid],
    queryFn: fetchStories,
    enabled: !!currentUser,
    staleTime: 5000, // Reduced staleTime for more frequent updates
    refetchOnWindowFocus: true,
  });

  const handleAddStory = () => {
    router.push('/story/create');
  };

  const handleViewStory = (userId: string) => {
    router.push(`/story/view/${userId}`);
  };

  const handleCurrentUserPress = (hasStories: boolean, userId: string) => {
    console.log("Handle Current User Press:", { hasStories, userId });
    if (hasStories && userId) {
      handleViewStory(userId);
    } else {
      handleAddStory();
    }
  };

  // Find current user's stories data
  const currentUserStoriesData = useMemo(() => {
    const data = userStories?.find(us => us.userId === currentUser?.uid);
    console.log("Current User Stories Data:", data ? "Found" : "Not Found", { storyCount: data?.stories?.length });
    return data;
  }, [userStories, currentUser]);

  const otherUserStories = useMemo(() => 
    userStories?.filter(us => us.userId !== currentUser?.uid) || [], 
  [userStories, currentUser]);

  if (isLoading && !userStories) {
    return <StoriesSkeleton isDark={isDark} />;
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? Colors.dark.background : Colors.light.background, borderBottomColor: isDark ? '#35383F' : '#DBDBDB' }]}>
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={otherUserStories}
        keyExtractor={(item) => item.userId}
        initialNumToRender={10}
        maxToRenderPerBatch={10}
        windowSize={5}
        removeClippedSubviews={true}
        ListHeaderComponent={
          <StoryItem 
            isCurrentUser 
            item={currentUserStoriesData} 
            onPress={() => handleCurrentUserPress(!!currentUserStoriesData && currentUserStoriesData.stories.length > 0, currentUser?.uid || '')} 
          />
        }
        renderItem={({ item }) => (
          <StoryItem 
            item={item} 
            onPress={() => handleViewStory(item.userId)} 
          />
        )}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    height: 100,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  listContent: {
    paddingHorizontal: 8,
    alignItems: 'center',
  },
});
