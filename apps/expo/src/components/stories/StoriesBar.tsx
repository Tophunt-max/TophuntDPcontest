import React, { useEffect, useState, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Stories as OptimizedStories } from '@/src/components/home/Stories';
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
  const textColor = isDark ? '#FFFFFF' : '#000000';
  const [currentUser, setCurrentUser] = useState(auth.currentUser);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
    });
    return () => unsubscribe();
  }, []);

  const { 
    data, 
    isLoading, 
    fetchNextPage, 
    hasNextPage, 
    isFetchingNextPage 
  } = useInfiniteQuery({
    queryKey: ['stories', currentUser?.uid],
    queryFn: ({ pageParam }) => fetchStories(pageParam),
    getNextPageParam: (lastPage) => lastPage.lastDoc,
    enabled: !!currentUser,
    staleTime: 60 * 1000, // 1 minute cache
    refetchOnWindowFocus: true,
  });

  const userStories = data?.pages.flatMap(page => page.userStories) || [];

  const transformedStories = useMemo(() => {
    const storiesList: any[] = [];
    const myStories = userStories.find(s => s.userId === currentUser?.uid);

    storiesList.push({
      id: currentUser?.uid || 'me',
      user: 'You',
      avatar: currentUser?.photoURL || 'https://ui-avatars.com/api/?name=You',
      isSelf: true,
      hasStory: myStories && myStories.stories.length > 0,
      seen: false, 
    });

    userStories.filter(s => s.userId !== currentUser?.uid).forEach(story => {
      const isSeen = !story.hasUnseen;
      storiesList.push({
        id: story.userId,
        user: story.username || 'User',
        avatar: story.avatarUrl,
        isSelf: false,
        hasStory: true,
        seen: isSeen,
      });
    });

    return storiesList;
  }, [userStories, currentUser]);

  if (isLoading && !userStories.length) {
    return <StoriesSkeleton isDark={isDark} />;
  }

  return (
    <View style={[styles.container, { 
        backgroundColor: isDark ? Colors.dark.background : Colors.light.background, 
    }]}>
      <OptimizedStories 
        stories={transformedStories} 
        textColor={textColor} 
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) {
            fetchNextPage();
          }
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingVertical: 10,
  },
});
