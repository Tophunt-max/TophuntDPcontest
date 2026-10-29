import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { BackButton } from '@/src/components/ui/BackButton';
import { Avatar } from '@/src/components/ui/Avatar';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';
import { useAuth } from '@/src/hooks/useAuth';
import { BRAND, BRAND_GRAD, PAD, useExplorePalette, type ExplorePalette } from '@/src/components/explore/theme';
import { SectionEmpty, SectionError } from '@/src/components/explore/ExploreBits';
import { formatXp, timeLeft } from '@/src/lib/progression';
import { useMyXpRank, useXpLeaderboard, type XpPeriod, type XpRankRow } from '@/src/services/gamification';

const TABS: { key: XpPeriod; label: string }[] = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'season', label: 'Season' },
  { key: 'lifetime', label: 'All time' },
];

/**
 * XP leaderboards. Ranking: period XP, then lifetime XP, then account age —
 * the same deterministic order the server ranks by, so a rank never jumps
 * between refreshes for a tie. Cursor-paginated; public profile fields only.
 */
export default function XpLeaderboardScreen() {
  const p = useExplorePalette();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ period?: string }>();
  const initial = TABS.some((t) => t.key === params.period) ? (params.period as XpPeriod) : 'week';
  const [period, setPeriod] = useState<XpPeriod>(initial);
  const { user } = useAuth();
  const q = useXpLeaderboard(period);
  const me = useMyXpRank(period, !!user);
  const rows = useMemo(() => (q.data?.pages ?? []).flatMap((pg) => pg.rows), [q.data]);
  const first = q.data?.pages?.[0];
  const meInList = !!user && rows.some((r) => r.uid === user.uid);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: p.bg }]} edges={['top']}>
      <View style={styles.header}>
        <BackButton size={24} color={p.text} style={{ marginRight: 12 }} />
        <Text style={[styles.headerTitle, { color: p.text }]} accessibilityRole="header">XP Leaderboard</Text>
      </View>
      <View style={[styles.tabs, { backgroundColor: p.chip }]} accessibilityRole="tablist">
        {TABS.map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tab, t.key === period && { backgroundColor: p.card }]}
            onPress={() => setPeriod(t.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: t.key === period }}
          >
            <Text style={[styles.tabText, { color: t.key === period ? BRAND : p.sub }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {first?.endsAt ? <Text style={[styles.sub, { color: p.sub }]}>{first.label} · ends in {timeLeft(first.endsAt)}</Text> : null}
      {q.isLoading ? (
        <View style={styles.center}><ActivityIndicator color={BRAND} /></View>
      ) : q.isError ? (
        <View style={{ marginTop: 30 }}><SectionError palette={p} onRetry={() => q.refetch()} label="Leaderboard load nahi ho paya." /></View>
      ) : first && !first.active ? (
        <View style={{ marginTop: 30 }}><SectionEmpty palette={p} icon="medal-outline" text="No season is running right now. Check back soon!" /></View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.uid}
          contentContainerStyle={{ paddingBottom: (user && !meInList ? 90 : 30) + insets.bottom }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); me.refetch(); }} tintColor={BRAND} />}
          onEndReached={() => q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage()}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={<SectionEmpty palette={p} icon="flash-outline" text="No XP earned yet in this period. Be the first!" />}
          ListFooterComponent={q.isFetchingNextPage ? <ActivityIndicator color={BRAND} style={{ marginVertical: 16 }} /> : null}
          renderItem={({ item }) => (
            <Row r={item} p={p} isMe={item.uid === user?.uid} onOpen={() => router.push(`/profile?userId=${encodeURIComponent(item.uid)}` as any)} />
          )}
        />
      )}
      {user && me.data?.rank && !meInList ? (
        <View style={[styles.meBar, { bottom: insets.bottom + 12 }]} accessibilityLabel={`Your rank ${me.data.rank}, ${me.data.score} XP`}>
          <LinearGradient colors={BRAND_GRAD} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.meInner}>
            <Text style={styles.meRank}>#{me.data.rank}</Text>
            <Text style={styles.meLabel}>Your rank</Text>
            <View style={{ flex: 1 }} />
            <Text style={styles.meScore}>{formatXp(me.data.score)} XP</Text>
          </LinearGradient>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const MEDAL = ['#FFD54A', '#CBD5E1', '#F4A261'];

const Row = React.memo(function Row({ r, p, isMe, onOpen }: { r: XpRankRow; p: ExplorePalette; isMe: boolean; onOpen: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: isMe ? (p.isDark ? '#2A1A22' : '#FFF1F3') : p.card, borderColor: isMe ? BRAND : p.border }]}
      onPress={onOpen}
      accessibilityRole="link"
      accessibilityLabel={`Rank ${r.rank}, ${r.username || r.fullName}, level ${r.level}, ${r.score} XP`}
    >
      {r.rank <= 3 ? (
        <View style={[styles.medal, { backgroundColor: MEDAL[r.rank - 1] }]}><Text style={styles.medalText}>{r.rank}</Text></View>
      ) : (
        <Text style={[styles.rank, { color: p.sub }]}>{r.rank}</Text>
      )}
      <Avatar uri={r.profileImageUrlThumb || r.profileImageUrl} name={r.fullName || r.username || 'user'} size={42} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: p.text }]} numberOfLines={1}>{r.fullName || r.username}</Text>
          <VerifiedBadge verified={r.verified} size={13} />
        </View>
        <Text style={[styles.handle, { color: p.sub }]} numberOfLines={1}>Lv {r.level} · {r.rankTitle}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.score, { color: BRAND }]}>{formatXp(r.score)}</Text>
        <Text style={[styles.unit, { color: p.sub }]}>XP</Text>
      </View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  headerTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', marginHorizontal: PAD, borderRadius: 14, padding: 4, marginBottom: 6 },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 9, borderRadius: 11 },
  tabText: { fontSize: 13, fontFamily: 'Urbanist-Bold' },
  sub: { paddingHorizontal: PAD, marginBottom: 8, fontSize: 12, fontFamily: 'Urbanist-Medium' },
  row: { flexDirection: 'row', alignItems: 'center', marginHorizontal: PAD, marginBottom: 10, padding: 12, borderRadius: 16, borderWidth: 1 },
  rank: { width: 30, fontSize: 15, fontFamily: 'Urbanist-Black' },
  medal: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 6 },
  medalText: { fontSize: 11, fontFamily: 'Urbanist-Black', color: '#3B2A00' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  name: { fontSize: 15, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  handle: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 1 },
  score: { fontSize: 16, fontFamily: 'Urbanist-Black' },
  unit: { fontSize: 10, fontFamily: 'Urbanist-SemiBold' },
  meBar: { position: 'absolute', left: PAD, right: PAD, borderRadius: 16, overflow: 'hidden' },
  meInner: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14 },
  meRank: { color: '#FFF', fontSize: 18, fontFamily: 'Urbanist-Black' },
  meLabel: { color: 'rgba(255,255,255,0.9)', fontSize: 13, fontFamily: 'Urbanist-SemiBold' },
  meScore: { color: '#FFF', fontSize: 15, fontFamily: 'Urbanist-Bold' },
});
