/**
 * Pure helpers for the Explore screens (kept out of the components so they can be
 * unit-tested in Node).
 */
import { bunnyThumbnailFromUrl } from '@/src/lib/videoSource';

export type ExploreTab = 'all' | 'photo' | 'video' | 'people';

/**
 * The image to show for one battle participant in a grid / rail tile.
 *
 * Photos: the server's resized variants first (a 320px thumb is ~20× smaller than
 * the original), never the raw upload when a variant exists. Videos: Bunny's
 * poster frame; anything else is a video FILE that an <Image> cannot draw, so
 * null — the tile then shows its gradient + play glyph instead of a blank box.
 */
export function participantThumb(p: any, matchType?: string | null): string | null {
  if (!p) return null;
  const isVideo = p.mediaType === 'video' || matchType === 'video';
  if (isVideo) return bunnyThumbnailFromUrl(p.mediaUrl) || null;
  return p.mediaUrlThumb || p.mediaUrlOptimized || p.mediaUrl || null;
}

/** Avatar for a participant, smallest variant first. */
export function participantAvatar(p: any): string | null {
  return p?.profilePicThumb || p?.profilePic || p?.avatar || null;
}

/**
 * Open battles a viewer can actually join from Explore: no invite-only battle
 * meant for someone else, and no battle held for moderation.
 */
export function joinableOpenBattles<T extends { isPrivate?: any; invitedUid?: string | null; moderationHeld?: boolean }>(
  list: T[] | null | undefined,
  viewerUid?: string | null,
): T[] {
  return (list || []).filter((m) => !m.moderationHeld && (!m.isPrivate || (!!viewerUid && m.invitedUid === viewerUid)));
}

/** Compact counts: 950, 1.2K, 3.4M. */
export function compactCount(n: unknown): string {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Ordered, enabled section keys from the public Explore config (all on by default). */
export const EXPLORE_SECTION_KEYS = [
  'banners',
  'quickActions',
  'trending',
  'endingSoon',
  'contests',
  'openBattles',
  'topCreators',
  'people',
  'grid',
] as const;
export type ExploreSectionKey = (typeof EXPLORE_SECTION_KEYS)[number];

export function enabledSections(cfg: { sections?: { key: string; enabled?: boolean }[] } | null | undefined): ExploreSectionKey[] {
  const seen = new Set<string>();
  const out: ExploreSectionKey[] = [];
  for (const s of cfg?.sections || []) {
    if (!(EXPLORE_SECTION_KEYS as readonly string[]).includes(s?.key) || seen.has(s.key)) continue;
    seen.add(s.key);
    if (s.enabled !== false) out.push(s.key as ExploreSectionKey);
  }
  for (const k of EXPLORE_SECTION_KEYS) if (!seen.has(k)) out.push(k);
  return out;
}

/** Banner link → where to go. In-app paths route; https opens externally; anything else is ignored. */
export function bannerTarget(link: unknown): { kind: 'route' | 'url'; to: string } | null {
  const l = typeof link === 'string' ? link.trim() : '';
  if (!l) return null;
  if (l.startsWith('/') && !l.startsWith('//')) return { kind: 'route', to: l };
  if (/^https:\/\//i.test(l)) return { kind: 'url', to: l };
  return null;
}

/** Split a flat list into rows of `cols` for a virtualised grid. */
export function chunk<T>(list: T[], cols: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < list.length; i += cols) rows.push(list.slice(i, i + cols));
  return rows;
}

// ---------------------------------------------------------------------------
// Recent searches (pure part; storage lives in services/explore.ts)
// ---------------------------------------------------------------------------
export const RECENT_SEARCH_MAX = 10;

export function pushRecentSearch(list: string[], term: string): string[] {
  const t = term.trim().replace(/\s+/g, ' ');
  if (t.length < 2) return list;
  return [t, ...list.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, RECENT_SEARCH_MAX);
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------
export type LeaderboardBy = 'wins' | 'votes' | 'xp';

/**
 * A leaderboard row's score. /read/leaderboard returns FLAT `wins` /
 * `totalVotesReceived` / `xp`; the screen used to read `stats.wins`, so Winners and
 * Voted showed 0 for everyone. Flat first, `stats.*` as a fallback.
 */
export function leaderboardScore(u: any, by: LeaderboardBy): number {
  if (!u) return 0;
  const v = by === 'wins' ? u.wins ?? u.stats?.wins : by === 'votes' ? u.totalVotesReceived ?? u.stats?.totalVotesReceived : u.xp;
  return Math.max(0, Number(v) || 0);
}

/** Podium (top 3) and the rest. With fewer than 3 people everyone is listed — nothing is dropped. */
export function splitPodium<T>(list: T[]): { podium: T[]; rest: T[]; restStartRank: number } {
  if (list.length < 3) return { podium: [], rest: list, restStartRank: 1 };
  return { podium: list.slice(0, 3), rest: list.slice(3), restStartRank: 4 };
}
