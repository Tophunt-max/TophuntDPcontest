import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { BackButton } from '@/src/components/ui/BackButton';
import { emitToast } from '@/src/lib/toastBridge';
import { useAuth } from '@/src/hooks/useAuth';
import { BRAND, BRAND_GRAD, PAD, useExplorePalette, type ExplorePalette } from '@/src/components/explore/theme';
import { SectionError } from '@/src/components/explore/ExploreBits';
import { LevelUpCelebration } from '@/src/components/gamification/LevelUpCelebration';
import { GamificationIcon } from '@/src/components/gamification/GamificationIcon';
import { LevelRoadmap, XpProgressCard } from '@/src/components/gamification/XpProgressCard';
import { GamificationError, GamificationLoading, RewardCard, XpGainPill } from '@/src/components/gamification/RewardBits';
import { AchievementUnlockToast, AnimatedCheck, AnimatedMiniBar, RewardClaimReveal } from '@/src/components/gamification/MotionBits';
import { XpGainFloat } from '@/src/components/gamification/XpGainFloat';
import { useXpGainFeed } from '@/src/hooks/useXpGainFeed';
import { QUEST_ASSET, XP_ACTION_ASSET, type AssetKey } from '@/src/lib/gamificationAssets';
import { formatXp, timeLeft } from '@/src/lib/progression';
import {
  useClaimQuest,
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
  // One floating +XP per NEW server event (deduped per device by event id).
  const feed = useXpGainFeed(user?.uid, data?.recentXp);

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
          rankId={data.levelInfo.rank.id}
          rankName={data.levelInfo.rank.name}
          isMaxLevel={data.levelInfo.isMaxLevel}
          previousLevel={data.leveledUp?.from ?? null}
          xpGained={data.recentXp[0] ? { amount: data.recentXp[0].delta, label: data.recentXp[0].label } : null}
          unlocks={data.leveledUp ? data.roadmap.filter((m) => m.level > data.leveledUp!.from && m.level <= data.leveledUp!.to).map((m) => m.title) : undefined}
          onView={() => router.push('/rewards/inventory' as any)}
        />
      ) : null}
      {q.isLoading ? (
        <View style={{ padding: PAD, gap: 14 }}>
          <GamificationLoading p={p} height={190} />
          <GamificationLoading p={p} height={90} />
        </View>
      ) : q.isError || !data ? (
        <View style={{ margin: PAD }}>
          <GamificationError p={p} onRetry={() => q.refetch()} text="Rewards load nahi ho paye. Internet check karke retry karo." />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={BRAND} />}
        >
          <View style={{ paddingHorizontal: PAD }}>
            <XpProgressCard
              info={data.levelInfo}
              title={data.cosmetics.title?.text}
              p={p}
              gain={<XpGainFloat item={feed.current} onDone={feed.done} />}
            />
          </View>
          {data.enabled ? <Grants data={data} p={p} /> : null}
          <Links data={data} p={p} onOpen={(r) => router.push(r as any)} />
          {data.enabled && data.season ? <SeasonCard season={data.season} p={p} onOpen={() => router.push('/rewards/leaderboard?period=season' as any)} /> : null}
          {data.enabled ? <Quests p={p} /> : (
            <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
              <Text style={[styles.cardTitle, { color: p.text }]}>Quests and seasons are coming soon</Text>
              <Text style={[styles.muted, { color: p.sub }]}>You keep earning XP from voting, battles and check-ins in the meantime.</Text>
            </View>
          )}
          <Roadmap data={data} p={p} avatarUri={user?.photoURL ?? null} name={user?.displayName ?? null} />
          <Recent data={data} p={p} onMore={() => router.push('/rewards/history' as any)} />
        </ScrollView>
      )}
      {data ? <AchievementUnlockToast uid={user?.uid} unlocked={data.newlyUnlocked} /> : null}
    </SafeAreaView>
  );
}

function Grants({ data, p }: { data: ProgressionView; p: ExplorePalette }) {
  // Rewards the server confirmed in this session. The claim refetches the
  // list (the grant leaves `claimable`), so the confirmed result is kept here
  // and shown as "Claimed" with the server's amount.
  const [done, setDone] = useState<{ id: string; coins: number; note: string | null }[]>([]);
  const pending = data.rewards.claimable.filter((g) => !done.some((d) => d.id === g.id));
  if (!pending.length && !done.length) return null;
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border, gap: 10 }]}>
      <Text style={[styles.cardTitle, { color: p.text }]}>Rewards to claim</Text>
      {!data.rewards.budgetAvailable && pending.length ? (
        <Text style={[styles.muted, { color: p.sub }]}>Diamond rewards are paused right now. Yours are saved and can be claimed later.</Text>
      ) : null}
      {done.map((g) => (
        <RewardCard key={g.id} p={p} title={`+${g.coins} Diamond`} subtitle={g.note || 'Added to your wallet'} assetKey="reward.diamond" state="claimed" />
      ))}
      {pending.map((g) => (
        <RewardCard
          key={g.id}
          p={p}
          title={`${g.coins} Diamond`}
          subtitle={g.note || (g.sourceType === 'season' ? 'Season reward' : 'Level milestone')}
          assetKey={g.sourceType === 'season' ? 'reward.seasonal' : 'reward.diamond'}
          state={data.rewards.budgetAvailable ? 'available' : 'unavailable'}
          trailing={
            data.rewards.budgetAvailable ? (
              <RewardClaimReveal grantId={g.id} p={p} onClaimed={(coins) => setDone((d) => [...d, { id: g.id, coins, note: g.note }].slice(-10))} />
            ) : null
          }
        />
      ))}
    </View>
  );
}

function Links({ data, p, onOpen }: { data: ProgressionView; p: ExplorePalette; onOpen: (route: string) => void }) {
  const items: { asset: AssetKey; label: string; sub: string; route: string }[] = [
    { asset: 'activity.achievement', label: 'Achievements', sub: `${data.achievements.unlocked}/${data.achievements.total}`, route: '/rewards/achievements' },
    { asset: 'activity.inventory', label: 'Inventory', sub: 'Frames & titles', route: '/rewards/inventory' },
    { asset: 'activity.leaderboard', label: 'Leaderboards', sub: 'Week · Month · All', route: '/rewards/leaderboard' },
    { asset: 'reward.hall_of_fame', label: 'Hall of Fame', sub: 'Champions', route: '/rewards/hall-of-fame' },
    { asset: 'activity.insights', label: 'Insights', sub: 'Your stats', route: '/rewards/insights' },
    { asset: 'xp.history', label: 'XP history', sub: 'Every XP event', route: '/rewards/history' },
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
          <GamificationIcon assetKey={it.asset} size={22} />
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
        <GamificationIcon assetKey="xp.seasonal" size={24} color="#FFF" />
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
  // Quests claimed as of the previous server snapshot: only a CHANGE to claimed animates.
  const prevClaimed = useRef<Set<string> | null>(null);
  const quests0 = q.data?.quests;
  useEffect(() => {
    if (quests0) prevClaimed.current = new Set(quests0.filter((x) => x.claimed).map((x) => x.id));
  }, [quests0]);
  if (q.isLoading) return <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}><ActivityIndicator color={BRAND} /></View>;
  if (q.isError) return <SectionError palette={p} onRetry={() => q.refetch()} label="Quests load nahi ho paye." />;
  const quests = q.data?.quests ?? [];
  if (!quests.length) return null;
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
      <Text style={[styles.cardTitle, { color: p.text }]}>Weekly & monthly quests</Text>
      {quests.map((qq: QuestView) => (
        <View key={qq.id} style={styles.questRow}>
          <View style={[styles.questIcon, { backgroundColor: p.chip }]}>
            <GamificationIcon assetKey={qq.locked ? 'reward.locked' : qq.minLevel > 1 ? 'activity.weekly_challenge' : QUEST_ASSET[qq.metric] ?? 'activity.daily_quest'} size={qq.locked ? 30 : 18} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.questTitle, { color: qq.locked ? p.sub : p.text }]}>{qq.title}</Text>
            <Text style={[styles.muted, { color: p.sub }]}>
              {qq.locked ? `Unlocks at level ${qq.minLevel}` : `${qq.progress}/${qq.target} · +${qq.xp} XP · resets in ${timeLeft(qq.resetsAt)}`}
            </Text>
            {!qq.locked ? <AnimatedMiniBar value={qq.progress} target={qq.target} track={p.chip} /> : null}
          </View>
          {qq.claimed ? (
            <AnimatedCheck done size={22} animate={!!prevClaimed.current && !prevClaimed.current.has(qq.id)} />
          ) : qq.locked ? null : (
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

function Roadmap({ data, p, avatarUri, name }: { data: ProgressionView; p: ExplorePalette; avatarUri: string | null; name: string | null }) {
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }]}>
      <Text style={[styles.cardTitle, { color: p.text }]}>Level roadmap</Text>
      <LevelRoadmap
        roadmap={data.roadmap}
        p={p}
        avatarUri={avatarUri}
        name={name}
        claimableGrantFor={(level) => data.rewards.claimable.find((g) => g.sourceType === 'level' && g.sourceId === String(level))?.id ?? null}
      />
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
            <View style={styles.eventLeft}>
              <GamificationIcon assetKey={XP_ACTION_ASSET[e.action] ?? 'xp.star'} size={16} />
              <Text style={[styles.eventLabel, { color: p.text }]}>{e.label}</Text>
            </View>
            <XpGainPill amount={e.delta} compact />
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
  questIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  eventLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
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
