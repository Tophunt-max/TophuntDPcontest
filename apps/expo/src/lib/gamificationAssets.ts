/**
 * Central asset manifest for XP, levels, ranks, achievements, cosmetics,
 * rewards and quests.
 *
 * Every visual is addressed by a STABLE KEY (`xp.star`, `rank.champion`,
 * `achievement.first_win`, `frame.gold`, …). A key resolves to one of:
 *
 *   - `icon`   a glyph from the existing icon shim (src/lib/icons.tsx, Lucide
 *              SVGs — renders identically on Android, iOS and web);
 *   - `vector` a TopHunt-drawn SVG from src/components/gamification/vectors.tsx
 *              (emblems, frames, trophy, empty state). Scalable, transparent,
 *              themeable, and editable as code — no raster files to keep sharp.
 *
 * Reward and achievement LOGIC never stores visuals: the server sends ids
 * (achievement id, rank id, catalog item id + `asset`), and this file maps
 * them to keys. Unknown ids fall back to a generic asset, never a broken path.
 *
 * Pure TypeScript (no React), so the whole mapping is unit-tested.
 */

export type VectorId =
  | 'xpStar'
  | 'emblem'
  | 'frameRing'
  | 'lockBadge'
  | 'trophy'
  | 'emptyInventory'
  | 'rewardGift';

/** Every vector the renderer must implement (test/gamificationAssets.test.ts checks this). */
export const VECTOR_IDS: VectorId[] = ['xpStar', 'emblem', 'frameRing', 'lockBadge', 'trophy', 'emptyInventory', 'rewardGift'];

export type AssetDef =
  | { kind: 'icon'; icon: string; color: string; label: string }
  | { kind: 'vector'; vector: VectorId; color: string; label: string; tier?: TierId };

// ---------------------------------------------------------------------------
// Tiers. Colour is never the only signal: each tier also has its own emblem
// SILHOUETTE (vectors.tsx) and a text label, so it reads in grayscale and to
// screen readers.
// ---------------------------------------------------------------------------
export type TierId = 'starter' | 'bronze' | 'silver' | 'gold' | 'champion' | 'legendary' | 'max';

export interface TierStyle {
  id: TierId;
  label: string;
  /** Two gradient stops, light-to-dark. */
  colors: [string, string];
  /** Text / glyph colour that passes contrast on `colors`. */
  ink: string;
  /** Emblem silhouette drawn by vectors.tsx. */
  shape: 'circle' | 'hexagon' | 'shield' | 'crest' | 'star' | 'crown';
}

export const TIERS: Record<TierId, TierStyle> = {
  starter: { id: 'starter', label: 'Starter', colors: ['#34D399', '#047857'], ink: '#FFFFFF', shape: 'circle' },
  bronze: { id: 'bronze', label: 'Bronze', colors: ['#F2B680', '#9A5B2A'], ink: '#FFFFFF', shape: 'hexagon' },
  silver: { id: 'silver', label: 'Silver', colors: ['#E8ECF1', '#7D8794'], ink: '#1F2933', shape: 'shield' },
  gold: { id: 'gold', label: 'Gold', colors: ['#FFE082', '#E08E00'], ink: '#3B2600', shape: 'crest' },
  champion: { id: 'champion', label: 'Champion', colors: ['#B39DFF', '#5B21B6'], ink: '#FFFFFF', shape: 'star' },
  legendary: { id: 'legendary', label: 'Legendary', colors: ['#FF8A80', '#C2185B'], ink: '#FFFFFF', shape: 'crown' },
  max: { id: 'max', label: 'Max level', colors: ['#FFF59D', '#FF6F00'], ink: '#3B2600', shape: 'crown' },
};

/** Server rank id → tier. Ranks are by LEVEL (worker lib/progression.ts DEFAULT_RANKS). */
export const RANK_TIER: Record<string, TierId> = {
  newcomer: 'starter',
  creator: 'bronze',
  challenger: 'silver',
  champion: 'champion',
  legend: 'legendary',
};

/** Tier for a rank id; an unknown (admin-added) rank gets a neutral tier by position. */
export function tierForRank(rankId: string | null | undefined, opts: { isMaxLevel?: boolean } = {}): TierStyle {
  if (opts.isMaxLevel) return TIERS.max;
  const t = rankId ? RANK_TIER[rankId] : undefined;
  return TIERS[t ?? 'starter'];
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
const icon = (i: string, color: string, label: string): AssetDef => ({ kind: 'icon', icon: i, color, label });
const vec = (v: VectorId, color: string, label: string, tier?: TierId): AssetDef => ({ kind: 'vector', vector: v, color, label, tier });

const XP = '#FFB300';
const BRAND = '#FF4D67';

export const ASSETS = {
  // A. XP
  'xp.star': vec('xpStar', XP, 'XP'),
  'xp.gained': icon('trending-up', '#22C55E', 'XP gained'),
  'xp.history': icon('time-outline', BRAND, 'XP history'),
  'xp.progress': icon('stats-chart', BRAND, 'XP progress'),
  'xp.lifetime': icon('infinite', XP, 'Lifetime XP'),
  'xp.weekly': icon('calendar', '#29B6F6', 'Weekly XP'),
  'xp.seasonal': icon('medal', '#AB47BC', 'Seasonal XP'),

  // B. Ranks (emblems; the level number is drawn on top by LevelBadge)
  'rank.newcomer': vec('emblem', TIERS.starter.colors[1], 'Newcomer', 'starter'),
  'rank.creator': vec('emblem', TIERS.bronze.colors[1], 'Creator', 'bronze'),
  'rank.challenger': vec('emblem', TIERS.silver.colors[1], 'Challenger', 'silver'),
  'rank.champion': vec('emblem', TIERS.champion.colors[1], 'Champion', 'champion'),
  'rank.legend': vec('emblem', TIERS.legendary.colors[1], 'Legend', 'legendary'),
  'rank.max': vec('emblem', TIERS.max.colors[1], 'Maximum level', 'max'),

  // C. Achievements
  'achievement.first_contest': icon('flag', '#29B6F6', 'First Contest'),
  'achievement.first_vote': icon('checkmark-circle', '#22C55E', 'First Valid Vote'),
  'achievement.first_win': vec('trophy', '#FFB300', 'First Win'),
  'achievement.photo_creator': icon('image', BRAND, 'Photo Creator'),
  'achievement.video_creator': icon('videocam', '#7C4DFF', 'Video Creator'),
  'achievement.battles': icon('flash', '#FF7043', 'Valid Battles'),
  'achievement.votes': icon('people', '#26A69A', 'Eligible Votes'),
  'achievement.consistent': icon('calendar', '#5C6BC0', 'Consistent Participant'),
  'achievement.streak_7': icon('flame', '#FF7043', '7-Day Streak'),
  'achievement.streak_30': icon('flame', '#E53935', '30-Day Streak'),
  'achievement.streak_100': icon('flame', '#B71C1C', '100-Day Streak'),
  'achievement.verified_champion': icon('shield-checkmark', '#1E88E5', 'Verified Champion'),
  'achievement.season_top': icon('medal', '#AB47BC', 'Seasonal Top Performer'),
  'achievement.profile_complete': icon('person-circle', '#26A69A', 'Profile complete'),
  'achievement.community': icon('heart', '#EC407A', 'Community Contributor'),
  'achievement.locked': vec('lockBadge', '#9AA3AD', 'Locked achievement'),
  'achievement.generic': icon('ribbon', '#FFB300', 'Achievement'),

  // D. Cosmetics
  'frame.starter': vec('frameRing', TIERS.starter.colors[1], 'Starter frame', 'starter'),
  'frame.bronze': vec('frameRing', TIERS.bronze.colors[1], 'Bronze frame', 'bronze'),
  'frame.silver': vec('frameRing', TIERS.silver.colors[1], 'Silver frame', 'silver'),
  'frame.gold': vec('frameRing', TIERS.gold.colors[1], 'Gold frame', 'gold'),
  'frame.champion': vec('frameRing', TIERS.champion.colors[1], 'Champion frame', 'champion'),
  'frame.legendary': vec('frameRing', TIERS.legendary.colors[1], 'Legendary frame', 'legendary'),
  'cosmetic.title': icon('ribbon', '#FFB300', 'Title'),
  'cosmetic.theme': icon('color-palette', '#7C4DFF', 'Profile theme'),
  'cosmetic.accessory': icon('sparkles', '#29B6F6', 'Avatar accessory'),
  'cosmetic.sticker': icon('sticker-outline', '#FF7043', 'Sticker'),
  'cosmetic.effect': icon('sparkles', '#FF5252', 'Celebration effect'),
  'cosmetic.collectible': icon('diamond', '#AB47BC', 'Collectible'),
  'cosmetic.badge': icon('star', '#FFB300', 'Badge'),
  'cosmetic.locked': vec('lockBadge', '#9AA3AD', 'Locked'),

  // E. Level-up and rewards
  'reward.levelup': icon('star', '#FFD54F', 'Level up'),
  'reward.milestone': icon('flag', '#7C4DFF', 'Milestone reward'),
  'reward.unlocked': icon('lock-open', '#22C55E', 'Reward unlocked'),
  'reward.claimed': icon('checkmark-circle', '#22C55E', 'Reward claimed'),
  'reward.claimable': vec('rewardGift', BRAND, 'Reward to claim'),
  'reward.locked': vec('lockBadge', '#9AA3AD', 'Locked reward'),
  'reward.seasonal': icon('medal', '#AB47BC', 'Seasonal reward'),
  'reward.diamond': icon('diamond', '#22D3EE', 'Diamond reward'),
  'reward.hall_of_fame': vec('trophy', '#FFB300', 'Hall of Fame'),
  'reward.empty': vec('emptyInventory', '#9AA3AD', 'Nothing here yet'),

  // F. Activities and quests
  'activity.checkin': icon('calendar', '#26A69A', 'Daily check-in'),
  'activity.streak': icon('flame', '#FF7043', 'Streak'),
  'activity.vote': icon('checkmark-circle', '#22C55E', 'Voting'),
  'activity.photo': icon('image', BRAND, 'Photo contests'),
  'activity.video': icon('videocam', '#7C4DFF', 'Video contests'),
  'activity.win': icon('trophy', '#FFB300', 'Contest win'),
  'activity.daily_quest': icon('flag', '#29B6F6', 'Daily quest'),
  'activity.weekly_challenge': icon('flash', '#FF7043', 'Weekly challenge'),
  'activity.insights': icon('stats-chart', '#5C6BC0', 'Creator insights'),
  'activity.leaderboard': icon('podium', BRAND, 'Leaderboard'),
  'activity.season': icon('medal', '#AB47BC', 'Seasonal event'),
  'activity.achievement': icon('ribbon', '#FFB300', 'Achievement'),
  'activity.inventory': icon('color-palette', '#7C4DFF', 'Reward inventory'),
  'activity.xp': vec('xpStar', XP, 'XP'),

  // Fallback for anything unmapped.
  'generic': icon('star', '#9AA3AD', 'Reward'),
} satisfies Record<string, AssetDef>;

export type AssetKey = keyof typeof ASSETS;

export const isAssetKey = (k: unknown): k is AssetKey => typeof k === 'string' && Object.prototype.hasOwnProperty.call(ASSETS, k);

/** Resolve a key, falling back to `fallback` (and then `generic`) — never undefined. */
export function resolveAsset(key: string | null | undefined, fallback: AssetKey = 'generic'): AssetDef & { key: AssetKey } {
  const k: AssetKey = isAssetKey(key) ? key : isAssetKey(fallback) ? fallback : 'generic';
  return { ...ASSETS[k], key: k };
}

// ---------------------------------------------------------------------------
// Server id → key
// ---------------------------------------------------------------------------

/** Default achievement ids (worker migrations/0070) → asset keys. */
export const ACHIEVEMENT_ASSET: Record<string, AssetKey> = {
  first_contest: 'achievement.first_contest',
  first_vote: 'achievement.first_vote',
  first_win: 'achievement.first_win',
  photo_creator: 'achievement.photo_creator',
  video_creator: 'achievement.video_creator',
  battles_10: 'achievement.battles',
  votes_100: 'achievement.votes',
  consistent_participant: 'achievement.consistent',
  streak_7: 'achievement.streak_7',
  streak_30: 'achievement.streak_30',
  streak_100: 'achievement.streak_100',
  verified_champion: 'achievement.verified_champion',
  season_top: 'achievement.season_top',
  profile_complete: 'achievement.profile_complete',
  community_contributor: 'achievement.community',
};

/**
 * Achievement visual: locked placeholder until unlocked; then the id's key,
 * else an admin-chosen Ionicons name from the definition (`icon`), else the
 * generic achievement. Returned as either a key or a raw icon name.
 */
export function achievementAsset(a: { id: string; icon?: string | null; unlocked?: boolean }): AssetDef & { key: AssetKey | null } {
  if (a.unlocked === false) return { ...ASSETS['achievement.locked'], key: 'achievement.locked' };
  const k = ACHIEVEMENT_ASSET[a.id];
  if (k) return { ...ASSETS[k], key: k };
  if (a.icon && typeof a.icon === 'string') {
    if (isAssetKey(a.icon)) return { ...ASSETS[a.icon], key: a.icon };
    return { kind: 'icon', icon: a.icon, color: ASSETS['achievement.generic'].color, label: 'Achievement', key: null };
  }
  return { ...ASSETS['achievement.generic'], key: 'achievement.generic' };
}

/** Catalog frame item → frame key. Prefers `asset.key` (admin-set), then known ids, then rarity. */
export const FRAME_ITEM_ASSET: Record<string, AssetKey> = {
  frame_bronze: 'frame.bronze',
  frame_silver: 'frame.silver',
  frame_gold_animated: 'frame.gold',
  frame_champion: 'frame.champion',
  frame_diamond_animated: 'frame.champion',
  frame_legendary: 'frame.legendary',
};
const RARITY_FRAME: Record<string, AssetKey> = {
  common: 'frame.bronze',
  uncommon: 'frame.silver',
  rare: 'frame.gold',
  epic: 'frame.champion',
  legendary: 'frame.legendary',
};

export function frameAsset(item: { id?: string | null; rarity?: string | null; asset?: any } | null | undefined): (AssetDef & { key: AssetKey }) | null {
  if (!item) return null;
  const fromAsset = item.asset?.key;
  if (isAssetKey(fromAsset) && String(fromAsset).startsWith('frame.')) return resolveAsset(fromAsset);
  const byId = item.id ? FRAME_ITEM_ASSET[item.id] : undefined;
  if (byId) return resolveAsset(byId);
  return resolveAsset(RARITY_FRAME[item.rarity ?? ''] ?? 'frame.starter');
}

/** Tier style for a frame item (for the ring's gradient and ornament). */
export function frameTier(item: Parameters<typeof frameAsset>[0]): TierStyle | null {
  const a = frameAsset(item);
  return a && a.kind === 'vector' && a.tier ? TIERS[a.tier] : null;
}

/** Catalog item type → key used for its preview. */
export function cosmeticAsset(item: { id?: string; type: string; rarity?: string | null; asset?: any; owned?: boolean }): AssetDef & { key: AssetKey } {
  if (item.owned === false) return resolveAsset('cosmetic.locked');
  if (item.type === 'frame') return frameAsset(item) ?? resolveAsset('frame.starter');
  return resolveAsset(`cosmetic.${item.type}`, 'generic');
}

/** Quest metric → key. */
export const QUEST_ASSET: Record<string, AssetKey> = {
  votes: 'activity.vote',
  entries: 'activity.photo',
  wins: 'activity.win',
  checkins: 'activity.checkin',
  active_days: 'activity.streak',
  xp: 'activity.xp',
};

/** XP event action → key, for history rows. */
export const XP_ACTION_ASSET: Record<string, AssetKey> = {
  vote: 'activity.vote',
  contest_entry: 'activity.photo',
  match_win: 'activity.win',
  match_loss: 'activity.photo',
  daily_checkin: 'activity.checkin',
  hall_of_fame: 'reward.hall_of_fame',
  daily_task: 'activity.daily_quest',
  quest: 'activity.weekly_challenge',
  achievement: 'activity.achievement',
  admin_adjustment: 'xp.history',
  reversal: 'xp.history',
  opening_balance: 'xp.lifetime',
};

/** Badge display state, derived only from server facts. */
export type BadgeState = 'locked' | 'unlocked' | 'earned' | 'equipped' | 'unavailable';

export function badgeState(input: { owned?: boolean; equipped?: boolean; reached?: boolean; available?: boolean }): BadgeState {
  if (input.available === false) return 'unavailable';
  if (input.equipped) return 'equipped';
  if (input.owned) return 'earned';
  if (input.reached) return 'unlocked';
  return 'locked';
}

/** Milestone reward state for the roadmap, from the server's roadmap entry. */
export type MilestoneState = 'locked' | 'available' | 'unlocked' | 'claimed';

export function milestoneState(m: { unlocked: boolean; rewardState?: string | null }): MilestoneState {
  if (!m.unlocked) return 'locked';
  if (m.rewardState === 'claimable') return 'available';
  if (m.rewardState === 'claimed') return 'claimed';
  return 'unlocked';
}

/** Size steps for badges so they stay crisp and proportional on phone, tablet and web. */
export const BADGE_SIZES = { xs: 20, sm: 28, md: 40, lg: 64, xl: 96 } as const;
export type BadgeSize = keyof typeof BADGE_SIZES;

/** Font size for the level number inside an emblem of `px`, shrinking for 3 digits. */
export function levelFontSize(px: number, level: number): number {
  const digits = String(Math.max(1, Math.floor(level))).length;
  const ratio = digits >= 3 ? 0.3 : digits === 2 ? 0.38 : 0.44;
  return Math.max(8, Math.round(px * ratio));
}
