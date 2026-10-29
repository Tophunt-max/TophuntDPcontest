import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BackButton } from '@/src/components/ui/BackButton';
import { Avatar } from '@/src/components/ui/Avatar';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';
import { Ionicons } from '@/src/lib/icons';
import { BRAND, PAD, useExplorePalette, type ExplorePalette } from '@/src/components/explore/theme';
import { SectionEmpty, SectionError } from '@/src/components/explore/ExploreBits';
import { formatXp } from '@/src/lib/progression';
import { useHallOfFame } from '@/src/services/gamification';

const MEDAL = ['#FFD54A', '#CBD5E1', '#F4A261'];

/** Monthly winners, season champions and Legends. Public. */
export default function HallOfFameScreen() {
  const p = useExplorePalette();
  const router = useRouter();
  const q = useHallOfFame();
  const d = q.data;
  const open = (uid: string) => router.push(`/profile?userId=${encodeURIComponent(uid)}` as any);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: p.bg }]} edges={['top']}>
      <View style={styles.header}>
        <BackButton size={24} color={p.text} style={{ marginRight: 12 }} />
        <Text style={[styles.headerTitle, { color: p.text }]} accessibilityRole="header">Hall of Fame</Text>
      </View>
      {q.isLoading ? (
        <View style={styles.center}><ActivityIndicator color={BRAND} /></View>
      ) : q.isError || !d ? (
        <View style={{ marginTop: 30 }}><SectionError palette={p} onRetry={() => q.refetch()} label="Hall of Fame load nahi ho paya." /></View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={BRAND} />}>
          <Section p={p} title="Legends" sub={`Level ${d.legendsMinLevel}+ by lifetime XP`}>
            {d.legends.length ? d.legends.map((r: any) => (
              <Person key={r.uid} p={p} rank={r.rank} name={r.fullName || r.username} avatar={r.profileImageUrlThumb || r.profileImageUrl} verified={r.verified} right={`${formatXp(r.score)} XP`} onPress={() => open(r.uid)} />
            )) : <SectionEmpty palette={p} icon="diamond-outline" text="No Legends yet. Be the first!" />}
          </Section>
          <Section p={p} title="Season champions">
            {d.seasons.length ? d.seasons.map((r: any) => (
              <Person key={`${r.seasonId}:${r.uid}`} p={p} rank={r.rank} name={r.username} avatar={r.profileImageUrlThumb || r.profileImageUrl} right={r.name} onPress={() => open(r.uid)} />
            )) : <SectionEmpty palette={p} icon="medal-outline" text="No finished seasons yet." />}
          </Section>
          <Section p={p} title="Monthly winners">
            {d.monthly.length ? d.monthly.map((r: any) => (
              <Person key={`${r.period}:${r.uid}`} p={p} rank={r.rank} name={r.username} avatar={r.profileImageUrlThumb || r.profileImageUrl} verified={r.verified} right={r.period} onPress={() => open(r.uid)} />
            )) : <SectionEmpty palette={p} icon="trophy-outline" text="No monthly winners yet." />}
          </Section>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Section({ p, title, sub, children }: { p: ExplorePalette; title: string; sub?: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 16 }}>
      <Text style={[styles.section, { color: p.text }]}>{title}</Text>
      {sub ? <Text style={[styles.sub, { color: p.sub }]}>{sub}</Text> : null}
      {children}
    </View>
  );
}

function Person({ p, rank, name, avatar, verified, right, onPress }: {
  p: ExplorePalette; rank: number; name: string; avatar?: string | null; verified?: boolean; right: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={[styles.row, { backgroundColor: p.card, borderColor: p.border }]} onPress={onPress} accessibilityRole="link" accessibilityLabel={`Rank ${rank}, ${name}, ${right}`}>
      {rank <= 3 ? <Ionicons name="trophy" size={18} color={MEDAL[rank - 1]} /> : <Text style={[styles.rank, { color: p.sub }]}>{rank}</Text>}
      <Avatar uri={avatar || undefined} name={name || 'user'} size={38} />
      <View style={styles.nameRow}>
        <Text style={[styles.name, { color: p.text }]} numberOfLines={1}>{name || 'user'}</Text>
        <VerifiedBadge verified={verified} size={12} />
      </View>
      <Text style={[styles.right, { color: p.sub }]} numberOfLines={1}>{right}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  headerTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  section: { fontSize: 17, fontFamily: 'Urbanist-Bold', paddingHorizontal: PAD },
  sub: { fontSize: 12, fontFamily: 'Urbanist-Medium', paddingHorizontal: PAD, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: PAD, marginTop: 8, padding: 12, borderRadius: 14, borderWidth: 1 },
  rank: { width: 18, fontSize: 13, fontFamily: 'Urbanist-Black', textAlign: 'center' },
  nameRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  name: { fontSize: 14, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  right: { fontSize: 12, fontFamily: 'Urbanist-SemiBold', maxWidth: 120 },
});
