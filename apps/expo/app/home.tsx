import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, StyleSheet, FlatList, SafeAreaView, useColorScheme, RefreshControl, ActivityIndicator, Text } from 'react-native';
import { Header } from '@/src/components/home/Header';
import { StoriesBar } from '@/src/components/stories/StoriesBar';
import { Post } from '@/src/components/home/Post';
import { BottomNav } from '@/src/components/home/BottomNav';
import { useQueryClient } from '@tanstack/react-query';
import { PostSkeleton } from '@/src/components/home/PostSkeleton';
import { StoriesSkeleton } from '@/src/components/stories/StoriesSkeleton';
import { contestService } from '@/src/services/contests/contestService';
import { Colors } from '@/constants/theme';

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  
  const [matches, setMatches] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  const queryClient = useQueryClient();

  const loadMatches = async (isRefresh = false) => {
    if (isRefresh) setIsRefreshing(true);
    else setIsLoading(true);
    
    try {
      // Fetch naye schema ke mutabiq Active Matches
      const data = await contestService.getActiveMatches();
      setMatches(data);
    } catch (error) {
      console.error("Error loading matches:", error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadMatches();
  }, []);

  const onRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['stories'] });
    await loadMatches(true);
  }, [queryClient]);

  const renderItem = useCallback(({ item }: { item: any }) => (
    <Post item={item} isDark={isDark} />
  ), [isDark]);

  const ListHeader = useMemo(() => isLoading ? <StoriesSkeleton /> : <StoriesBar />, [isLoading]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <Header />
      <FlatList
        data={isLoading ? [1, 2, 3] : matches}
        renderItem={({ item }) => isLoading ? <PostSkeleton isDark={isDark} /> : renderItem({ item })}
        keyExtractor={(item, index) => (isLoading ? index.toString() : item.id)}
        refreshControl={
            <RefreshControl 
              refreshing={isRefreshing} 
              onRefresh={onRefresh} 
              tintColor="#FF4D67" 
              colors={["#FF4D67"]} 
            />
        }
        ListHeaderComponent={ListHeader}
        ListEmptyComponent={!isLoading ? (
          <View style={styles.emptyContainer}>
            <Text style={{ color: isDark ? '#fff' : '#000', fontFamily: 'Urbanist-Medium' }}>
              No active VS battles right now.
            </Text>
          </View>
        ) : null}
        contentContainerStyle={{ paddingBottom: 20 }}
        showsVerticalScrollIndicator={false}
      />
      <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  emptyContainer: { padding: 40, alignItems: 'center' }
});
