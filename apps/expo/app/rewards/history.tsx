import React, { useMemo } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton } from '@/src/components/ui/BackButton';
import { useAuth } from '@/src/hooks/useAuth';
import { BRAND, PAD, useExplorePalette } from '@/src/components/explore/theme';
import { SectionEmpty, SectionError } from '@/src/components/explore/ExploreBits';
import { useXpHistory } from '@/src/services/gamification';
import { GamificationIcon } from '@/src/components/gamification/GamificationIcon';
import { XpGainPill } from '@/src/components/gamification/RewardBits';
import { XP_ACTION_ASSET } from '@/src/lib/gamificationAssets';

/** Every XP event on the account, newest first (cursor-paginated). */
export default function XpHistoryScreen() {
  const p = useExplorePalette();
  const { user } = useAuth();
  const q = useXpHistory(!!user);
  const events = useMemo(() => (q.data?.pages ?? []).flatMap((pg) => pg.events), [q.data]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: p.bg }]} edges={['top']}>
      <View style={styles.header}>
        <BackButton size={24} color={p.text} style={{ marginRight: 12 }} />
        <Text style={[styles.headerTitle, { color: p.text }]} accessibilityRole="header">XP history</Text>
      </View>
      {q.isLoading ? (
        <View style={styles.center}><ActivityIndicator color={BRAND} /></View>
      ) : q.isError ? (
        <View style={{ marginTop: 30 }}><SectionError palette={p} onRetry={() => q.refetch()} label="History load nahi ho payi." /></View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(e) => e.id}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={BRAND} />}
          onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={<SectionEmpty palette={p} icon="time-outline" text="No XP yet. Vote, enter a battle or check in to start." />}
          ListFooterComponent={q.isFetchingNextPage ? <ActivityIndicator color={BRAND} style={{ marginVertical: 16 }} /> : null}
          renderItem={({ item }) => (
            <View style={[styles.row, { borderColor: p.border }]} accessible accessibilityLabel={`${item.label}, ${item.delta} XP`}>
              <View style={[styles.icon, { backgroundColor: p.chip }]}>
                <GamificationIcon assetKey={XP_ACTION_ASSET[item.action] ?? 'xp.star'} size={18} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.label, { color: p.text }]}>{item.label}</Text>
                <Text style={[styles.date, { color: p.sub }]}>{new Date(item.createdAt).toLocaleString()}</Text>
              </View>
              {item.delta !== 0 ? <XpGainPill amount={item.delta} /> : <Text style={[styles.delta, { color: p.sub }]}>0 XP</Text>}
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  headerTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: PAD, paddingVertical: 12, borderBottomWidth: 1 },
  label: { fontSize: 14, fontFamily: 'Urbanist-SemiBold' },
  date: { fontSize: 11, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  delta: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
});
