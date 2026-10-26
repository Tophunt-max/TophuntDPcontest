import React, { useState } from 'react';
import { View, Text, StyleSheet, SafeAreaView, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { Image } from 'expo-image';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { BackButton } from '@/src/components/ui/BackButton';
import { Colors } from '@/constants/theme';
import { contestService } from '@/src/services/contests/contestService';
import { participantThumb } from '@/src/lib/exploreMedia';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';

const QUERY_KEY = ['feed-dismissals'];

/**
 * Battles the viewer marked "Not interested", with a way to show each one again.
 *
 * Home offers Undo for a few seconds after a dismissal; this is the durable
 * route afterwards. "Show again" calls `setFeedDismissal` with `dismissed:
 * false`, which also lifts the demotion of that battle's creators. Dismissals
 * older than 90 days are removed by the server on its own.
 */
export default function NotInterestedScreen() {
  const isDark = useColorScheme() === 'dark';
  const textColor = isDark ? '#fff' : '#212121';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const secondary = isDark ? '#A0A0A0' : '#666';
  const border = isDark ? '#35383F' : '#EEEEEE';
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const q = useInfiniteQuery({
    queryKey: QUERY_KEY,
    queryFn: ({ pageParam }) => contestService.listFeedDismissals(pageParam as number | null),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = (q.data?.pages ?? []).flatMap((p) => p.items);

  const showAgain = async (matchId: string) => {
    if (busy) return;
    setBusy(matchId);
    try {
      await contestService.setFeedDismissal(matchId, false);
      qc.setQueryData(QUERY_KEY, (old: any) =>
        old ? { ...old, pages: old.pages.map((p: any) => ({ ...p, items: p.items.filter((i: any) => i.matchId !== matchId) })) } : old,
      );
      emitToast('This battle can appear in your feed again.', 'success');
    } catch (e: any) {
      reportError(e, { screen: 'not-interested', action: 'undo', matchId });
      emitToast(e?.message || 'Something went wrong. Please try again.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const renderItem = ({ item }: { item: { matchId: string; dismissedAt: number; match: any | null } }) => {
    const m = item.match;
    const a = m ? participantThumb(m.userA, m.type) : null;
    const b = m ? participantThumb(m.userB, m.type) : null;
    const title = m
      ? `@${m.userA?.username || 'player'}${m.userB ? ` vs @${m.userB.username || 'player'}` : ''}`
      : 'Battle no longer available';
    return (
      <View style={[styles.row, { borderBottomColor: border }]}>
        <View style={styles.thumbs}>
          {[a, b].map((uri, i) =>
            uri ? (
              <Image key={i} source={{ uri }} style={styles.thumb} contentFit="cover" />
            ) : (
              <View key={i} style={[styles.thumb, { backgroundColor: isDark ? '#1F222A' : '#F0F0F0' }]} />
            ),
          )}
        </View>
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, { color: textColor }]} numberOfLines={1}>
            {title}
          </Text>
          <Text style={[styles.rowSub, { color: secondary }]} numberOfLines={1}>
            Hidden {new Date(item.dismissedAt).toLocaleDateString()}
          </Text>
        </View>
        <TouchableOpacity
          style={[styles.action, { borderColor: border }]}
          onPress={() => void showAgain(item.matchId)}
          disabled={busy === item.matchId}
          accessibilityRole="button"
          accessibilityLabel={`Show ${title} again`}
        >
          {busy === item.matchId ? (
            <ActivityIndicator size="small" color={textColor} />
          ) : (
            <Text style={[styles.actionText, { color: textColor }]}>Show again</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <BackButton size={24} color={textColor} style={styles.backButton} />
        <Text style={[styles.headerTitle, { color: textColor }]}>Not interested</Text>
      </View>
      <Text style={[styles.hint, { color: secondary }]}>
        Battles you hid from For You and Following. Their creators show up a little less. Show one again to undo both.
      </Text>
      {q.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#FF4D67" />
        </View>
      ) : q.isError ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: secondary }]}>Couldn&apos;t load the list.</Text>
          <TouchableOpacity onPress={() => void q.refetch()} accessibilityRole="button">
            <Text style={styles.retry}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.matchId}
          renderItem={renderItem}
          onEndReached={() => {
            if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} tintColor="#FF4D67" colors={['#FF4D67']} />}
          ListEmptyComponent={<Text style={[styles.empty, { color: secondary }]}>You haven&apos;t hidden any battles.</Text>}
          ListFooterComponent={q.isFetchingNextPage ? <ActivityIndicator style={{ margin: 16 }} color="#FF4D67" /> : null}
          contentContainerStyle={{ paddingBottom: 40 }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  backButton: { marginRight: 12 },
  headerTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  hint: { fontSize: 13, fontFamily: 'Urbanist-Regular', paddingHorizontal: 20, paddingBottom: 8, lineHeight: 18 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { fontSize: 14, fontFamily: 'Urbanist-Medium', textAlign: 'center', padding: 24 },
  retry: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', fontSize: 15 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1 },
  thumbs: { flexDirection: 'row', gap: 4 },
  thumb: { width: 40, height: 52, borderRadius: 8 },
  rowText: { flex: 1, marginLeft: 12 },
  rowTitle: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  rowSub: { fontSize: 12, fontFamily: 'Urbanist-Regular', marginTop: 2 },
  action: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1, minWidth: 96, alignItems: 'center' },
  actionText: { fontSize: 13, fontFamily: 'Urbanist-Bold' },
});
