import React from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import { useAuth } from '@/src/hooks/useAuth';
import { BRAND, PAD, useExplorePalette, type ExplorePalette } from '@/src/components/explore/theme';
import { SectionError } from '@/src/components/explore/ExploreBits';
import { formatXp } from '@/src/lib/progression';
import { useCreatorInsights } from '@/src/services/gamification';

/**
 * Creator insights: the user's own battle record, from data the platform
 * records. Nothing is estimated. The summary unlocks at the "stats summary"
 * milestone and trends at "advanced insights".
 */
export default function InsightsScreen() {
  const p = useExplorePalette();
  const { user } = useAuth();
  const q = useCreatorInsights(!!user);
  const d = q.data;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: p.bg }]} edges={['top']}>
      <View style={styles.header}>
        <BackButton size={24} color={p.text} style={{ marginRight: 12 }} />
        <Text style={[styles.headerTitle, { color: p.text }]} accessibilityRole="header">Creator insights</Text>
      </View>
      {q.isLoading ? (
        <View style={styles.center}><ActivityIndicator color={BRAND} /></View>
      ) : q.isError || !d ? (
        <View style={{ marginTop: 30 }}><SectionError palette={p} onRetry={() => q.refetch()} label="Insights load nahi ho paye." /></View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }} refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={BRAND} />}>
          <Card p={p} title="Profile checklist">
            {d.checklist.map((c: any) => (
              <View key={c.id} style={styles.checkRow}>
                <Ionicons name={c.done ? 'checkmark-circle' : 'radio-button-off'} size={18} color={c.done ? '#22C55E' : p.sub} />
                <Text style={[styles.body, { color: p.text }]}>{c.label}</Text>
              </View>
            ))}
          </Card>

          {d.summary ? (
            <Card p={p} title="Your record">
              <View style={styles.grid}>
                <Stat p={p} label="Battles entered" value={d.summary.entries} />
                <Stat p={p} label="Finished" value={d.summary.finished} />
                <Stat p={p} label="Wins" value={d.summary.wins} />
                <Stat p={p} label="Win rate" value={d.summary.winRate == null ? '—' : `${d.summary.winRate}%`} />
                <Stat p={p} label="Votes received" value={d.summary.votesReceived} />
                <Stat p={p} label="Avg votes / battle" value={d.summary.avgVotesPerBattle ?? '—'} />
                <Stat p={p} label="Votes cast" value={d.summary.votesCast} />
                <Stat p={p} label="Cancelled" value={d.summary.cancelled} />
              </View>
              <Text style={[styles.muted, { color: p.sub }]}>
                Photo: {d.summary.photo.entries} entered, {d.summary.photo.wins} won · Video: {d.summary.video.entries} entered, {d.summary.video.wins} won
                {d.summary.entriesCapped ? ' · based on your latest 500 entries' : ''}
              </Text>
            </Card>
          ) : (
            <Locked p={p} text={`Your stats summary unlocks at level ${d.summaryUnlocksAt}.`} />
          )}

          {d.trends ? (
            <Card p={p} title="Last 8 weeks">
              {d.trends.map((w: any) => (
                <View key={w.weekStart} style={styles.trendRow}>
                  <Text style={[styles.muted, { color: p.sub, width: 70 }]}>{new Date(w.weekStart).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</Text>
                  <View style={[styles.trendBar, { backgroundColor: p.chip }]}>
                    <View style={[styles.trendFill, { width: `${Math.min(100, (w.xp / Math.max(1, ...d.trends.map((t: any) => t.xp))) * 100)}%` }]} />
                  </View>
                  <Text style={[styles.muted, { color: p.text, width: 110, textAlign: 'right' }]}>{formatXp(w.xp)} XP · {w.entries}/{w.wins}</Text>
                </View>
              ))}
              <Text style={[styles.muted, { color: p.sub }]}>XP · battles entered / won, per week</Text>
            </Card>
          ) : d.summary ? (
            <Locked p={p} text={`Weekly trends unlock at level ${d.advancedUnlocksAt}.`} />
          ) : null}

          {d.tips?.length ? (
            <Card p={p} title="Tips">
              {d.tips.map((t: string, i: number) => (
                <View key={i} style={styles.checkRow}>
                  <Ionicons name="bulb-outline" size={16} color={BRAND} />
                  <Text style={[styles.body, { color: p.text }]}>{t}</Text>
                </View>
              ))}
            </Card>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Card({ p, title, children }: { p: ExplorePalette; title: string; children: React.ReactNode }) {
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
      <Text style={[styles.cardTitle, { color: p.text }]}>{title}</Text>
      {children}
    </View>
  );
}

function Stat({ p, label, value }: { p: ExplorePalette; label: string; value: React.ReactNode }) {
  return (
    <View style={[styles.stat, { backgroundColor: p.chip }]}>
      <Text style={[styles.statValue, { color: p.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: p.sub }]}>{label}</Text>
    </View>
  );
}

function Locked({ p, text }: { p: ExplorePalette; text: string }) {
  return (
    <View style={[styles.card, styles.lockedCard, { backgroundColor: p.card, borderColor: p.border }]}>
      <Ionicons name="lock-closed" size={18} color={p.sub} />
      <Text style={[styles.body, { color: p.sub }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  headerTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { marginHorizontal: PAD, marginTop: 14, borderRadius: 18, padding: 16, borderWidth: 1 },
  lockedCard: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 10 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  body: { fontSize: 13, fontFamily: 'Urbanist-Medium', flexShrink: 1 },
  muted: { fontSize: 11, fontFamily: 'Urbanist-Medium', marginTop: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { flexBasis: '47%', flexGrow: 1, borderRadius: 12, padding: 10 },
  statValue: { fontSize: 18, fontFamily: 'Urbanist-Black' },
  statLabel: { fontSize: 11, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  trendRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  trendBar: { flex: 1, height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 8 },
  trendFill: { height: '100%', backgroundColor: BRAND, borderRadius: 4 },
});
