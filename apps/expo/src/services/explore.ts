/**
 * Explore data (react-query). Every list is a separate, independently cached and
 * independently failing query, so one slow or broken section never blanks the
 * whole screen — each section shows its own retry.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { readApi, readApiWithCursor } from '@/src/services/api';
import { pushRecentSearch } from '@/src/lib/exploreMedia';

export type BattleType = 'photo' | 'video' | undefined;
export type BattleKind = 'trending' | 'ending' | 'open' | 'fresh';

export const EXPLORE_KEY = ['explore'] as const;

const KIND_PARAMS: Record<BattleKind, { status: string; sort?: string }> = {
  trending: { status: 'active', sort: 'hot' },
  ending: { status: 'active', sort: 'ending' },
  open: { status: 'waiting_for_opponent' },
  fresh: { status: 'active' },
};

export const BATTLE_KIND_TITLE: Record<BattleKind, string> = {
  trending: 'Trending battles',
  ending: 'Ending soon',
  open: 'Open battles — join now',
  fresh: 'Fresh battles',
};

/** One rail of battles (first page only). */
export function useExploreBattles(kind: BattleKind, type: BattleType, limit = 10, enabled = true) {
  return useQuery({
    queryKey: [...EXPLORE_KEY, 'battles', kind, type ?? 'all', limit],
    queryFn: async () => ((await readApi('/read/matches', { ...KIND_PARAMS[kind], type, limit })) as any[]) || [],
    enabled,
    staleTime: 30_000,
  });
}

/** Infinite list of battles (Explore grid and "See all"). */
export function useBattlePages(kind: BattleKind, type: BattleType, pageSize = 18, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...EXPLORE_KEY, 'pages', kind, type ?? 'all', pageSize],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const { data, nextCursor } = await readApiWithCursor<any[]>('/read/matches', {
        ...KIND_PARAMS[kind],
        type,
        limit: pageSize,
        cursor: pageParam ?? undefined,
      });
      return { items: Array.isArray(data) ? data : [], nextCursor };
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    staleTime: 30_000,
  });
}

export function useLiveContests(type: BattleType, enabled = true) {
  return useQuery({
    queryKey: [...EXPLORE_KEY, 'contests', type ?? 'all'],
    queryFn: async () => ((await readApi('/read/contests', { type })) as any[]) || [],
    enabled,
    staleTime: 60_000,
  });
}

export function useTopCreators(limit = 10, enabled = true) {
  return useQuery({
    queryKey: [...EXPLORE_KEY, 'creators', limit],
    queryFn: async () => ((await readApi('/read/leaderboard', { by: 'wins', limit })) as any[]) || [],
    enabled,
    staleTime: 60_000,
  });
}

export interface SuggestedPerson {
  id: string;
  name: string;
  username: string;
  avatar: string | null;
  verified: boolean;
  followersCount: number;
}

const toPerson = (d: any): SuggestedPerson => ({
  id: d.id,
  name: d.fullName || d.username || 'User',
  username: d.username || 'user',
  avatar: d.avatarThumbUrl || d.avatarUrl || d.profileImageUrl || null,
  verified: !!d.verified,
  followersCount: Number(d.followersCount) || 0,
});

/** "People you may know": excludes you and everyone you follow (server-side). */
export function useSuggestedPeople(limit = 30, viewerKey: string | null = null, enabled = true) {
  return useQuery({
    queryKey: [...EXPLORE_KEY, 'people', limit, viewerKey ?? 'guest'],
    queryFn: async () => (((await readApi('/read/users/suggested', { limit })) as any[]) || []).map(toPerson),
    enabled,
    staleTime: 60_000,
  });
}

export interface UniversalSearchResult {
  q: string;
  people: SuggestedPerson[];
  contests: any[];
  battles: any[];
  blog: any[];
}

export function useUniversalSearch(term: string) {
  const q = term.trim().replace(/^@+/, '');
  return useQuery({
    queryKey: [...EXPLORE_KEY, 'search', q.toLowerCase()],
    queryFn: async (): Promise<UniversalSearchResult> => {
      const r: any = (await readApi('/read/search', { q })) || {};
      return {
        q: r.q ?? q,
        people: (r.people || []).map(toPerson),
        contests: r.contests || [],
        battles: r.battles || [],
        blog: r.blog || [],
      };
    },
    enabled: q.length >= 2,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

export function useMyRank(by: 'wins' | 'votes' | 'xp', signedIn: boolean) {
  return useQuery({
    queryKey: ['leaderboard', 'me', by],
    queryFn: async () => (await readApi('/read/leaderboard/me', { by })) as { by: string; rank: number | null; score: number },
    enabled: signedIn,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Recent searches (this device only)
// ---------------------------------------------------------------------------
const RECENT_KEY = 'tophunt.explore.recentSearches';

export async function loadRecentSearches(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveRecentSearch(term: string): Promise<string[]> {
  const next = pushRecentSearch(await loadRecentSearches(), term);
  try {
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
  return next;
}

export async function clearRecentSearches(): Promise<void> {
  try {
    await AsyncStorage.removeItem(RECENT_KEY);
  } catch {
    /* best-effort */
  }
}
