import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, StyleSheet, FlatList, SafeAreaView, useColorScheme, RefreshControl, ActivityIndicator, Text } from 'react-native';
import { Header } from '@/src/components/home/Header';
import { StoriesBar } from '@/src/components/stories/StoriesBar';
import { Post } from '@/src/components/home/Post';
import { BottomNav } from '@/src/components/home/BottomNav';
import { useQueryClient } from '@tanstack/react-query';
import { PostSkeleton } from '@/src/components/home/PostSkeleton';
import { contestService } from '@/src/services/contests/contestService';
import { Battle } from '@/src/types/contest';

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? '#181A20' : '#fff';
  
  const [battles, setBattles] = useState<Battle[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  const queryClient = useQueryClient();

  const loadBattles = async (isRefresh = false) => {
    if (isRefresh) setIsRefreshing(true);
    else setIsLoading(true);
    
    try {
      const data = await contestService.getActiveBattles();
      setBattles(data);
    } catch (error) {
      console.error("Error loading battles:", error);
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    loadBattles();
  }, []);

  const onRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['stories'] });
    await loadBattles(true);
  }, [queryClient]);

  const renderItem = useCallback(({ item }: { item: Battle }) => (
    <Post item={item} isDark={isDark} />
  ), [isDark]);

  const ListHeader = useMemo(() => <StoriesBar />, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <Header />
      {isLoading ? (
        <View style={{ flex: 1 }}>
            <StoriesBar />
            <FlatList
                data={[1, 2, 3]}
                renderItem={() => <PostSkeleton isDark={isDark} />}
                keyExtractor={item => item.toString()}
            />
        </View>
      ) : (
        <FlatList
            data={battles}
            renderItem={renderItem}
            keyExtractor={(item) => item.id}
            refreshControl={
                <RefreshControl 
                  refreshing={isRefreshing} 
                  onRefresh={onRefresh} 
                  tintColor="#FF4D67" 
                  colors={["#FF4D67"]} 
                />
            }
            ListHeaderComponent={ListHeader}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={{ color: isDark ? '#fff' : '#000', fontFamily: 'Urbanist-Medium' }}>
                  No active VS battles right now.
                </Text>
              </View>
            }
            contentContainerStyle={{ paddingBottom: 20 }}
            showsVerticalScrollIndicator={false}
        />
      )}
      <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  emptyContainer: { padding: 40, alignItems: 'center' }
});
