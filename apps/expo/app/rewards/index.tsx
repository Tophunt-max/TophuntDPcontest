import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import { emitToast } from '@/src/lib/toastBridge';
import { useAuth } from '@/src/hooks/useAuth';
import { BRAND, BRAND_GRAD, PAD, useExplorePalette, type ExplorePalette } from '@/src/components/explore/theme';
import { SectionError } from '@/src/components/explore/ExploreBits';
import { LevelProgressBar } from '@/src/components/gamification/LevelProgressBar';
import { LevelUpCelebration } from '@/src/components/gamification/LevelUpCelebration';
import { RarityPill } from '@/src/components/gamification/RarityPill';
import { FEATURE_LABELS, assetColors, formatXp, timeLeft } from '@/src/lib/progression';
import {
  useClaimQuest,
  useClaimRewardGrant,
  useProgression,
  useQuests,
  type ProgressionView,
  type QuestView,
} from '@/src/services/gamification';

/**
 * Level & Rewards: the user's level, rank and XP, the level roadmap, quests,
 * rewards to claim, and entry points to achievements, inventory, leaderboards
 * and insights. Every number is the server's (getProgression).
 */
export default function RewardsScreen() {
  const p = useExplorePalette();
  const router = useRouter();
  const { user } = useAuth();
  const q = useProgression(!!user);
  const data = q.data;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: p.bg }]} edges={['top']}>
      <View style={styles.header}>
        <BackButton size={24} color={p.text} style={{ marginRight: 12 }} />
        <Text style={[styles.headerTitle, { color: p.text }]} accessibilityRole="header">Level & Rewards</Text>
      </View>
      {data ? (
        <LevelUpCelebration
          uid={user?.uid}
          level={data.levelInfo.level}
          rankName={data.levelInfo.rank.name}
          unlocks={data.leveledUp ? data.roadmap.filter((m) => m.level > data.leveledUp!.from && m.level <= data.leveledUp!.to).map((m) => m.title) : undefined}
        />
      ) : null}
      {q.isLoading ? (
        <View style={styles.center}><ActivityIndicator color={BRAND} /></View>
      ) : q.isError || !data ? (
        <View style={{ marginTop: 30 }}>
          <SectionError palette={p} onRetry={() => q.refetch()} label="Rewards load nahi ho paye. Internet check karke retry karo." />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={BRAND} />}
        >
          <Hero data={data} p={p} />
          {data.enabled ? <Grants data={data} p={p} /> : null}
          <Links data={data} p={p} onOpen={(r) => router.push(r as any)} />
          {data.enabled && data.season ? <SeasonCard season={data.season} p={p} onOpen={() => router.push('/rewards/leaderboard?period=season' as any)} /> : null}
          {data.enabled ? <Quests p={p} /> : (
            <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
              <Text style={[styles.cardTitle, { color: p.text }]}>Quests and seasons are coming soon</Text>
              <Text style={[styles.muted, { color: p.sub }]}>You keep earning XP from voting, battles and check-ins in the meantime.</Text>
            </View>
          )}
          <Roadmap data={data} p={p} />
          <Recent data={data} p={p} onMore={() => router.push('/rewards/history' as any)} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Hero({ data, p }: { data: ProgressionView; p: ExplorePalette }) {
  const info = data.levelInfo;
  return (
    <LinearGradient colors={[`${info.rank.color}33`, 'transparent']} style={[styles.hero, { borderColor: p.border }]}>
      <View style={styles.heroTop}>
        <LinearGradient colors={['#FFD700', '#FFA500']} style={styles.levelCircle}>
          <Text style={styles.levelCircleText} accessibilityLabel={`Level ${info.level}`}>{info.level}</Text>
        </LinearGradient>
        <View style={{ flex: 1, marginLeft: 14 }}>
          <View style={styles.rankRow}>
            <Ionicons name={info.rank.icon} size={16} color={info.rank.color} />
            <Text style={[styles.rankName, { color: info.rank.color }]}>{data.cosmetics.title?.text ?? info.rank.name}</Text>
          </View>
          <Text style={[styles.lifetime, { color: p.text }]}>{formatXp(info.xp)} XP</Text>
          <Text style={[styles.muted, { color: p.sub }]}>
            {info.isMaxLevel
              ? 'Maximum level reached. XP keeps counting.'
              : info.nextRank
                ? `${info.nextRank.name} at level ${info.nextRank.minLevel}`
                : `${formatXp(info.xpToNextLevel)} XP to level ${info.level + 1}`}
          </Text>
        </View>
      </View>
      <View style={{ marginTop: 14 }}>
        <LevelProgressBar info={info} isDark={p.isDark} />
      </View>
      {info.nextMilestone ? (
        <Text style={[styles.next, { color: p.text }]}>
          Next unlock · Level {info.nextMilestone.level}: <Text style={{ fontFamily: 'Urbanist-Bold' }}>{info.nextMilestone.title}</Text>
        </Text>
      ) : null}
    </LinearGradient>
  );
}

function Grants({ data, p }: { data: ProgressionView; p: ExplorePalette }) {
  const claim = useClaimRewardGrant();
  if (!data.rewards.claimable.length) return null;
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
      <Text style={[styles.cardTitle, { color: p.text }]}>Rewards to claim</Text>
      {!data.rewards.budgetAvailable ? (
        <Text style={[styles.muted, { color: p.sub }]}>Diamond rewards are paused right now. Yours are saved and can be claimed later.</Text>
      ) : null}
      {data.rewards.claimable.map((g) => (
        <View key={g.id} style={styles.grantRow}>
          <Ionicons name="diamond" size={18} color="#29B6F6" />
          <Text style={[styles.grantText, { color: p.text }]} numberOfLines={2}>{g.note || 'Reward'} · {g.coins} Diamond</Text>
          <TouchableOpacity
            style={[styles.smallBtn, (!data.rewards.budgetAvailable || claim.isPending) && { opacity: 0.5 }]}
            disabled={!data.rewards.budgetAvailable || claim.isPending}
            onPress={() =>
              claim.mutate(g.id, {
                onSuccess: (r) => emitToast(`+${r.coins} Diamond added to your wallet`, 'success'),
                onError: (e: any) => emitToast(e?.message || 'Could not claim right now', 'error'),
              })
            }
            accessibilityRole="button"
            accessibilityLabel={`Claim ${g.coins} Diamond`}
          >
            <Text style={styles.smallBtnText}>Claim</Text>
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

function Links({ data, p, onOpen }: { data: ProgressionView; p: ExplorePalette; onOpen: (route: string) => void }) {
  const items = [
    { icon: 'ribbon', label: 'Achievements', sub: `${data.achievements.unlocked}/${data.achievements.total}`, route: '/rewards/achievements' },
    { icon: 'color-palette', label: 'Inventory', sub: 'Frames & titles', route: '/rewards/inventory' },
    { icon: 'podium', label: 'Leaderboards', sub: 'Week · Month · All', route: '/rewards/leaderboard' },
    { icon: 'trophy', label: 'Hall of Fame', sub: 'Champions', route: '/rewards/hall-of-fame' },
    { icon: 'stats-chart', label: 'Insights', sub: 'Your stats', route: '/rewards/insights' },
    { icon: 'time-outline', label: 'XP history', sub: 'Every XP event', route: '/rewards/history' },
  ];
  return (
    <View style={styles.links}>
      {items.map((it) => (
        <TouchableOpacity
          key={it.route}
          style={[styles.link, { backgroundColor: p.card, borderColor: p.border }]}
          onPress={() => onOpen(it.route)}
          accessibilityRole="button"
          accessibilityLabel={`${it.label}, ${it.sub}`}
        >
          <Ionicons name={it.icon} size={20} color={BRAND} />
          <Text style={[styles.linkLabel, { color: p.text }]}>{it.label}</Text>
          <Text style={[styles.linkSub, { color: p.sub }]} numberOfLines={1}>{it.sub}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function SeasonCard({ season, p, onOpen }: { season: NonNullable<ProgressionView['season']>; p: ExplorePalette; onOpen: () => void }) {
  return (
    <TouchableOpacity onPress={onOpen} accessibilityRole="button" accessibilityLabel={`${season.name}, ${season.xp} season XP`}>
      <LinearGradient colors={BRAND_GRAD} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.season}>
        <Ionicons name="medal" size={24} color="#FFF" />
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={styles.seasonTitle}>{season.name}</Text>
          <Text style={styles.seasonSub}>
            {formatXp(season.xp)} season XP{season.rank ? ` · Rank #${season.rank}` : ''} · ends in {timeLeft(season.endsAt)}
          </Text>
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
}

function Quests({ p }: { p: ExplorePalette }) {
  const q = useQuests(true);
  const claim = useClaimQuest();
  if (q.isLoading) return <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}><ActivityIndicator color={BRAND} /></View>;
  if (q.isError) return <SectionError palette={p} onRetry={() => q.refetch()} label="Quests load nahi ho paye." />;
  const quests = q.data?.quests ?? [];
  if (!quests.length) return null;
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
      <Text style={[styles.cardTitle, { color: p.text }]}>Weekly & monthly quests</Text>
      {quests.map((qq: QuestView) => (
        <View key={qq.id} style={styles.questRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.questTitle, { color: qq.locked ? p.sub : p.text }]}>{qq.title}</Text>
            <Text style={[styles.muted, { color: p.sub }]}>
              {qq.locked ? `Unlocks at level ${qq.minLevel}` : `${qq.progress}/${qq.target} · +${qq.xp} XP · resets in ${timeLeft(qq.resetsAt)}`}
            </Text>
            {!qq.locked ? (
              <View style={[styles.miniBar, { backgroundColor: p.chip }]}>
                <View style={[styles.miniFill, { width: `${Math.min(100, (qq.progress / Math.max(1, qq.target)) * 100)}%` }]} />
              </View>
            ) : null}
          </View>
          {qq.claimed ? (
            <Ionicons name="checkmark-circle" size={22} color="#22C55E" />
          ) : qq.locked ? (
            <Ionicons name="lock-closed" size={18} color={p.sub} />
          ) : (
            <TouchableOpacity
              style={[styles.smallBtn, (!qq.claimable || claim.isPending) && { opacity: 0.4 }]}
              disabled={!qq.claimable || claim.isPending}
              onPress={() =>
                claim.mutate(qq.id, {
                  onSuccess: (r) => emitToast(`+${r.xpEarned} XP`, 'success'),
                  onError: (e: any) => emitToast(e?.message || 'Could not claim', 'error'),
                })
              }
              accessibilityRole="button"
              accessibilityLabel={`Claim ${qq.title}`}
              accessibilityState={{ disabled: !qq.claimable }}
            >
              <Text style={styles.smallBtnText}>Claim</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}
    </View>
  );
}

function Roadmap({ data, p }: { data: ProgressionView; p: ExplorePalette }) {
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
      <Text style={[styles.cardTitle, { color: p.text }]}>Level roadmap</Text>
      {data.roadmap.map((m) => (
        <View key={m.level} style={styles.roadRow} accessible accessibilityLabel={`Level ${m.level}: ${m.title}. ${m.unlocked ? 'Unlocked' : 'Locked'}.`}>
          <View style={[styles.roadDot, { backgroundColor: m.unlocked ? BRAND : p.chip }]}>
            {m.unlocked ? <Ionicons name="checkmark" size={14} color="#FFF" /> : <Text style={[styles.roadLevel, { color: p.sub }]}>{m.level}</Text>}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.roadTitle, { color: m.unlocked ? p.text : p.sub }]}>Level {m.level} · {m.title}</Text>
            <Text style={[styles.muted, { color: p.sub }]}>{m.description}</Text>
            <View style={styles.roadItems}>
              {m.feature ? (
                <View style={[styles.featurePill, { backgroundColor: p.chip }]}>
                  <Text style={[styles.featureText, { color: p.text }]}>{FEATURE_LABELS[m.feature] ?? m.feature}</Text>
                </View>
              ) : null}
              {m.items.map((it) => (
                <View key={it.id} style={[styles.itemChip, { borderColor: assetColors(it.asset)[0] }]}>
                  <Text style={[styles.featureText, { color: p.text }]} numberOfLines={1}>{it.name}</Text>
                  <RarityPill rarity={it.rarity} />
                </View>
              ))}
              {m.coins > 0 && data.enabled ? (
                <View style={[styles.featurePill, { backgroundColor: p.chip }]}>
                  <Text style={[styles.featureText, { color: p.text }]}>{m.coins} Diamond</Text>
                </View>
              ) : null}
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

function Recent({ data, p, onMore }: { data: ProgressionView; p: ExplorePalette; onMore: () => void }) {
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
      <View style={styles.rowBetween}>
        <Text style={[styles.cardTitle, { color: p.text }]}>Recent XP</Text>
        <TouchableOpacity onPress={onMore} accessibilityRole="button"><Text style={styles.more}>See all</Text></TouchableOpacity>
      </View>
      {data.recentXp.length === 0 ? (
        <Text style={[styles.muted, { color: p.sub }]}>No XP yet. Vote in a battle or check in to start.</Text>
      ) : (
        data.recentXp.map((e) => (
          <View key={e.id} style={styles.rowBetween}>
            <Text style={[styles.eventLabel, { color: p.text }]}>{e.label}</Text>
            <Text style={[styles.eventDelta, { color: e.delta >= 0 ? '#22C55E' : '#EF4444' }]}>{e.delta >= 0 ? '+' : ''}{e.delta} XP</Text>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  headerTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hero: { marginHorizontal: PAD, borderRadius: 20, padding: 18, borderWidth: 1 },
  heroTop: { flexDirection: 'row', alignItems: 'center' },
  levelCircle: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  levelCircleText: { color: '#FFF', fontSize: 26, fontFamily: 'Urbanist-Black' },
  rankRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rankName: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  lifetime: { fontSize: 22, fontFamily: 'Urbanist-Black', marginTop: 2 },
  muted: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  next: { fontSize: 13, fontFamily: 'Urbanist-Medium', marginTop: 10 },
  card: { marginHorizontal: PAD, marginTop: 14, borderRadius: 18, padding: 16, borderWidth: 1 },
  cardTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 8 },
  grantRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  grantText: { flex: 1, fontSize: 13, fontFamily: 'Urbanist-SemiBold' },
  smallBtn: { backgroundColor: BRAND, paddingHorizontal: 14, paddingVertical: 7, borderRadius: 14 },
  smallBtnText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 12 },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingHorizontal: PAD, marginTop: 14 },
  link: { flexBasis: '30%', flexGrow: 1, minWidth: 100, borderRadius: 16, padding: 12, borderWidth: 1, gap: 4 },
  linkLabel: { fontSize: 13, fontFamily: 'Urbanist-Bold' },
  linkSub: { fontSize: 11, fontFamily: 'Urbanist-Medium' },
  season: { marginHorizontal: PAD, marginTop: 14, borderRadius: 18, padding: 16, flexDirection: 'row', alignItems: 'center' },
  seasonTitle: { color: '#FFF', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  seasonSub: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  questRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  questTitle: { fontSize: 14, fontFamily: 'Urbanist-SemiBold' },
  miniBar: { height: 6, borderRadius: 3, marginTop: 6, overflow: 'hidden' },
  miniFill: { height: '100%', backgroundColor: BRAND, borderRadius: 3 },
  roadRow: { flexDirection: 'row', gap: 12, paddingVertical: 10 },
  roadDot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  roadLevel: { fontSize: 11, fontFamily: 'Urbanist-Bold' },
  roadTitle: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  roadItems: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  featurePill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  featureText: { fontSize: 11, fontFamily: 'Urbanist-SemiBold' },
  itemChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1, maxWidth: 220 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  more: { color: BRAND, fontFamily: 'Urbanist-Bold', fontSize: 13 },
  eventLabel: { fontSize: 13, fontFamily: 'Urbanist-Medium' },
  eventDelta: { fontSize: 13, fontFamily: 'Urbanist-Bold' },
});
