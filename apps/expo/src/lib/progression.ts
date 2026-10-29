/**
 * Display helpers for the server's progression data.
 *
 * The level, the progress bar and the rank are computed ONLY on the Worker
 * (apps/worker/src/lib/progression.ts#levelInfo) and returned as `levelInfo`.
 * Nothing here recomputes them from XP: the app used to run its own copy of the
 * formula with the thresholds hardcoded, which disagreed with the server the
 * moment an admin changed the curve. These helpers only format what they are given.
 */

export interface LevelInfo {
  xp: number;
  level: number;
  maxLevel: number;
  isMaxLevel: boolean;
  levelStartXp: number;
  nextLevelXp: number | null;
  xpIntoLevel: number;
  xpForNextLevel: number | null;
  xpToNextLevel: number | null;
  progress: number;
  rank: { id: string; name: string; icon: string; color: string };
  nextRank: { name: string; minLevel: number } | null;
  nextMilestone: { level: number; title: string; description: string; items: string[]; feature: string | null } | null;
}

/** True when `v` looks like a server levelInfo (older Workers do not send one). */
export function isLevelInfo(v: unknown): v is LevelInfo {
  const o = v as any;
  return !!o && typeof o === 'object' && Number.isFinite(o.level) && Number.isFinite(o.xp) && typeof o.progress === 'number' && !!o.rank;
}

/** Progress as a 0-100 percentage for a bar width. Max level is a full bar. */
export function progressPercent(info: Pick<LevelInfo, 'progress' | 'isMaxLevel'> | null | undefined): number {
  if (!info) return 0;
  if (info.isMaxLevel) return 100;
  const p = Number(info.progress);
  if (!Number.isFinite(p)) return 0;
  return Math.round(Math.max(0, Math.min(1, p)) * 1000) / 10;
}

/** "1,250" — grouping without depending on the device locale. */
export function formatXp(n: number | null | undefined): string {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "500 / 1,000 XP", or the max-level wording. */
export function progressLabel(info: LevelInfo): string {
  if (info.isMaxLevel) return `Max level · ${formatXp(info.xp)} XP`;
  return `${formatXp(info.xpIntoLevel)} / ${formatXp(info.xpForNextLevel)} XP`;
}

/** Screen-reader sentence for the progress bar. */
export function progressA11y(info: LevelInfo): string {
  if (info.isMaxLevel) return `Level ${info.level}, the maximum level. ${formatXp(info.xp)} lifetime XP. Rank ${info.rank.name}.`;
  return `Level ${info.level}, rank ${info.rank.name}. ${formatXp(info.xpToNextLevel)} XP to level ${info.level + 1}.`;
}

/**
 * Whether to celebrate a level-up on this device: only for a level ABOVE the
 * last one this device celebrated, and never on the first load (no stored level
 * yet), so opening the app on a new phone does not replay old level-ups.
 */
export function shouldCelebrate(lastCelebrated: number | null, level: number): boolean {
  return lastCelebrated !== null && Number.isFinite(lastCelebrated) && level > lastCelebrated;
}

export const RARITY_COLORS: Record<string, string> = {
  common: '#9AA3AD',
  uncommon: '#43A047',
  rare: '#1E88E5',
  epic: '#8E24AA',
  legendary: '#FB8C00',
};

export const rarityColor = (r?: string | null) => RARITY_COLORS[r ?? ''] ?? RARITY_COLORS.common;

export const rarityLabel = (r?: string | null) => {
  const s = String(r || 'common');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Two safe gradient stops from a catalog asset, with a neutral fallback. */
export function assetColors(asset: unknown, fallback: [string, string] = ['#FF4D67', '#8B5CF6']): [string, string] {
  const c = (asset as any)?.colors;
  const ok = Array.isArray(c) ? c.filter((x: unknown) => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x as string)) : [];
  if (ok.length >= 2) return [ok[0], ok[1]];
  if (ok.length === 1) return [ok[0], ok[0]];
  return fallback;
}

export const FEATURE_LABELS: Record<string, string> = {
  level_badge: 'Level badge',
  achievement_showcase: 'Achievement showcase',
  stats_summary: 'Personal stats',
  customization: 'Profile customization',
  weekly_challenges: 'Weekly challenges',
  advanced_insights: 'Advanced insights',
  hall_of_fame: 'Hall of Fame',
  lifetime_showcase: 'Lifetime showcase',
};

/** Short countdown like "3d 4h" or "45m" until `ts`. */
export function timeLeft(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '';
  const ms = Math.max(0, Number(ts) - now);
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
