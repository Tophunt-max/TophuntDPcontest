import React, { useMemo } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { BackButton } from '@/src/components/ui/BackButton';
import { useAuth } from '@/src/hooks/useAuth';
import { useAuthGate } from '@/src/hooks/useAuthGate';
import { emitToast } from '@/src/lib/toastBridge';
import { useDesignWindow } from '@/src/lib/layout';
import { chunk, joinableOpenBattles } from '@/src/lib/exploreMedia';
import { BATTLE_KIND_TITLE, useBattlePages, type BattleKind, type BattleType } from '@/src/services/explore';
import { BattleTile } from '@/src/components/explore/BattleTile';
import { OpenBattleCard } from '@/src/components/explore/OpenBattleCard';
import { SectionEmpty, SectionError } from '@/src/components/explore/ExploreBits';
import { BattleTileSkeleton } from '@/src/components/explore/ExploreSkeletons';
import { BRAND, PAD, useExplorePalette } from '@/src/components/explore/theme';

const KINDS: BattleKind[] = ['trending', 'ending', 'open', 'fresh'];

/** "See all" for an Explore battle rail: an infinite 2-column grid. */
export default function ExploreBattlesScreen() {
  const params = useLocalSearchParams<{ kind?: string; type?: string }>();
  const kind: BattleKind = KINDS.includes(params.kind as BattleKind) ? (params.kind as BattleKind) : 'trending';
  const type: BattleType = params.type === 'photo' || params.type === 'video' ? params.type : undefined;
  const p = useExplorePalette();
  const router = useRouter();
  const { width } = useDesignWindow();
  const { user } = useAuth();
  const { requireAuth } = useAuthGate();
  const q = useBattlePages(kind, type, 20);
  const tileW = (width - PAD * 2 - 12) / 2;

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const page of q.data?.pages || []) for (const m of page.items) if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    return kind === 'open' ? joinableOpenBattles(out, user?.uid) : out;
  }, [q.data, kind, user?.uid]);
  const rows = useMemo(() => chunk(items, 2), [items]);

  const join = (item: any) => {
    if (!requireAuth('join')) return;
    if (user && item.userA?.uid === user.uid) return emitToast('Ye aapki battle hai — rival ka intezaar karo.', 'info');
    router.push({ pathname: item.type === 'video' ? '/contest/video' : '/contest/photo/setup', params: { matchId: item.id, mode: 'join' } } as any);
  };

  const title = `${BATTLE_KIND_TITLE[kind]}${type ? ` · ${type === 'video' ? 'Video' : 'Photo'}` : ''}`;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: p.bg }]} edges={['top']}>
      <View style={styles.header}>
        <BackButton size={24} color={p.text} style={{ marginRight: 12 }} />
        <Text style={[styles.title, { color: p.text }]} numberOfLines={1} accessibilityRole="header">{title}</Text>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(_, i) => `r${i}`}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 40 }}
        renderItem={({ item: row }) => (
          <View style={styles.row}>
            {row.map((m) =>
              kind === 'open' ? (
                <OpenBattleCard key={m.id} item={m} width={tileW} isMine={!!user && m.userA?.uid === user.uid} palette={p} onJoin={join} />
              ) : (
                <BattleTile key={m.id} item={m} width={tileW} palette={p} emphasis={kind === 'ending' ? 'ending' : undefined} />
              ),
            )}
          </View>
        )}
        onEndReachedThreshold={0.6}
        onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
        refreshControl={<RefreshControl refreshing={q.isRefetching && !q.isFetchingNextPage} onRefresh={() => q.refetch()} tintColor={BRAND} />}
        ListEmptyComponent={
          q.isLoading ? (
            <View style={styles.row}>
              {[0, 1].map((i) => (
                <BattleTileSkeleton key={i} width={tileW} />
              ))}
            </View>
          ) : q.isError ? (
            <SectionError palette={p} onRetry={() => q.refetch()} />
          ) : (
            <SectionEmpty palette={p} text="Abhi yahan koi battle nahi." />
          )
        }
        ListFooterComponent={q.isFetchingNextPage ? <ActivityIndicator color={BRAND} style={{ marginVertical: 16 }} /> : null}
        initialNumToRender={6}
        windowSize={7}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  row: { flexDirection: 'row', gap: 12, paddingHorizontal: PAD, marginBottom: 12 },
});
