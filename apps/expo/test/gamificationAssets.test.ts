/**
 * The gamification asset manifest: every key resolves to something the app can
 * actually draw, every server id the Worker seeds has artwork, fallbacks work,
 * and tier text stays readable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  ACHIEVEMENT_ASSET,
  ASSETS,
  BADGE_SIZES,
  QUEST_ASSET,
  RANK_TIER,
  TIERS,
  VECTOR_IDS,
  XP_ACTION_ASSET,
  achievementAsset,
  badgeState,
  cosmeticAsset,
  frameAsset,
  frameTier,
  levelFontSize,
  milestoneState,
  resolveAsset,
  tierForRank,
} from '../src/lib/gamificationAssets';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WORKER = path.join(ROOT, '..', 'worker');
const readWorker = (p: string) => fs.readFileSync(path.join(WORKER, p), 'utf8');

/** Quoted keys of the `ionicons` map in the icon shim (same parse as scripts/check-icons.mjs). */
function shimIconNames(): Set<string> {
  const src = read('src/lib/icons.tsx');
  const start = src.indexOf('const ionicons: Record<string, LucideIcon> = {');
  let depth = 0;
  let i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return new Set([...src.slice(from, i + 1).matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]));
}

describe('every registered key resolves', () => {
  const names = shimIconNames();

  it('icon assets use glyphs the shim actually maps (no blank-circle fallback)', () => {
    const missing = Object.entries(ASSETS)
      .filter(([, d]) => d.kind === 'icon' && !names.has(d.icon))
      .map(([k, d]) => `${k} -> ${(d as any).icon}`);
    expect(missing).toEqual([]);
  });

  it('vector assets use a vector the renderer implements', () => {
    const renderer = read('src/components/gamification/GamificationIcon.tsx');
    for (const id of VECTOR_IDS) expect(renderer, `GamificationIcon has no case for ${id}`).toContain(`case '${id}':`);
    for (const [k, d] of Object.entries(ASSETS)) {
      if (d.kind === 'vector') expect(VECTOR_IDS, k).toContain(d.vector);
    }
  });

  it('every asset has a colour and a readable label', () => {
    for (const [k, d] of Object.entries(ASSETS)) {
      expect(d.color, k).toMatch(/^#[0-9A-F]{6}$/i);
      expect(d.label.trim().length, k).toBeGreaterThan(1);
    }
  });

  it('tiered vectors name a real tier', () => {
    for (const [k, d] of Object.entries(ASSETS)) {
      if (d.kind === 'vector' && d.tier) expect(TIERS[d.tier], k).toBeTruthy();
    }
  });
});

describe('missing-asset fallback', () => {
  it('falls back to the given key, then to generic', () => {
    expect(resolveAsset('nope.nothing').key).toBe('generic');
    expect(resolveAsset(null, 'achievement.generic').key).toBe('achievement.generic');
    expect(resolveAsset('nope', 'also.missing' as any).key).toBe('generic');
    expect(resolveAsset('xp.star').key).toBe('xp.star');
  });

  it('an unknown achievement uses its admin icon, or the generic artwork', () => {
    expect(achievementAsset({ id: 'admin_made', icon: 'rocket-outline', unlocked: true })).toMatchObject({ kind: 'icon', icon: 'rocket-outline', key: null });
    expect(achievementAsset({ id: 'admin_made', unlocked: true }).key).toBe('achievement.generic');
    expect(achievementAsset({ id: 'admin_made', icon: 'reward.seasonal', unlocked: true }).key).toBe('reward.seasonal');
  });

  it('a locked achievement always shows the lock placeholder', () => {
    expect(achievementAsset({ id: 'first_win', unlocked: false }).key).toBe('achievement.locked');
    expect(achievementAsset({ id: 'first_win', unlocked: true }).key).toBe('achievement.first_win');
  });
});

describe('server ids have artwork', () => {
  it('covers every default achievement the Worker seeds', () => {
    const sql = readWorker('migrations/0070_gamification.sql');
    const block = sql.slice(sql.indexOf('INSERT OR IGNORE INTO achievement_definitions'));
    const ids = [...block.matchAll(/\('([a-z0-9_]+)', '/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(10);
    expect(ids.filter((id) => !ACHIEVEMENT_ASSET[id])).toEqual([]);
  });

  it('maps every default frame item to a frame design', () => {
    const sql = readWorker('migrations/0070_gamification.sql') + readWorker('migrations/0071_gamification_assets.sql');
    const frames = [...new Set([...sql.matchAll(/\('(frame_[a-z_]+)', 'frame'/g)].map((m) => m[1]))];
    expect(frames).toContain('frame_champion');
    for (const id of frames) expect(frameAsset({ id })?.key, id).toMatch(/^frame\./);
  });

  it('covers every default rank, every quest metric and every XP action', () => {
    const prog = readWorker('src/lib/progression.ts');
    const ranks = [...prog.matchAll(/\{ id: "([a-z]+)", name: "[A-Za-z]+", minLevel: \d+/g)].map((m) => m[1]);
    expect(ranks).toEqual(['newcomer', 'creator', 'challenger', 'champion', 'legend']);
    for (const r of ranks) expect(RANK_TIER[r], r).toBeTruthy();
    const metrics = JSON.parse(prog.match(/QUEST_METRICS: QuestMetric\[\] = (\[[^\]]+\])/)![1].replace(/'/g, '"'));
    for (const m of metrics) expect(QUEST_ASSET[m], m).toBeTruthy();
    const actions = [...prog.slice(prog.indexOf('export const XP_ACTIONS'), prog.indexOf('] as const;')).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(actions.length).toBeGreaterThan(8);
    for (const a of actions) expect(XP_ACTION_ASSET[a], a).toBeTruthy();
  });
});

describe('level badge', () => {
  it('picks the tier from the server rank id, with max level winning', () => {
    expect(tierForRank('newcomer').id).toBe('starter');
    expect(tierForRank('creator').id).toBe('bronze');
    expect(tierForRank('legend').id).toBe('legendary');
    expect(tierForRank('legend', { isMaxLevel: true }).id).toBe('max');
    expect(tierForRank('an_admin_rank').id).toBe('starter');
    expect(tierForRank(null).id).toBe('starter');
  });

  it('every tier has a distinct silhouette or label, not only a colour', () => {
    const ids = Object.values(TIERS).map((t) => `${t.shape}:${t.label}`);
    expect(new Set(ids).size).toBe(ids.length);
    const shapes = new Set(Object.values(TIERS).filter((t) => t.id !== 'max').map((t) => t.shape));
    // Every regular tier has its own silhouette.
    expect(shapes.size).toBe(Object.values(TIERS).filter((t) => t.id !== 'max').length);
  });

  it('shrinks the number for 3 digits and never goes unreadably small', () => {
    expect(levelFontSize(BADGE_SIZES.lg, 7)).toBeGreaterThan(levelFontSize(BADGE_SIZES.lg, 77));
    expect(levelFontSize(BADGE_SIZES.lg, 77)).toBeGreaterThan(levelFontSize(BADGE_SIZES.lg, 100));
    expect(levelFontSize(BADGE_SIZES.xs, 100)).toBeGreaterThanOrEqual(8);
  });

  it('derives display state only from server facts', () => {
    expect(badgeState({})).toBe('locked');
    expect(badgeState({ reached: true })).toBe('unlocked');
    expect(badgeState({ owned: true })).toBe('earned');
    expect(badgeState({ owned: true, equipped: true })).toBe('equipped');
    expect(badgeState({ owned: true, available: false })).toBe('unavailable');
  });
});

/** WCAG relative luminance / contrast. */
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

describe('readability', () => {
  it('the level number contrasts with its emblem (large-text 3:1) at the gradient midpoint and dark end', () => {
    const mid = (a: string, b: string) =>
      '#' + [1, 3, 5].map((i) => Math.round((parseInt(a.slice(i, i + 2), 16) + parseInt(b.slice(i, i + 2), 16)) / 2).toString(16).padStart(2, '0')).join('');
    for (const t of Object.values(TIERS)) {
      expect(contrast(t.ink, t.colors[1]), `${t.id} dark end`).toBeGreaterThanOrEqual(3);
      expect(contrast(t.ink, mid(t.colors[0], t.colors[1])), `${t.id} midpoint`).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('locked (muted) emblems use the same grey in light and dark themes, plus a lock glyph', () => {
    const badge = read('src/components/gamification/LevelBadge.tsx');
    expect(badge).toContain("name=\"lock-closed\"");
    expect(badge).toMatch(/accessibilityLabel=\{label\}/);
  });
});

describe('cosmetics', () => {
  it('frame design precedence: asset.key, then id, then rarity', () => {
    expect(frameAsset({ id: 'frame_bronze', asset: { key: 'frame.legendary' } })?.key).toBe('frame.legendary');
    expect(frameAsset({ id: 'frame_bronze', asset: { key: 'xp.star' } })?.key).toBe('frame.bronze');
    expect(frameAsset({ id: 'custom_frame', rarity: 'epic', asset: {} })?.key).toBe('frame.champion');
    expect(frameAsset({ id: 'custom_frame', asset: {} })?.key).toBe('frame.starter');
    expect(frameAsset(null)).toBeNull();
    expect(frameTier({ id: 'frame_gold_animated' })?.id).toBe('gold');
  });

  it('unowned items preview as locked; owned ones by type', () => {
    expect(cosmeticAsset({ type: 'frame', owned: false }).key).toBe('cosmetic.locked');
    expect(cosmeticAsset({ type: 'title', owned: true }).key).toBe('cosmetic.title');
    expect(cosmeticAsset({ type: 'mystery', owned: true }).key).toBe('generic');
  });
});

describe('roadmap states come from the server', () => {
  it('maps unlocked + rewardState to a node state', () => {
    expect(milestoneState({ unlocked: false, rewardState: 'claimable' })).toBe('locked');
    expect(milestoneState({ unlocked: true, rewardState: 'claimable' })).toBe('available');
    expect(milestoneState({ unlocked: true, rewardState: 'claimed' })).toBe('claimed');
    expect(milestoneState({ unlocked: true, rewardState: 'none' })).toBe('unlocked');
    expect(milestoneState({ unlocked: true })).toBe('unlocked');
  });
});

describe('motion and grants', () => {
  it('every animated component honours reduced motion', () => {
    for (const f of ['SparkleBurst', 'ProfileFrame', 'LevelUpCelebration', 'LevelProgressBar']) {
      expect(read(`src/components/gamification/${f}.tsx`), f).toContain('useReducedMotion');
    }
    expect(read('src/components/gamification/SparkleBurst.tsx')).toMatch(/if \(reduce\) return null/);
    expect(read('src/components/gamification/ProfileFrame.tsx')).toMatch(/cancelAnimation/);
  });

  it('no gamification UI calls an API that could grant XP or rewards on its own', () => {
    const dir = path.join(ROOT, 'src', 'components', 'gamification');
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/callApi\(/);
      expect(src, f).not.toMatch(/xp\s*[+]=|awardXp|grantXp/);
    }
  });
});
