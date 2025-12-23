import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, StyleSheet, FlatList, SafeAreaView, useColorScheme, RefreshControl, ActivityIndicator } from 'react-native';
import { Header } from '@/src/components/home/Header';
import { StoriesBar } from '@/src/components/stories/StoriesBar';
import { Post } from '@/src/components/home/Post';
import { BottomNav } from '@/src/components/home/BottomNav';
import { useQueryClient } from '@tanstack/react-query';
import { PostSkeleton } from '@/src/components/home/PostSkeleton';

// Initial Mock Data
const INITIAL_POSTS = [
  {
    id: '1',
    user: { name: 'John Doe', avatar: 'https://ui-avatars.com/api/?name=John+Doe&background=random' },
    name1: 'Alex Smith',
    avatar1: 'https://i.pravatar.cc/150?u=alex',
    name2: 'David Miller',
    avatar2: 'https://i.pravatar.cc/150?u=david',
    image1: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=500', 
    image2: 'https://images.unsplash.com/photo-1449824913935-59a10b8d2000?w=500', 
    votes1: 32500, votes2: 28100, pollEndsAt: '04:32:17', likesCount: 44389, commentsCount: 19377, sharesCount: 8240, time: '2 hours ago', isLiked: false, isSaved: false,
  },
  {
    id: '2',
    user: { name: 'Sarah Parker', avatar: 'https://ui-avatars.com/api/?name=Sarah+Parker&background=random' },
    name1: 'Emma Wilson',
    avatar1: 'https://i.pravatar.cc/150?u=emma',
    name2: 'Sophia Lane',
    avatar2: 'https://i.pravatar.cc/150?u=sophia',
    image1: 'https://images.unsplash.com/photo-1513542789411-b6a5d4f31634?w=500',
    image2: 'https://images.unsplash.com/photo-1511467687858-23d96c32e4ae?w=500',
    votes1: 15420, votes2: 12100, pollEndsAt: '12:15:30', likesCount: 12030, commentsCount: 840, sharesCount: 150, time: '5 hours ago', isLiked: true, isSaved: true,
  }
];

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? '#181A20' : '#fff';
  
  const [posts, setPosts] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  
  const queryClient = useQueryClient();

  useEffect(() => {
    // Simulated fetch
    const loadInitial = setTimeout(() => {
      setPosts(INITIAL_POSTS);
      setIsLoading(false);
    }, 500); // Reduced delay
    return () => clearTimeout(loadInitial);
  }, []);

  const onRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ['stories'] });
    // Simulated refresh
    setTimeout(() => {
      setPosts(INITIAL_POSTS);
      setIsRefreshing(false);
    }, 500);
  }, [queryClient]);

  const loadMore = useCallback(() => {
    if (isFetchingMore || isLoading) return;
    setIsFetchingMore(true);
    setTimeout(() => {
      const morePosts = INITIAL_POSTS.map(p => ({
        ...p,
        id: Math.random().toString(36).substring(7),
        time: 'Just now'
      }));
      setPosts(prev => [...prev, ...morePosts]);
      setIsFetchingMore(false);
    }, 1000);
  }, [isFetchingMore, isLoading]);

  const renderItem = useCallback(({ item }: any) => (
    <Post item={item} isDark={isDark} />
  ), [isDark]);

  const keyExtractor = useCallback((item: any) => item.id, []);

  const ListHeader = useMemo(() => <StoriesBar />, []);

  const renderFooter = useCallback(() => {
    if (!isFetchingMore) return <View style={{ height: 20 }} />;
    return (
      <View style={{ paddingVertical: 20 }}>
        <PostSkeleton isDark={isDark} />
      </View>
    );
  }, [isFetchingMore, isDark]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <Header />
      {isLoading ? (
        <View style={{ flex: 1 }}>
            <StoriesBar />
            <FlatList
                data={[1, 2]}
                renderItem={() => <PostSkeleton isDark={isDark} />}
                keyExtractor={item => item.toString()}
            />
        </View>
      ) : (
        <FlatList
            data={posts}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            refreshControl={
                <RefreshControl 
                  refreshing={isRefreshing} 
                  onRefresh={onRefresh} 
                  tintColor="#FF4D67" 
                  colors={["#FF4D67"]} 
                />
            }
            ListHeaderComponent={ListHeader}
            onEndReached={loadMore}
            onEndReachedThreshold={0.5}
            ListFooterComponent={renderFooter}
            contentContainerStyle={{ paddingBottom: 20 }}
            showsVerticalScrollIndicator={false}
            removeClippedSubviews={true} // Performance optimization
            maxToRenderPerBatch={10} // Performance optimization
            windowSize={5} // Performance optimization
            initialNumToRender={5} // Performance optimization
        />
      )}
      <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
