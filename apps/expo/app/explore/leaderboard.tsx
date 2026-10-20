import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons, Ionicons } from '@/src/lib/icons';
import { BackButton } from '@/src/components/ui/BackButton';
import { LeaderboardSkeleton } from '@/src/components/skeletons/LeaderboardSkeleton';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';
import { Avatar } from '@/src/components/ui/Avatar';
import { useDesignWindow } from '@/src/lib/layout';
import { readApi } from '@/src/services/api';
import { useAuth } from '@/src/hooks/useAuth';
import { useMyRank } from '@/src/services/explore';
import { compactCount, leaderboardScore, splitPodium, type LeaderboardBy } from '@/src/lib/exploreMedia';
import { SectionEmpty, SectionError } from '@/src/components/explore/ExploreBits';
import { BRAND, BRAND_GRAD, PAD, useExplorePalette, type ExplorePalette } from '@/src/components/explore/theme';
import { ScaleTouchable } from '@/src/components/explore/ScaleTouchable';

const TABS: { key: LeaderboardBy; label: string; unit: string; icon: string }[] = [
  { key: 'wins', label: 'Winners', unit: 'wins', icon: 'trophy' },
  { key: 'votes', label: 'Most voted', unit: 'votes', icon: 'heart' },
  { key: 'xp', label: 'Top XP', unit: 'XP', icon: 'flash' },
];

const MEDAL = ['#FFD54A', '#CBD5E1', '#F4A261'];

/**
 * Leaderboard: podium + ranked list for wins / votes received / XP, with the
 * viewer's own rank pinned at the bottom. react-query keyed by tab, so switching
 * quickly can never show one tab's data under another tab's label.
 */
export default function LeaderboardScreen() {
  const router = useRouter();
  const p = useExplorePalette();
  const insets = useSafeAreaInsets();
  const { width } = useDesignWindow();
  const { user } = useAuth();
  const [by, setBy] = useState<LeaderboardBy>('wins');
  const unit = TABS.find((t) => t.key === by)!.unit;

  const q = useQuery({
    queryKey: ['leaderboard', by],
    queryFn: async () => ((await readApi('/read/leaderboard', { by, limit: 50 })) as any[]) || [],
    staleTime: 30_000,
  });
  const me = useMyRank(by, !!user);
  const { podium, rest, restStartRank } = useMemo(() => splitPodium(q.data || []), [q.data]);
  const meInList = !!user && (q.data || []).some((u: any) => u.uid === user.uid);

  const open = (uid: string) => router.push(`/profile?userId=${encodeURIComponent(uid)}` as any);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: p.bg }]} edges={['top']}>
      <View style={styles.header}>
        <BackButton size={24} color={p.text} style={{ marginRight: 12 }} />
        <Text style={[styles.headerTitle, { color: p.text }]} accessibilityRole="header">Leaderboard</Text>
      </View>

      <View style={[styles.tabs, { backgroundColor: p.chip }]} accessibilityRole="tablist">
        {TABS.map((t) => {
          const active = t.key === by;
          return (
            <TouchableOpacity
              key={t.key}
              style={[styles.tab, active && { backgroundColor: p.card }]}
              onPress={() => setBy(t.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <Ionicons name={t.icon} size={14} color={active ? BRAND : p.sub} />
              <Text style={[styles.tabText, { color: active ? BRAND : p.sub }]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {q.isLoading ? (
        <LeaderboardSkeleton />
      ) : q.isError ? (
        <View style={{ marginTop: 30 }}>
          <SectionError palette={p} onRetry={() => q.refetch()} label="Leaderboard load nahi ho paya." />
        </View>
      ) : (
        <FlatList
          data={rest}
          keyExtractor={(u: any) => u.uid}
          contentContainerStyle={{ paddingBottom: (user && !meInList ? 90 : 30) + insets.bottom }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => { q.refetch(); me.refetch(); }} tintColor={BRAND} />}
          ListHeaderComponent={podium.length ? <Podium users={podium} by={by} unit={unit} palette={p} width={width} onOpen={open} /> : null}
          ListEmptyComponent={
            podium.length ? null : (
              <View style={{ marginTop: 30 }}>
                <SectionEmpty palette={p} icon="trophy-outline" text="Abhi rankings ban rahi hain. Battle jeeto aur sabse upar aao!" />
              </View>
            )
          }
          renderItem={({ item, index }) => (
            <Row user={item} rank={restStartRank + index} score={leaderboardScore(item, by)} unit={unit} palette={p} isMe={item.uid === user?.uid} onOpen={open} />
          )}
          initialNumToRender={12}
        />
      )}

      {user && me.data?.rank && !meInList ? (
        <View style={[styles.meBar, { bottom: insets.bottom + 12 }]} accessibilityLabel={`Your rank ${me.data.rank}, ${me.data.score} ${unit}`}>
          <LinearGradient colors={BRAND_GRAD} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.meInner}>
            <Text style={styles.meRank}>#{compactCount(me.data.rank)}</Text>
            <Text style={styles.meLabel}>Aapki rank</Text>
            <View style={{ flex: 1 }} />
            <Text style={styles.meScore}>{compactCount(me.data.score)} {unit}</Text>
          </LinearGradient>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

function Podium({
  users,
  by,
  unit,
  palette: p,
  width,
  onOpen,
}: {
  users: any[];
  by: LeaderboardBy;
  unit: string;
  palette: ExplorePalette;
  width: number;
  onOpen: (uid: string) => void;
}) {
  const colW = (width - PAD * 2) / 3;
  const order = [1, 0, 2];
  return (
    <View style={styles.podium}>
      {order.map((i) => {
        const u = users[i];
        const first = i === 0;
        const size = first ? 86 : 66;
        return (
          <ScaleTouchable
            key={u.uid}
            style={{ width: colW, alignItems: 'center', marginTop: first ? 0 : i === 1 ? 26 : 40 }}
            onPress={() => onOpen(u.uid)}
            accessibilityRole="link"
            accessibilityLabel={`Rank ${i + 1}, ${u.username || u.fullName}, ${leaderboardScore(u, by)} ${unit}`}
          >
            <View style={{ alignItems: 'center' }}>
              {first && <MaterialCommunityIcons name="crown" size={30} color={MEDAL[0]} style={{ marginBottom: -4 }} />}
              <View style={[styles.podiumRing, { borderColor: MEDAL[i] }]}>
                <Avatar uri={u.profileImageUrlThumb || u.profileImageUrl} name={u.fullName || u.username} size={size} />
              </View>
              <View style={[styles.medal, { backgroundColor: MEDAL[i], top: size - 6 + (first ? 26 : 0) }]}>
                <Text style={styles.medalText}>{i + 1}</Text>
              </View>
              <View style={[styles.nameRow, { marginTop: 16 }]}>
                <Text style={[styles.podiumName, { color: p.text }]} numberOfLines={1}>{u.fullName || u.username}</Text>
                <VerifiedBadge verified={u.verified} size={12} />
              </View>
              <Text style={[styles.podiumScore, { color: first ? '#D97706' : p.sub }]}>
                {compactCount(leaderboardScore(u, by))} {unit}
              </Text>
            </View>
          </ScaleTouchable>
        );
      })}
    </View>
  );
}

const Row = React.memo(function Row({
  user: u,
  rank,
  score,
  unit,
  palette: p,
  isMe,
  onOpen,
}: {
  user: any;
  rank: number;
  score: number;
  unit: string;
  palette: ExplorePalette;
  isMe: boolean;
  onOpen: (uid: string) => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: isMe ? (p.isDark ? '#2A1A22' : '#FFF1F3') : p.card, borderColor: isMe ? BRAND : p.border }]}
      onPress={() => onOpen(u.uid)}
      accessibilityRole="link"
      accessibilityLabel={`Rank ${rank}, ${u.username || u.fullName}, ${score} ${unit}`}
    >
      <Text style={[styles.rank, { color: p.sub }]}>{rank}</Text>
      <Avatar uri={u.profileImageUrlThumb || u.profileImageUrl} name={u.fullName || u.username} size={44} />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <View style={styles.nameRow}>
          <Text style={[styles.rowName, { color: p.text }]} numberOfLines={1}>{u.fullName || u.username}</Text>
          <VerifiedBadge verified={u.verified} size={13} />
          {Number(u.level) > 0 ? (
            <View style={[styles.level, { backgroundColor: p.chip }]}>
              <Text style={[styles.levelText, { color: p.text }]}>Lv {u.level}</Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.handle, { color: p.sub }]} numberOfLines={1}>@{u.username}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[styles.score, { color: BRAND }]}>{compactCount(score)}</Text>
        <Text style={[styles.unit, { color: p.sub }]}>{unit}</Text>
      </View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  headerTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  tabs: { flexDirection: 'row', marginHorizontal: PAD, borderRadius: 14, padding: 4, marginBottom: 6 },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 9, borderRadius: 11 },
  tabText: { fontSize: 13, fontFamily: 'Urbanist-Bold' },
  podium: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: PAD, paddingTop: 20, paddingBottom: 18 },
  podiumRing: { padding: 3, borderRadius: 60, borderWidth: 3 },
  medal: { position: 'absolute', width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#FFF' },
  medalText: { fontSize: 11, fontFamily: 'Urbanist-Black', color: '#3B2A00' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' },
  podiumName: { fontSize: 13, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  podiumScore: { fontSize: 13, fontFamily: 'Urbanist-Black', marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', marginHorizontal: PAD, marginBottom: 10, padding: 12, borderRadius: 16, borderWidth: 1 },
  rank: { width: 30, fontSize: 15, fontFamily: 'Urbanist-Black' },
  rowName: { fontSize: 15, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  handle: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 1 },
  level: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6 },
  levelText: { fontSize: 10, fontFamily: 'Urbanist-Bold' },
  score: { fontSize: 16, fontFamily: 'Urbanist-Black' },
  unit: { fontSize: 10, fontFamily: 'Urbanist-SemiBold' },
  meBar: { position: 'absolute', left: PAD, right: PAD, borderRadius: 16, overflow: 'hidden' },
  meInner: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 14 },
  meRank: { color: '#FFF', fontSize: 18, fontFamily: 'Urbanist-Black' },
  meLabel: { color: 'rgba(255,255,255,0.9)', fontSize: 13, fontFamily: 'Urbanist-SemiBold' },
  meScore: { color: '#FFF', fontSize: 15, fontFamily: 'Urbanist-Bold' },
});
