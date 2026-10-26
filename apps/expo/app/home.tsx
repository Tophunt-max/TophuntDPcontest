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
import { fetchStories } from '@/src/services/stories/storyService';
import { PostCard } from '@/src/components/home/PostCard';
import { BottomNav } from '@/src/components/home/BottomNav';
import { useQueryClient } from '@tanstack/react-query';
import NetInfo from '@react-native-community/netinfo';
import { PostSkeleton } from '@/src/components/home/PostSkeleton';
import { StoriesSkeleton } from '@/src/components/stories/StoriesSkeleton';
import { contestService } from '@/src/services/contests/contestService';
import { useFocusEffect } from 'expo-router';
import { getSocialGraphVersion } from '@/src/lib/socialGraphVersion';
import { Colors } from '@/constants/theme';
import { useAuthGate } from '@/src/hooks/useAuthGate';
import { useAuth } from '@/src/hooks/useAuth';
import {
  appendPage,
  feedOwnerKey,
  loadFeedSnapshot,
  planFeedLoad,
  recordFeedEvent,
  snapshotGeneration,
  recordFirstContent,
  saveFeedSnapshot,
  type FeedCursor,
} from '@/src/lib/feedSnapshot';
import { GuestLoginWall } from '@/src/components/auth/GuestLoginWall';
import { seenAfterViewable, shouldShowGuestWall } from '@/src/lib/guestWall';
import { liveIdsFor, sameIds } from '@/src/lib/liveWindow';
import { shouldAutoplay, visibleIdsFor } from '@/src/lib/playbackPolicy';
import { trackUsage } from '@/src/services/usageStats';
import { removeCard, restoreCard, type RemovedCard } from '@/src/lib/feedUndo';
import { restoreRenderCount, saveFeedSession, takeFeedSession, type FeedSessionState } from '@/src/lib/feedSession';
import { emitToast } from '@/src/lib/toastBridge';
import { useAppActive, useReduceMotion } from '@/src/hooks/usePlaybackEnvironment';
import { useIsFocused } from '@react-navigation/native';

type FeedTab = 'foryou' | 'following';
const PAGE_SIZE = 8;

/**
 * Where the battles on screen came from.
 *  - 'none'    nothing to show yet
 *  - 'cache'   a local snapshot (src/lib/feedSnapshot.ts), revalidating
 *  - 'network' the server's current first page (+ any pages loaded after it)
 *
 * Load-more only runs from 'network': a cached snapshot's cursor is an offset into
 * a ranking that has moved since, so paging from it would skip or repeat battles.
 */
type FeedSource = 'none' | 'cache' | 'network';
type LoadMode = 'initial' | 'background' | 'pull';

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const subTextColor = isDark ? '#9BA1A6' : '#8A8F98';

  const [feedTab, setFeedTab] = useState<FeedTab>('foryou');
  const [matches, setMatches] = useState<any[]>([]);
  const [nextCursor, setNextCursor] = useState<FeedCursor>(null);
  const [source, setSource] = useState<FeedSource>('none');
  // Skeletons ONLY when there is nothing to show. A cached snapshot on screen is
  // revalidated quietly (isRevalidating) instead of being replaced by skeletons.
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // The last load-more failed. Shown as a tap-to-retry footer; it used to fail
  // silently and the list just stopped.
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A refresh failed while cached battles stayed on screen.
  const [showingSaved, setShowingSaved] = useState(false);

  // Viewer identity scopes the snapshot. Nothing loads until Firebase has resolved
  // the persisted session, so a signed-in cold start never paints (or fetches)
  // the guest feed first and then swaps.
  const { user, loading: authLoading } = useAuth();
  const owner = feedOwnerKey(user?.uid);
  const feedKey = `${owner}|${feedTab}`;
  const feedKeyRef = useRef(feedKey);
  feedKeyRef.current = feedKey;
  const sourceRef = useRef<FeedSource>('none');
  sourceRef.current = source;
  const hasContentRef = useRef(false);
  hasContentRef.current = matches.length > 0;
  // Read by the (stable) viewability callback to find the card after the visible ones.
  const matchesRef = useRef<any[]>([]);
  matchesRef.current = matches;
  // Scroll restore (src/lib/feedSession.ts): where the reader is, and a position to go back to.
  const listRef = useRef<FlatList<any>>(null);
  const scrollOffsetRef = useRef(0);
  const firstIndexRef = useRef(0);
  const nextCursorRef = useRef<number | string | null>(null);
  const pendingRestoreRef = useRef<FeedSessionState | null>(null);
  const [renderCount, setRenderCount] = useState(4);
  nextCursorRef.current = nextCursor;
  const mountedAtRef = useRef(Date.now());

  const queryClient = useQueryClient();
  // Guards against overlapping loads triggered by fast scrolling / tab switches.
  const loadingMoreRef = useRef(false);
  const reqIdRef = useRef(0);
  // Block/mute version this feed was last loaded at (see the focus effect below).
  const graphVersionRef = useRef(getSocialGraphVersion());

  // Soft login wall for guests (src/lib/guestWall.ts): counts the furthest
  // battle seen and nudges after every N. Refs + one state flag, so scrolling
  // never re-renders the list.
  const { isGuest } = useAuthGate();
  const isGuestRef = useRef(isGuest);
  isGuestRef.current = isGuest;
  const seenRef = useRef(0);
  // Battles already counted as an impression on this screen (usage statistics).
  const impressedRef = useRef<Set<string>>(new Set());
  const wallDismissalsRef = useRef(0);
  const [showWall, setShowWall] = useState(false);
  // Cards that hold a live socket: the visible ones plus the next (src/lib/liveWindow.ts).
  const [liveIds, setLiveIds] = useState<Set<string>>(() => new Set());
  // Cards whose videos may play: on screen only (src/lib/playbackPolicy.ts).
  const [visibleIds, setVisibleIds] = useState<Set<string>>(() => new Set());
  // Stable identity is required: FlatList throws if onViewableItemsChanged changes.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: { index: number | null; item: any }[] }) => {
    const next = liveIdsFor(viewableItems, matchesRef.current);
    setLiveIds((prev) => (sameIds(prev, next) ? prev : next));
    const visible = visibleIdsFor(viewableItems);
    setVisibleIds((prev) => (sameIds(prev, visible) ? prev : visible));
    let fresh = 0;
    for (const id of visible) {
      if (!impressedRef.current.has(id)) {
        impressedRef.current.add(id);
        fresh++;
      }
    }
    if (fresh) trackUsage('feed_impression', 'home', { count: fresh });
    // Skeleton rows (numbers) are not battles.
    const indices = viewableItems.filter((v) => typeof v.item === 'object').map((v) => v.index);
    const firstShown = indices.filter((i): i is number => typeof i === 'number');
    if (firstShown.length) firstIndexRef.current = Math.min(...firstShown);
    seenRef.current = seenAfterViewable(seenRef.current, indices);
    if (shouldShowGuestWall({ isGuest: isGuestRef.current, seen: seenRef.current, dismissals: wallDismissalsRef.current })) {
      setShowWall(true);
    }
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;
  const dismissWall = useCallback(() => {
    wallDismissalsRef.current += 1;
    setShowWall(false);
  }, []);
  // Signing in closes the wall for good.
  useEffect(() => {
    if (!isGuest) setShowWall(false);
  }, [isGuest]);

  /**
   * Fetch the first page from the network and make it the feed.
   *
   * `initial`    nothing on screen: skeletons until it lands.
   * `background` a snapshot is on screen: refresh quietly, keep it on failure.
   * `pull`       pull-to-refresh: spinner, always reaches the network.
   */
  const fetchFirstPage = useCallback(async (tab: FeedTab, ownerKey: string, mode: LoadMode) => {
    const reqId = ++reqIdRef.current; // ignore results from superseded requests
    const key = `${ownerKey}|${tab}`;
    // Captured BEFORE the request: a block/mute/sign-out that clears snapshots
    // while this is in flight makes the save below a no-op.
    const gen = snapshotGeneration();
    if (mode === 'pull') setIsRefreshing(true);
    else if (mode === 'background') setIsRevalidating(true);
    else setIsLoading(true);
    try {
      setLoadError(null);
      const { items, nextCursor: cursor } = await contestService.getActiveMatches({ sort: tab, cursor: null, limit: PAGE_SIZE });
      if (reqId !== reqIdRef.current || key !== feedKeyRef.current) return; // a newer request / viewer won
      if (sourceRef.current === 'cache') recordFeedEvent('stale_render');
      setMatches(items);
      setNextCursor(cursor);
      setSource('network');
      setShowingSaved(false);
      void saveFeedSnapshot(ownerKey, tab, items, cursor, Date.now(), gen);
    } catch (error: any) {
      if (reqId !== reqIdRef.current || key !== feedKeyRef.current) return;
      if (hasContentRef.current) {
        // Keep the battles the user is looking at; say they may be out of date.
        recordFeedEvent('offline_serve');
        setShowingSaved(true);
      } else {
        setLoadError(error?.message || 'Battles load nahi ho sake.');
      }
    } finally {
      if (reqId === reqIdRef.current) {
        setIsLoading(false);
        setIsRefreshing(false);
        setIsRevalidating(false);
      }
    }
  }, []);

  /** Retry / graph-change reload for the current viewer + tab. */
  const loadFeed = useCallback((tab: FeedTab, isRefresh = false) => {
    const mode: LoadMode = isRefresh ? (hasContentRef.current ? 'background' : 'pull') : hasContentRef.current ? 'background' : 'initial';
    return fetchFirstPage(tab, owner, mode);
  }, [fetchFirstPage, owner]);

  // Auto-load the next page as the user nears the bottom (no button).
  const loadMore = useCallback(async () => {
    // Never page from a cached snapshot's cursor — wait for the fresh first page.
    if (loadingMoreRef.current || nextCursor == null || source !== 'network') return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreFailed(false);
    const key = feedKeyRef.current;
    try {
      const { items, nextCursor: cursor } = await contestService.getActiveMatches({ sort: feedTab, cursor: nextCursor, limit: PAGE_SIZE });
      if (key !== feedKeyRef.current) return; // tab or viewer changed mid-flight — drop
      setMatches((prev) => appendPage(prev, items));
      setNextCursor(cursor);
    } catch {
      // Keep the cursor; the footer offers a retry (and reconnect retries it).
      if (key === feedKeyRef.current) setLoadMoreFailed(true);
    } finally {
      // Only release the guard this call owns. After a tab/viewer switch the reset
      // effect already released it, and a newer load-more may hold it now.
      if (key === feedKeyRef.current) {
        loadingMoreRef.current = false;
        setIsLoadingMore(false);
      }
    }
  }, [nextCursor, feedTab, source]);

  /**
   * Viewer or tab changed (including first mount): paint the local snapshot for
   * THIS viewer + tab if there is one, then revalidate. The previous viewer's
   * battles are cleared synchronously first, so an account switch can never show
   * them for even one frame.
   */
  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    reqIdRef.current += 1; // supersede anything in flight for the old key
    loadingMoreRef.current = false;
    setMatches([]);
    setNextCursor(null);
    setSource('none');
    setShowingSaved(false);
    setLoadError(null);
    setIsLoadingMore(false);
    setLoadMoreFailed(false);
    setIsRefreshing(false);
    setIsRevalidating(false);
    setIsLoading(true);
    hasContentRef.current = false;
    sourceRef.current = 'none';
    graphVersionRef.current = getSocialGraphVersion();

    // Coming back to this tab (or a Home pushed again) within a few minutes: the
    // same battles, cursor and scroll position, without a reload.
    const resumed = takeFeedSession(`${owner}|${feedTab}`);
    if (resumed) {
      setMatches(resumed.items);
      setNextCursor(resumed.nextCursor);
      setSource('network');
      sourceRef.current = 'network';
      hasContentRef.current = true;
      setIsLoading(false);
      pendingRestoreRef.current = resumed;
      setRenderCount(restoreRenderCount(resumed, 4));
      return () => {
        cancelled = true;
      };
    }
    pendingRestoreRef.current = null;
    setRenderCount(4);
    scrollOffsetRef.current = 0;
    firstIndexRef.current = 0;

    (async () => {
      const snap = await loadFeedSnapshot(owner, feedTab);
      if (cancelled) return;
      const plan = planFeedLoad(snap, owner);
      if (snap && plan !== 'network') {
        // Paint now, always revalidate: the snapshot cannot know about votes/likes
        // the viewer made after it was saved (PostCard holds those in its state).
        setMatches(snap.items);
        setIsLoading(false);
        setSource('cache');
        sourceRef.current = 'cache';
        hasContentRef.current = true;
        void fetchFirstPage(feedTab, owner, 'background');
        return;
      }
      void fetchFirstPage(feedTab, owner, 'initial');
    })();
    return () => {
      cancelled = true;
    };
  }, [owner, feedTab, authLoading, fetchFirstPage]);

  /**
   * Remember this list and position for the next time this tab is shown (tab
   * switch, unmount, or another screen pushed on top). Only a list that came from
   * the network: a snapshot's cursor cannot be paged from.
   */
  const persistSession = useCallback((key: string) => {
    if (sourceRef.current !== 'network' || !matchesRef.current.length) return;
    saveFeedSession(key, {
      items: matchesRef.current,
      nextCursor: nextCursorRef.current,
      offset: scrollOffsetRef.current,
      firstIndex: firstIndexRef.current,
    });
  }, []);
  useEffect(() => {
    const key = feedKey;
    return () => persistSession(key);
  }, [feedKey, persistSession]);
  useFocusEffect(
    useCallback(() => {
      const key = feedKey;
      return () => persistSession(key);
    }, [feedKey, persistSession]),
  );
  /** Scroll back to the saved offset once the restored cards are laid out. */
  const applyRestore = useCallback((contentHeight?: number) => {
    const p = pendingRestoreRef.current;
    if (!p) return;
    if (contentHeight !== undefined && contentHeight < p.offset) return;
    pendingRestoreRef.current = null;
    listRef.current?.scrollToOffset({ offset: p.offset, animated: false });
    scrollOffsetRef.current = p.offset;
    firstIndexRef.current = p.firstIndex;
  }, []);
  useEffect(() => {
    if (!pendingRestoreRef.current) return;
    // Fallback if the content never reaches the offset (cards changed height).
    const t = setTimeout(() => applyRestore(), 600);
    return () => clearTimeout(t);
  }, [matches, applyRestore]);

  // Home time-to-first-content, once per session (src/lib/feedSnapshot.ts stats).
  useEffect(() => {
    if (matches.length > 0) recordFirstContent(Date.now() - mountedAtRef.current);
  }, [matches.length]);

  /**
   * Reload on focus, but only if the viewer blocked or muted someone while away.
   *
   * Returning from a profile where the user just blocked someone would otherwise
   * still show that person's battles. Gated on the version so an ordinary tab
   * switch back to Home costs nothing. (The persisted snapshot was already dropped
   * by the same bump — see feedSnapshot.ts.)
   */
  useFocusEffect(
    useCallback(() => {
      const current = getSocialGraphVersion();
      if (current !== graphVersionRef.current) {
        graphVersionRef.current = current;
        void loadFeed(feedTab, true);
      }
    }, [feedTab, loadFeed]),
  );

  const onRefresh = useCallback(async () => {
    // Pull-to-refresh has to reach the network. `fetchStories` is cache-first,
    // so a bare invalidate just re-runs it and hands back the same local rows —
    // the gesture appeared to do nothing for the tray. Seeding the shared
    // ['stories'] cache with a forced read also re-saves rows that were cached
    // before a schema upgrade, which is how stories cached without the music
    // columns get their soundtrack back.
    try {
      queryClient.setQueryData(['stories'], await fetchStories({ forceRefresh: true }));
    } catch {
      await queryClient.invalidateQueries({ queryKey: ['stories'] });
    }
    await fetchFirstPage(feedTab, owner, 'pull');
  }, [queryClient, fetchFirstPage, feedTab, owner]);

  const handleMatchEnded = useCallback((matchId: string) => {
    setMatches((current) => current.filter((match) => match.id !== matchId));
  }, []);

  /**
   * "Not interested": the card leaves at once, and an Undo bar stays for a few
   * seconds. Undo tells the server (`dismissed: false`) and puts the card back
   * where it was. The full list is in Settings › Privacy › Not interested.
   */
  const [undo, setUndo] = useState<RemovedCard | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearUndo = useCallback(() => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoTimerRef.current = null;
    setUndo(null);
  }, []);
  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);
  const handleNotInterested = useCallback((matchId: string) => {
    // Position from the list as rendered now (a state updater runs later).
    const { removed } = removeCard(matchesRef.current, matchId);
    setMatches((current) => removeCard(current, matchId).list);
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndo(removed);
    undoTimerRef.current = setTimeout(() => setUndo(null), 6000);
  }, []);
  const undoNotInterested = useCallback(async () => {
    const r = undo;
    clearUndo();
    if (!r) return;
    const key = feedKeyRef.current;
    try {
      await contestService.setFeedDismissal(r.item.id, false);
      if (key === feedKeyRef.current) setMatches((current) => restoreCard(current, r));
    } catch {
      emitToast('Undo nahi ho paya. Settings › Privacy › Not interested se try karein.', 'error');
    }
  }, [undo, clearUndo]);
  // A tab or account switch makes the pending undo meaningless for this list.
  useEffect(() => clearUndo(), [feedKey, clearUndo]);

  // The viewer/tab effect above resets the list and paints that tab's snapshot.
  const switchTab = useCallback((tab: FeedTab) => {
    if (tab === feedTab) return;
    setFeedTab(tab);
  }, [feedTab]);

  // Home stays mounted under pushed screens, and video kept playing there.
  const screenFocused = useIsFocused();
  const appActive = useAppActive();
  const reduceMotion = useReduceMotion();
  const renderItem = useCallback(({ item }: { item: any }) => (
    <PostCard
      item={item}
      isDark={isDark}
      onMatchEnded={handleMatchEnded}
      onNotInterested={handleNotInterested}
      liveActive={liveIds.has(item.id)}
      playActive={shouldAutoplay({ visible: visibleIds.has(item.id), screenFocused, appActive, reduceMotion })}
    />
  ), [handleMatchEnded, handleNotInterested, isDark, liveIds, visibleIds, screenFocused, appActive, reduceMotion]);

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
      {/* Subtle background-refresh cue: cached battles stay put underneath. */}
      {isRevalidating && (
        <ActivityIndicator
          size="small"
          color="#FF4D67"
          style={styles.revalidating}
          accessibilityLabel="Updating battles"
        />
      )}
    </View>
  );

  const SavedNotice = showingSaved ? (
    <TouchableOpacity
      style={[styles.savedNotice, { backgroundColor: isDark ? '#23262D' : '#F3F4F6' }]}
      onPress={() => void fetchFirstPage(feedTab, owner, 'pull')}
      accessibilityRole="button"
      accessibilityLabel="Showing saved battles. Tap to retry."
    >
      <Text style={[styles.savedNoticeText, { color: subTextColor }]}>
        Saved battles dikh rahe hain · Tap to retry
      </Text>
    </TouchableOpacity>
  ) : null;

  const ListHeader = useMemo(() => (
    <View>
      {isLoading ? <StoriesSkeleton isDark={isDark} /> : <StoriesBar />}
      <View style={styles.storiesSpacer} />
    </View>
  ), [isLoading, isDark]);

  const ListFooter = useMemo(() => {
    if (isLoadingMore) return <ActivityIndicator size="small" color="#FF4D67" style={{ marginVertical: 20 }} />;
    if (loadMoreFailed) {
      return (
        <TouchableOpacity
          style={[styles.savedNotice, { backgroundColor: isDark ? '#23262D' : '#F3F4F6', marginVertical: 16 }]}
          onPress={() => void loadMore()}
          accessibilityRole="button"
          accessibilityLabel="More battles could not load. Tap to retry."
        >
          <Text style={[styles.savedNoticeText, { color: subTextColor }]}>
            Aur battles load nahi hue · Tap to retry
          </Text>
        </TouchableOpacity>
      );
    }
    return <View style={{ height: 20 }} />;
  }, [isLoadingMore, loadMoreFailed, loadMore, isDark, subTextColor]);

  /**
   * Back online: recover by itself. Home is not a React Query screen, so
   * `refetchOnReconnect` never reached it. An offline cold start stayed on its
   * error until the user tapped Retry, and the "saved battles" strip stayed up
   * after the network returned.
   */
  // Read through a ref so the listener is not re-subscribed (losing its
  // offline/online memory) every time one of these changes.
  const recoveryRef = useRef({ loadError, showingSaved, loadMoreFailed, feedTab, owner });
  useEffect(() => {
    recoveryRef.current = { loadError, showingSaved, loadMoreFailed, feedTab, owner };
  }, [loadError, showingSaved, loadMoreFailed, feedTab, owner]);
  useEffect(() => {
    let wasOnline: boolean | null = null;
    return NetInfo.addEventListener((state) => {
      const online = state.isConnected !== false && state.isInternetReachable !== false;
      const cameBack = online && wasOnline === false;
      wasOnline = online;
      if (!cameBack) return;
      const r = recoveryRef.current;
      if (r.loadError || r.showingSaved) {
        void fetchFirstPage(r.feedTab, r.owner, hasContentRef.current ? 'background' : 'initial');
      } else if (r.loadMoreFailed) {
        void loadMore();
      }
    });
  }, [fetchFirstPage, loadMore]);

  const emptyText = feedTab === 'following'
    ? 'Aap jinhe follow karte hain unke koi active battles nahi. Naye creators follow karein!'
    : 'No active VS battles right now.';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]} edges={['top', 'left', 'right']}>
      <Header />
      {TabBar}
      {SavedNotice}
      <FlatList
        ref={listRef}
        onScroll={(e) => {
          scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={(_w, h) => applyRestore(h)}
        data={isLoading ? [1, 2, 3] : matches}
        renderItem={({ item }) => isLoading ? <PostSkeleton isDark={isDark} /> : renderItem({ item })}
        // The live window lives outside `data`; FlatList re-renders rows only on a data
        // change unless told. PostCard is memoised, so only cards whose liveActive
        // flipped do any work.
        extraData={renderItem}
        // Cached cards get their own key so they REMOUNT when the fresh page lands:
        // PostCard seeds votes / counts / isLiked from `item` into useState once, so
        // reusing a card across the swap would keep the snapshot's stale numbers.
        // One remount per revalidation; network-sourced cards keep the plain id.
        keyExtractor={(item, index) => (isLoading ? index.toString() : source === 'cache' ? `cached:${item.id}` : item.id)}
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
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        removeClippedSubviews
        initialNumToRender={renderCount}
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
        // Guests also have the Log in / Sign up strip above the nav.
        contentContainerStyle={{ paddingBottom: isGuest ? 160 : 100 }}
        showsVerticalScrollIndicator={false}
      />
      {undo && (
        <View style={[styles.undoBar, { bottom: isGuest ? 150 : 90 }]} accessibilityLiveRegion="polite">
          <Text style={styles.undoText}>Battle hidden. You&apos;ll see fewer like it.</Text>
          <TouchableOpacity onPress={() => void undoNotInterested()} accessibilityRole="button" accessibilityLabel="Undo not interested" hitSlop={8}>
            <Text style={styles.undoAction}>Undo</Text>
          </TouchableOpacity>
        </View>
      )}
      <View style={styles.navContainer}>
        <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
      </View>
      <GuestLoginWall visible={showWall && isGuest} isDark={isDark} onDismiss={dismissWall} />
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
  revalidating: { marginLeft: 'auto', marginRight: 12 },
  savedNotice: { paddingVertical: 6, paddingHorizontal: 16, alignItems: 'center' },
  savedNoticeText: { fontFamily: 'Urbanist-Medium', fontSize: 12 },
  emptyContainer: { padding: 40, alignItems: 'center' },
  retryButton: { marginTop: 16, minHeight: 44, paddingHorizontal: 24, justifyContent: 'center', borderRadius: 22, backgroundColor: '#FF4D67' },
  retryText: { color: '#FFF', fontFamily: 'Urbanist-Bold' },
  undoBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#212121',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  undoText: { color: '#fff', fontFamily: 'Urbanist-Medium', fontSize: 14, flex: 1, marginRight: 12 },
  undoAction: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', fontSize: 15 },
  navContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  }
});
