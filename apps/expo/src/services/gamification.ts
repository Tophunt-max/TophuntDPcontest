/**
 * Levels, achievements, quests, cosmetics and XP leaderboards.
 * Server: apps/worker/src/lib/gamificationApi.ts (/api actions) and the
 * /read/gamification, /read/leaderboard/xp and /read/hall-of-fame routes.
 *
 * Every number here comes from the server. The client never sends an XP
 * amount, an unlock or an ownership claim — only which item to equip, which
 * quest or reward to claim.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { callApi, readApi, readApiLive } from '@/src/services/api';
import type { LevelInfo } from '@/src/lib/progression';

export interface CatalogItemView {
  id: string;
  type: string;
  name: string;
  rarity: string;
  asset: Record<string, any>;
  owned?: boolean;
}

export interface PublicCosmetics {
  frame: { id: string; name: string; rarity: string; asset: Record<string, any> } | null;
  theme: { id: string; name: string; rarity: string; asset: Record<string, any> } | null;
  title: { id: string; name: string; rarity: string; text: string } | null;
  badge: { id: string; name: string; rarity: string; asset: Record<string, any> } | null;
  accessory?: { id: string; name: string; rarity: string; asset: Record<string, any> } | null;
  effect?: { id: string; name: string; rarity: string; asset: Record<string, any> } | null;
  pinned: { id: string; name: string; icon: string; rarity: string; description: string }[];
}

export interface RoadmapEntry {
  level: number;
  title: string;
  description: string;
  feature: string | null;
  coins: number;
  unlocked: boolean;
  /** Coin reward state, from the user's reward grants (worker gamificationApi.ts). */
  rewardState?: 'none' | 'pending' | 'claimable' | 'claimed' | 'ineligible';
  items: CatalogItemView[];
}

export interface RewardGrant {
  id: string;
  sourceType: string;
  sourceId: string;
  coins: number;
  status: string;
  note: string | null;
  createdAt: number;
}

export interface ProgressionView {
  enabled: boolean;
  levelInfo: LevelInfo;
  leveledUp: { from: number; to: number } | null;
  newlyUnlocked: { id: string; name: string; icon: string; rarity: string; tier: number; xp: number }[];
  cosmetics: PublicCosmetics;
  roadmap: RoadmapEntry[];
  recentXp: { id: string; action: string; label: string; delta: number; createdAt: number }[];
  achievements: { unlocked: number; total: number };
  pinnedLimit: number;
  showcaseUnlocksAt: number;
  season: { id: string; name: string; endsAt: number; xp: number; rank: number | null } | null;
  rewards: { claimable: RewardGrant[]; budgetAvailable: boolean };
}

export interface AchievementView {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  rarity: string;
  xpReward: number;
  itemId: string | null;
  repeatable: boolean;
  tier: number;
  maxTier: number;
  unlocked: boolean;
  unlockedAt: number | null;
  progress: number | null;
  target: number | null;
  endsAt: number | null;
}

export interface InventoryItemView extends CatalogItemView {
  description: string;
  acquiredAt: number | null;
  unlocksAtLevel: number | null;
  equipped: boolean;
}

export interface QuestView {
  id: string;
  title: string;
  period: 'week' | 'month';
  metric: string;
  target: number;
  progress: number;
  xp: number;
  claimed: boolean;
  claimable: boolean;
  locked: boolean;
  minLevel: number;
  resetsAt: number;
}

export type XpPeriod = 'lifetime' | 'week' | 'month' | 'season';

export interface XpRankRow {
  rank: number;
  uid: string;
  username: string | null;
  fullName: string | null;
  profileImageUrl: string | null;
  profileImageUrlThumb?: string | null;
  verified: boolean;
  score: number;
  lifetimeXp: number;
  level: number;
  rankId?: string;
  rankTitle: string;
}

export const GAMIFICATION_KEYS = {
  progression: ['me', 'progression'] as const,
  achievements: ['me', 'achievements'] as const,
  inventory: ['me', 'inventory'] as const,
  quests: ['me', 'quests'] as const,
  history: ['me', 'xpHistory'] as const,
  insights: ['me', 'creatorInsights'] as const,
  catalog: ['gamification', 'catalog'] as const,
  leaderboard: (period: XpPeriod) => ['gamification', 'xpLeaderboard', period] as const,
  myRank: (period: XpPeriod) => ['me', 'xpRank', period] as const,
  hallOfFame: ['gamification', 'hallOfFame'] as const,
};

export function useProgression(enabled = true) {
  return useQuery({
    queryKey: GAMIFICATION_KEYS.progression,
    queryFn: () => callApi('getProgression') as Promise<ProgressionView>,
    enabled,
    staleTime: 30_000,
  });
}

export function useAchievements(enabled = true) {
  return useQuery({
    queryKey: GAMIFICATION_KEYS.achievements,
    queryFn: () => callApi('getAchievements') as Promise<{ achievements: AchievementView[]; pinned: string[]; pinnedLimit: number }>,
    enabled,
    staleTime: 30_000,
  });
}

export function useInventory(enabled = true) {
  return useQuery({
    queryKey: GAMIFICATION_KEYS.inventory,
    queryFn: () => callApi('getInventory') as Promise<{ level: number; equipped: Record<string, any>; items: InventoryItemView[] }>,
    enabled,
    staleTime: 30_000,
  });
}

export function useQuests(enabled = true) {
  return useQuery({
    queryKey: GAMIFICATION_KEYS.quests,
    queryFn: () => callApi('getQuests') as Promise<{ enabled: boolean; quests: QuestView[] }>,
    enabled,
    staleTime: 30_000,
  });
}

export function useXpHistory(enabled = true) {
  return useInfiniteQuery({
    queryKey: GAMIFICATION_KEYS.history,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      callApi('getXpHistory', pageParam ? { cursor: pageParam } : {}) as Promise<{
        events: { id: string; action: string; label: string; delta: number; reversed: boolean; createdAt: number }[];
        nextCursor: string | null;
      }>,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
}

export function useCreatorInsights(enabled = true) {
  return useQuery({
    queryKey: GAMIFICATION_KEYS.insights,
    queryFn: () => callApi('getCreatorInsights') as Promise<any>,
    enabled,
    staleTime: 60_000,
  });
}

export function useGamificationCatalog() {
  return useQuery({
    queryKey: GAMIFICATION_KEYS.catalog,
    queryFn: () => readApi('/read/gamification/catalog') as Promise<any>,
    staleTime: 5 * 60_000,
  });
}

export function useXpLeaderboard(period: XpPeriod) {
  return useInfiniteQuery({
    queryKey: GAMIFICATION_KEYS.leaderboard(period),
    initialPageParam: '0',
    queryFn: ({ pageParam }) =>
      readApi('/read/leaderboard/xp', { period, limit: 25, cursor: pageParam }) as Promise<{
        period: XpPeriod;
        active: boolean;
        label: string | null;
        endsAt: number | null;
        rows: XpRankRow[];
        nextCursor: string | null;
      }>,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
  });
}

export function useMyXpRank(period: XpPeriod, enabled: boolean) {
  return useQuery({
    queryKey: GAMIFICATION_KEYS.myRank(period),
    queryFn: () => readApiLive(`/read/leaderboard/xp/me?period=${period}`) as Promise<{ rank: number | null; score: number; active?: boolean }>,
    enabled,
    staleTime: 30_000,
  });
}

export function useHallOfFame() {
  return useQuery({
    queryKey: GAMIFICATION_KEYS.hallOfFame,
    queryFn: () => readApi('/read/hall-of-fame') as Promise<any>,
    staleTime: 5 * 60_000,
  });
}

/** Refetch everything that depends on the user's XP after an action that may have earned some. */
export function invalidateProgression(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: GAMIFICATION_KEYS.progression });
  qc.invalidateQueries({ queryKey: GAMIFICATION_KEYS.quests });
  qc.invalidateQueries({ queryKey: GAMIFICATION_KEYS.achievements });
  qc.invalidateQueries({ queryKey: GAMIFICATION_KEYS.history });
}

export function useEquipCosmetic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { slot: string; itemId: string | null }) => callApi('equipCosmetic', v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GAMIFICATION_KEYS.inventory });
      qc.invalidateQueries({ queryKey: GAMIFICATION_KEYS.progression });
      qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function usePinAchievements() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (achievementIds: string[]) => callApi('pinAchievements', { achievementIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GAMIFICATION_KEYS.achievements });
      qc.invalidateQueries({ queryKey: GAMIFICATION_KEYS.progression });
    },
  });
}

export function useClaimQuest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (questId: string) => callApi('claimQuest', { questId }) as Promise<{ xpEarned: number }>,
    onSuccess: () => invalidateProgression(qc),
  });
}

export function useClaimRewardGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) => callApi('claimRewardGrant', { grantId }) as Promise<{ coins: number }>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: GAMIFICATION_KEYS.progression });
      qc.invalidateQueries({ queryKey: ['wallet'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Level-up celebration bookkeeping (per account, per device).
// ---------------------------------------------------------------------------
const celebratedKey = (uid: string) => `tophunt.celebratedLevel.${uid}`;

export async function getCelebratedLevel(uid: string): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(celebratedKey(uid));
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function setCelebratedLevel(uid: string, level: number): Promise<void> {
  try {
    await AsyncStorage.setItem(celebratedKey(uid), String(level));
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Per-device "already animated" ids (XP events, level-ups, achievement unlocks).
// Bounded (see BoundedIdSet), per account. `null` = this device has never
// recorded any: the caller treats the current snapshot as a silent baseline.
// ---------------------------------------------------------------------------
export type SeenKind = 'xp' | 'levelup' | 'ach';
const seenKey = (kind: SeenKind, uid: string) => `tophunt.seen.${kind}.${uid}`;

export async function loadSeenIds(kind: SeenKind, uid: string): Promise<string[] | null> {
  try {
    const raw = await AsyncStorage.getItem(seenKey(kind, uid));
    if (raw == null) return null;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(-200) : [];
  } catch {
    return [];
  }
}

export async function saveSeenIds(kind: SeenKind, uid: string, ids: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(seenKey(kind, uid), JSON.stringify(ids.slice(-200)));
  } catch {
    /* best-effort */
  }
}
