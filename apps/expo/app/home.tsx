import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, StyleSheet, FlatList, useColorScheme, RefreshControl, Text, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Header } from '@/src/components/home/Header';
import { StoriesBar } from '@/src/components/stories/StoriesBar';
import { PostCard } from '@/src/components/home/PostCard';
import { BottomNav } from '@/src/components/home/BottomNav';
import { useQueryClient } from '@tanstack/react-query';
import { PostSkeleton } from '@/src/components/home/PostSkeleton';
import { StoriesSkeleton } from '@/src/components/stories/StoriesSkeleton';
import { contestService } from '@/src/services/contests/contestService';
import { Colors } from '@/constants/theme';
// Removed FeaturedGrid import

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  
  const [matches, setMatches] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  const queryClient = useQueryClient();

  const loadMatches = async (isRefresh = false) => {
    if (isRefresh) setIsRefreshing(true);
    else setIsLoading(true);
    
    try {
      setLoadError(null);
      const data = await contestService.getActiveMatches();
      setMatches(data);
    } catch (error: any) {
      console.error("Error loading matches:", error);
      setLoadError(error?.message || 'Battles load nahi ho sake.');
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

  const handleMatchEnded = useCallback((matchId: string) => {
    setMatches((current) => current.filter((match) => match.id !== matchId));
  }, []);

  const renderItem = useCallback(({ item }: { item: any }) => (
    <PostCard item={item} isDark={isDark} onMatchEnded={handleMatchEnded} />
  ), [handleMatchEnded, isDark]);

  const ListHeader = useMemo(() => (
    <View>
      {/* FeaturedGrid Removed from here */}
      {isLoading ? <StoriesSkeleton isDark={isDark} /> : <StoriesBar />}
    </View>
  ), [isLoading, isDark]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]} edges={['top', 'left', 'right']}>
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
            <Text style={{ color: isDark ? '#fff' : '#000', fontFamily: 'Urbanist-Medium', textAlign: 'center' }}>
              {loadError || 'No active VS battles right now.'}
            </Text>
            {loadError && (
              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => loadMatches()}
                accessibilityRole="button"
                accessibilityLabel="Retry loading battles"
              >
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : null}
        contentContainerStyle={{ paddingBottom: 100 }}
        showsVerticalScrollIndicator={false}
      />
      <View style={styles.navContainer}>
        <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  emptyContainer: { padding: 40, alignItems: 'center' },
  retryButton: { marginTop: 16, minHeight: 44, paddingHorizontal: 24, justifyContent: 'center', borderRadius: 22, backgroundColor: '#FF4D67' },
  retryText: { color: '#FFF', fontFamily: 'Urbanist-Bold' },
  navContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  }
});
