/**
 * Level display helpers and the progression contract with the Worker.
 *
 * The app must render the server's `levelInfo` and never recompute a level:
 * its old copy of the formula had 500/500 hardcoded and disagreed with the
 * server once an admin changed the curve.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  assetColors,
  formatXp,
  isLevelInfo,
  progressA11y,
  progressLabel,
  progressPercent,
  shouldCelebrate,
  timeLeft,
  type LevelInfo,
} from '../src/lib/progression';
import { classifyRoute } from '../src/lib/routeAccess';

const base: LevelInfo = {
  xp: 1000,
  level: 2,
  maxLevel: 100,
  isMaxLevel: false,
  levelStartXp: 500,
  nextLevelXp: 1500,
  xpIntoLevel: 500,
  xpForNextLevel: 1000,
  xpToNextLevel: 500,
  progress: 0.5,
  rank: { id: 'newcomer', name: 'Newcomer', icon: 'leaf', color: '#8BC34A' },
  nextRank: { name: 'Creator', minLevel: 6 },
  nextMilestone: { level: 5, title: 'Starter frame', description: '', items: ['frame_bronze'], feature: null },
};

describe('progress display', () => {
  it('renders the server progress, not a recomputed one', () => {
    expect(progressPercent(base)).toBe(50);
    expect(progressLabel(base)).toBe('500 / 1,000 XP');
    expect(progressA11y(base)).toContain('500 XP to level 3');
  });

  it('shows a full bar and explicit wording at max level', () => {
    const max = { ...base, level: 100, isMaxLevel: true, nextLevelXp: null, xpForNextLevel: null, xpToNextLevel: null, progress: 1, xp: 2_500_000 };
    expect(progressPercent(max)).toBe(100);
    expect(progressLabel(max)).toBe('Max level · 2,500,000 XP');
    expect(progressA11y(max)).toContain('maximum level');
  });

  it('never draws a bar from missing or garbage data', () => {
    expect(progressPercent(null)).toBe(0);
    expect(progressPercent({ progress: Number.NaN, isMaxLevel: false })).toBe(0);
    expect(progressPercent({ progress: 7, isMaxLevel: false })).toBe(100);
    expect(isLevelInfo(undefined)).toBe(false);
    expect(isLevelInfo({ level: 3 })).toBe(false);
    expect(isLevelInfo(base)).toBe(true);
  });

  it('formats numbers without depending on the device locale', () => {
    expect(formatXp(1234567)).toBe('1,234,567');
    expect(formatXp(-5)).toBe('0');
  });

  it('accepts only real hex colors from a catalog asset', () => {
    expect(assetColors({ colors: ['#112233', '#445566'] })).toEqual(['#112233', '#445566']);
    expect(assetColors({ colors: ['red', 'url(x)'] })).toEqual(['#FF4D67', '#8B5CF6']);
    expect(assetColors({ colors: ['#ABCDEF'] })).toEqual(['#ABCDEF', '#ABCDEF']);
  });

  it('formats a countdown', () => {
    expect(timeLeft(1000 + 2 * 86_400_000 + 3 * 3_600_000, 1000)).toBe('2d 3h');
    expect(timeLeft(1000 + 45 * 60_000, 1000)).toBe('45m');
  });
});

describe('level-up celebration', () => {
  it('celebrates only a level above the last one celebrated on this device', () => {
    expect(shouldCelebrate(4, 5)).toBe(true);
    expect(shouldCelebrate(5, 5)).toBe(false);
    expect(shouldCelebrate(6, 5)).toBe(false);
  });
  it('never replays history on the first load of a device', () => {
    expect(shouldCelebrate(null, 40)).toBe(false);
  });
});

describe('routes', () => {
  it('keeps personal progression private and the leaderboards public', () => {
    expect(classifyRoute(['rewards'])).toBe('private');
    expect(classifyRoute(['rewards', 'index'])).toBe('private');
    expect(classifyRoute(['rewards', 'inventory'])).toBe('private');
    expect(classifyRoute(['rewards', 'history'])).toBe('private');
    expect(classifyRoute(['rewards', 'leaderboard'])).toBe('public');
    expect(classifyRoute(['rewards', 'hall-of-fame'])).toBe('public');
  });
});

describe('profile header contract', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'profile', 'ProfileHeader.tsx'), 'utf8');
  it('reads the server levelInfo and has no local level formula', () => {
    expect(src).toContain('levelInfo');
    expect(src).not.toMatch(/threshold\s*\+=\s*500/);
    expect(src).not.toContain('calculateLevelInfo');
  });
});
