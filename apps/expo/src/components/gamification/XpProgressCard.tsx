import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { formatXp, FEATURE_LABELS, type LevelInfo } from '@/src/lib/progression';
import { milestoneState, tierForRank, type MilestoneState } from '@/src/lib/gamificationAssets';
import type { ExplorePalette } from '@/src/components/explore/theme';
import type { RoadmapEntry } from '@/src/services/gamification';
import { LevelBadge } from './LevelBadge';
import { LevelProgressBar } from './LevelProgressBar';
import { GamificationIcon } from './GamificationIcon';
import { CosmeticPreview, RewardCard, RewardSheet } from './RewardBits';
import { RewardClaimReveal } from './MotionBits';

/**
 * Level, rank, lifetime XP, progress to the next level and the next milestone.
 * Everything comes from the server's `levelInfo`; at max level the card says
 * so instead of computing a progress figure.
 */
export function XpProgressCard({ info, title, p, gain }: { info: LevelInfo; title?: string | null; p: ExplorePalette; /** Floating +XP slot (XpGainFloat). */ gain?: React.ReactNode }) {
  const tier = tierForRank(info.rank.id, { isMaxLevel: info.isMaxLevel });
  return (
    <LinearGradient colors={[`${tier.colors[0]}55`, 'transparent']} style={[styles.card, { borderColor: p.border }]}>
      <View style={styles.top}>
        <LevelBadge level={info.level} rankId={info.rank.id} rankName={info.rank.name} isMaxLevel={info.isMaxLevel} size="lg" />
        <View style={{ flex: 1, marginLeft: 14 }}>
          <Text style={[styles.rank, { color: tier.colors[1] }]} numberOfLines={1}>
            {title ?? info.rank.name} · {tier.label}
          </Text>
          <View style={styles.xpRow} accessible accessibilityLabel={`${formatXp(info.xp)} lifetime XP`}>
            <GamificationIcon assetKey="xp.lifetime" size={16} />
            <Text style={[styles.xp, { color: p.text }]}>{formatXp(info.xp)} XP</Text>
          </View>
          <Text style={[styles.sub, { color: p.sub }]}>
            {info.isMaxLevel
              ? 'Maximum level reached — XP keeps counting.'
              : `${formatXp(info.xpToNextLevel)} XP to level ${info.level + 1}`}
          </Text>
        </View>
      </View>
      <View style={{ marginTop: 14 }}>
        <LevelProgressBar info={info} isDark={p.isDark} />
        {gain}
      </View>
      {info.nextMilestone ? (
        <View style={styles.nextRow}>
          <GamificationIcon assetKey="reward.milestone" size={16} />
          <Text style={[styles.next, { color: p.text }]} numberOfLines={2}>
            Next unlock at level {info.nextMilestone.level}: <Text style={{ fontFamily: 'Urbanist-Bold' }}>{info.nextMilestone.title}</Text>
          </Text>
        </View>
      ) : null}
    </LinearGradient>
  );
}

const NODE_COLORS: Record<MilestoneState, string> = { locked: '#9AA3AD', available: '#FF4D67', unlocked: '#22C55E', claimed: '#22C55E' };
const NODE_LABEL: Record<MilestoneState, string> = { locked: 'Locked', available: 'Reward ready', unlocked: 'Unlocked', claimed: 'Claimed' };

/**
 * The level roadmap: one node per milestone, with its state (from the server's
 * roadmap entry) shown by icon, label and colour. Tapping a node opens a sheet
 * with the rewards it carries; claiming goes through `onClaim` (the Worker).
 */
export function LevelRoadmap({
  roadmap,
  p,
  avatarUri,
  name,
  onClaim,
  claimableGrantFor,
  busy,
}: {
  roadmap: RoadmapEntry[];
  p: ExplorePalette;
  avatarUri?: string | null;
  name?: string | null;
  onClaim?: (grantId: string) => void;
  claimableGrantFor?: (level: number) => string | null;
  busy?: boolean;
}) {
  const [open, setOpen] = useState<RoadmapEntry | null>(null);
  return (
    <View>
      {roadmap.map((m, i) => {
        const st = milestoneState(m);
        return (
          <TouchableOpacity
            key={m.level}
            style={styles.node}
            onPress={() => setOpen(m)}
            accessibilityRole="button"
            accessibilityLabel={`Level ${m.level}: ${m.title}. ${NODE_LABEL[st]}.`}
          >
            <View style={styles.rail}>
              <View style={[styles.dot, { backgroundColor: st === 'locked' ? p.chip : NODE_COLORS[st], borderColor: NODE_COLORS[st] }]}>
                <GamificationIcon
                  assetKey={st === 'locked' ? 'reward.locked' : st === 'available' ? 'reward.claimable' : 'reward.claimed'}
                  size={st === 'locked' ? 24 : 16}
                  color={st === 'locked' ? undefined : '#FFFFFF'}
                />
              </View>
              {i < roadmap.length - 1 ? <View style={[styles.line, { backgroundColor: m.unlocked ? '#22C55E66' : p.border }]} /> : null}
            </View>
            <View style={{ flex: 1, paddingBottom: 14 }}>
              <Text style={[styles.nodeTitle, { color: m.unlocked ? p.text : p.sub }]}>Level {m.level} · {m.title}</Text>
              <Text style={[styles.sub, { color: NODE_COLORS[st] }]}>{NODE_LABEL[st]}</Text>
              <View style={styles.previews}>
                {m.items.slice(0, 4).map((it) => (
                  <CosmeticPreview key={it.id} item={{ ...it, owned: it.owned ?? m.unlocked }} size={34} avatarUri={avatarUri} name={name} />
                ))}
                {m.coins > 0 ? (
                  <View style={[styles.chip, { backgroundColor: p.chip }]}>
                    <GamificationIcon assetKey="reward.diamond" size={12} />
                    <Text style={[styles.chipText, { color: p.text }]}>{m.coins}</Text>
                  </View>
                ) : null}
                {m.feature ? (
                  <View style={[styles.chip, { backgroundColor: p.chip }]}>
                    <Text style={[styles.chipText, { color: p.text }]}>{FEATURE_LABELS[m.feature] ?? m.feature}</Text>
                  </View>
                ) : null}
              </View>
            </View>
          </TouchableOpacity>
        );
      })}
      <RewardSheet visible={!!open} onClose={() => setOpen(null)} p={p} title={open ? `Level ${open.level} · ${open.title}` : ''}>
        {open ? (
          <View style={{ gap: 10 }}>
            <Text style={[styles.sub, { color: p.sub }]}>{open.description}</Text>
            {open.items.map((it) => (
              <RewardCard
                key={it.id}
                p={p}
                title={it.name}
                subtitle={it.type}
                assetKey={it.type === 'frame' ? undefined : `cosmetic.${it.type}`}
                rarity={it.rarity}
                state={it.owned ? 'claimed' : open.unlocked ? 'unlocked' : 'locked'}
              />
            ))}
            {open.coins > 0 ? (
              <RewardCard
                p={p}
                title={`${open.coins} Diamond`}
                subtitle={open.rewardState === 'ineligible' ? 'Reached before coin rewards started.' : 'Paid from the rewards budget.'}
                assetKey="reward.diamond"
                state={open.rewardState === 'ineligible' ? 'unavailable' : milestoneState(open)}
              />
            ) : null}
            {open.coins > 0 && open.rewardState === 'claimable' && claimableGrantFor?.(open.level) ? (
              <View style={{ alignItems: 'flex-end' }}>
                <RewardClaimReveal grantId={claimableGrantFor(open.level)!} p={p} onClaimed={onClaim ? () => onClaim(claimableGrantFor(open.level)!) : undefined} />
              </View>
            ) : null}
            {!open.items.length && !open.coins ? (
              <Text style={[styles.sub, { color: p.text }]}>Unlocks: {open.feature ? FEATURE_LABELS[open.feature] ?? open.feature : open.title}</Text>
            ) : null}
          </View>
        ) : null}
      </RewardSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 20, padding: 18, borderWidth: 1 },
  top: { flexDirection: 'row', alignItems: 'center' },
  rank: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  xpRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  xp: { fontSize: 22, fontFamily: 'Urbanist-Black' },
  sub: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  nextRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  next: { fontSize: 13, fontFamily: 'Urbanist-Medium', flexShrink: 1 },
  node: { flexDirection: 'row', gap: 12 },
  rail: { alignItems: 'center', width: 30 },
  dot: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  line: { width: 2, flex: 1, marginTop: 2 },
  nodeTitle: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  previews: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  chipText: { fontSize: 11, fontFamily: 'Urbanist-SemiBold' },
});
