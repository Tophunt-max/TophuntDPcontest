import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  StyleSheet,
  FlatList,
  RefreshControl,
  Text,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
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

type FeedTab = 'foryou' | 'following';
const PAGE_SIZE = 8;

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const subTextColor = isDark ? '#9BA1A6' : '#8A8F98';

  const [feedTab, setFeedTab] = useState<FeedTab>('foryou');
  const [matches, setMatches] = useState<any[]>([]);
  const [nextCursor, setNextCursor] = useState<number | string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  // Guards against overlapping loads triggered by fast scrolling / tab switches.
  const loadingMoreRef = useRef(false);
  const reqIdRef = useRef(0);

  const loadFeed = useCallback(async (tab: FeedTab, isRefresh = false) => {
    const reqId = ++reqIdRef.current; // ignore results from superseded requests
    if (isRefresh) setIsRefreshing(true);
    else setIsLoading(true);
    try {
      setLoadError(null);
      const { items, nextCursor: cursor } = await contestService.getActiveMatches({ sort: tab, cursor: null, limit: PAGE_SIZE });
      if (reqId !== reqIdRef.current) return; // a newer request won
      setMatches(items);
      setNextCursor(cursor);
    } catch (error: any) {
      if (reqId !== reqIdRef.current) return;
      setLoadError(error?.message || 'Battles load nahi ho sake.');
    } finally {
      if (reqId === reqIdRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  // Auto-load the next page as the user nears the bottom (no button).
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || nextCursor == null) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    const tab = feedTab;
    try {
      const { items, nextCursor: cursor } = await contestService.getActiveMatches({ sort: tab, cursor: nextCursor, limit: PAGE_SIZE });
      if (tab !== feedTab) return; // tab changed mid-flight — drop
      setMatches((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...items.filter((m) => !seen.has(m.id))];
      });
      setNextCursor(cursor);
    } catch {
      /* keep current cursor; user can scroll again to retry */
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [nextCursor, feedTab]);

  useEffect(() => {
    loadFeed(feedTab);
  }, [feedTab, loadFeed]);

  const onRefresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['stories'] });
    await loadFeed(feedTab, true);
  }, [queryClient, loadFeed, feedTab]);

  const handleMatchEnded = useCallback((matchId: string) => {
    setMatches((current) => current.filter((match) => match.id !== matchId));
  }, []);

  const switchTab = useCallback((tab: FeedTab) => {
    if (tab === feedTab) return;
    setMatches([]);
    setNextCursor(null);
    setFeedTab(tab);
  }, [feedTab]);

  const renderItem = useCallback(({ item }: { item: any }) => (
    <PostCard item={item} isDark={isDark} onMatchEnded={handleMatchEnded} />
  ), [handleMatchEnded, isDark]);

  const TabBar = (
    <View style={[styles.tabBar, { borderBottomColor: isDark ? '#23262D' : '#EEF0F4' }]}>
      {(['foryou', 'following'] as FeedTab[]).map((tab) => {
        const active = feedTab === tab;
        return (
          <TouchableOpacity
            key={tab}
            style={styles.tabItem}
            onPress={() => switchTab(tab)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.tabLabel, { color: active ? textColor : subTextColor }]}>
              {tab === 'foryou' ? 'For You' : 'Following'}
            </Text>
            {active && <View style={styles.tabUnderline} />}
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const ListHeader = useMemo(() => (
    <View>
      {isLoading ? <StoriesSkeleton isDark={isDark} /> : <StoriesBar />}
      <View style={styles.storiesSpacer} />
    </View>
  ), [isLoading, isDark]);

  const ListFooter = useMemo(() => (
    isLoadingMore
      ? <ActivityIndicator size="small" color="#FF4D67" style={{ marginVertical: 20 }} />
      : <View style={{ height: 20 }} />
  ), [isLoadingMore]);

  const emptyText = feedTab === 'following'
    ? 'Aap jinhe follow karte hain unke koi active battles nahi. Naye creators follow karein!'
    : 'No active VS battles right now.';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]} edges={['top', 'left', 'right']}>
      <Header />
      {TabBar}
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
        ListFooterComponent={!isLoading ? ListFooter : null}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        removeClippedSubviews
        initialNumToRender={4}
        maxToRenderPerBatch={5}
        windowSize={7}
        updateCellsBatchingPeriod={50}
        ListEmptyComponent={!isLoading ? (
          <View style={styles.emptyContainer}>
            <Text style={{ color: isDark ? '#fff' : '#000', fontFamily: 'Urbanist-Medium', textAlign: 'center' }}>
              {loadError || emptyText}
            </Text>
            {loadError && (
              <TouchableOpacity
                style={styles.retryButton}
                onPress={() => loadFeed(feedTab)}
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
  storiesSpacer: { height: 16 },
  tabBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, borderBottomWidth: 1 },
  tabItem: { paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  tabLabel: { fontFamily: 'Urbanist-Bold', fontSize: 15 },
  tabUnderline: { marginTop: 6, height: 3, width: 22, borderRadius: 2, backgroundColor: '#FF4D67' },
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
