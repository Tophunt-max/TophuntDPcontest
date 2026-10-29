/**
 * The animation system's rules: what animates between two SERVER snapshots,
 * that the same server event never animates twice, bounded queues, timings,
 * reduced motion, reward outcomes, and cleanup on unmount.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  BoundedIdSet,
  REWARD_REVEAL_COPY,
  XpGainQueue,
  barPlan,
  canRetryReward,
  celebrationSteps,
  levelUpEventId,
  meaningfulProgressChange,
  motionTimings,
  rankChange,
  rewardRevealState,
  streakMilestone,
  unseenEvents,
  type ServerXpEvent,
} from '../src/lib/xpAnimation';
import type { LevelInfo } from '../src/lib/progression';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ev = (id: string, delta: number, t = 1): ServerXpEvent => ({ id, delta, label: id, createdAt: t });
const info = (o: Partial<LevelInfo>): LevelInfo => ({
  xp: 0, level: 1, maxLevel: 100, isMaxLevel: false, levelStartXp: 0, nextLevelXp: 500, xpIntoLevel: 0,
  xpForNextLevel: 500, xpToNextLevel: 500, progress: 0, rank: { id: 'newcomer', name: 'Newcomer', icon: 'leaf', color: '#000000' },
  nextRank: null, nextMilestone: null, ...o,
});

describe('XP gain feed (dedupe by server event id)', () => {
  it('the first snapshot a device sees is a silent baseline', () => {
    const seen = new BoundedIdSet();
    expect(unseenEvents([ev('a', 5), ev('b', 5)], seen, true)).toEqual([]);
    expect(seen.has('a') && seen.has('b')).toBe(true);
  });

  it('a normal gain animates once; polling / duplicate responses never replay it', () => {
    const seen = new BoundedIdSet(200, ['a']);
    expect(unseenEvents([ev('b', 5, 2), ev('a', 5, 1)], seen, false).map((e) => e.id)).toEqual(['b']);
    expect(unseenEvents([ev('b', 5, 2), ev('a', 5, 1)], seen, false)).toEqual([]);
    expect(unseenEvents([ev('b', 5, 2)], seen, false)).toEqual([]);
  });

  it('reversals and zero events move the bar but are not celebrated', () => {
    const seen = new BoundedIdSet();
    expect(unseenEvents([ev('r', -100), ev('z', 0), ev('g', 10)], seen, false).map((e) => e.id)).toEqual(['g']);
  });

  it('the seen set is bounded and forgets the oldest ids', () => {
    const s = new BoundedIdSet(3);
    ['1', '2', '3', '4', '4'].forEach((id) => s.add(id));
    expect(s.size).toBe(3);
    expect(s.has('1')).toBe(false);
    expect(s.toArray()).toEqual(['2', '3', '4']);
  });

  it('the queue batches bursts and never holds more than its bound', () => {
    const q = new XpGainQueue(3, 3);
    q.push([ev('a', 5), ev('b', 5)]);
    expect(q.length).toBe(2);
    q.push(Array.from({ length: 12 }, (_, i) => ev(`v${i}`, 5)));
    expect(q.length).toBe(1);
    expect(q.shift()).toMatchObject({ amount: 70, count: 14 });
    expect(q.shift()).toBeUndefined();
  });
});

describe('progress bar plan between server snapshots', () => {
  it('slides within a level', () => {
    const p = barPlan(info({ xp: 100, progress: 0.2 }), info({ xp: 300, progress: 0.6 }));
    expect(p).toEqual({ segments: [{ from: 20, to: 60, level: 1 }], animate: true, levelsGained: 0 });
  });

  it('crossing a threshold fills, resets and slides on the new level', () => {
    const p = barPlan(info({ xp: 450, progress: 0.9 }), info({ xp: 500, level: 2, progress: 0 }));
    expect(p.segments).toEqual([{ from: 90, to: 100, level: 1 }, { from: 0, to: 0, level: 2 }]);
    expect(p.levelsGained).toBe(1);
  });

  it('several levels in one update still play two steps, not N loops', () => {
    const p = barPlan(info({ xp: 10, progress: 0.02 }), info({ xp: 9000, level: 6, progress: 0.4 }));
    expect(p.segments).toHaveLength(2);
    expect(p.levelsGained).toBe(5);
    expect(p.segments[1]).toEqual({ from: 0, to: 40, level: 6 });
  });

  it('reaching max level fills the bar and stays full', () => {
    const p = barPlan(info({ xp: 100, level: 99, progress: 0.5 }), info({ xp: 999999, level: 100, isMaxLevel: true, progress: 1 }));
    expect(p.segments[p.segments.length - 1].to).toBe(100);
    const again = barPlan(info({ xp: 999999, level: 100, isMaxLevel: true, progress: 1 }), info({ xp: 1000500, level: 100, isMaxLevel: true, progress: 1 }));
    expect(again).toMatchObject({ animate: false, segments: [{ from: 100, to: 100 }] });
  });

  it('no previous snapshot (first render, remount) and reversals jump without animating', () => {
    expect(barPlan(null, info({ progress: 0.5 })).animate).toBe(false);
    expect(barPlan(info({ xp: 900, level: 2, progress: 0.4 }), info({ xp: 400, level: 1, progress: 0.8 })).animate).toBe(false);
  });

  it('an identical refetch does not animate', () => {
    const a = info({ xp: 300, progress: 0.6 });
    expect(barPlan(a, { ...a }).animate).toBe(false);
  });
});

describe('timings and reduced motion', () => {
  it('stays inside the suggested ranges', () => {
    const t = motionTimings(false);
    expect(t.bar).toBeGreaterThanOrEqual(400);
    expect(t.bar).toBeLessThanOrEqual(800);
    expect(t.float).toBeGreaterThanOrEqual(700);
    expect(t.float).toBeLessThanOrEqual(1000);
    expect(t.continueAt).toBeGreaterThanOrEqual(1500);
    expect(t.continueAt).toBeLessThanOrEqual(2500);
    expect(t.particles).toBeLessThanOrEqual(12);
  });

  it('the celebration steps run in order', () => {
    const at = celebrationSteps(motionTimings(false)).map((s) => s.at);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(celebrationSteps(motionTimings(false)).map((s) => s.step)).toEqual(['dim', 'badge', 'burst', 'levelSwap', 'rank', 'unlocks', 'continue']);
  });

  it('reduced motion: no durations, no particles, still dismissible', () => {
    const t = motionTimings(true);
    expect([t.bar, t.float, t.badgeIn, t.levelSwap, t.continueAt, t.particles]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(t.autoDismiss).toBeGreaterThan(0);
  });

  it('every animated component reads the reduced-motion preference', () => {
    for (const f of ['LevelProgressBar', 'XpGainFloat', 'LevelUpCelebration', 'MotionBits', 'ProfileFrame', 'SparkleBurst']) {
      expect(read(`src/components/gamification/${f}.tsx`), f).toContain('useReducedMotion');
    }
  });
});

describe('level-up idempotency', () => {
  it('uses a stable id per account and level', () => {
    expect(levelUpEventId('u1', 5)).toBe('levelup:u1:5');
    expect(levelUpEventId('u1', 5)).toBe(levelUpEventId('u1', 5));
    expect(levelUpEventId('u1', 5)).not.toBe(levelUpEventId('u2', 5));
  });

  it('records the level-up as seen BEFORE showing it, and ends when the screen goes inactive', () => {
    const src = read('src/components/gamification/LevelUpCelebration.tsx');
    expect(src.indexOf('saveSeenIds(')).toBeGreaterThan(0);
    expect(src.indexOf('saveSeenIds(')).toBeLessThan(src.indexOf('setShown({ to: level'));
    expect(src).toContain('useScreenActive');
    expect(src).toMatch(/if \(!active && shown\) dismiss\(\)/);
  });
});

describe('reward reveal never shows success without the server', () => {
  it('maps outcomes to states', () => {
    expect(rewardRevealState({ pending: true })).toBe('claiming');
    expect(rewardRevealState({ result: { coins: 30 } })).toBe('claimed');
    expect(rewardRevealState({ result: {} as any })).toBe('idle');
    expect(rewardRevealState({ error: { code: 'functions/already-exists', status: 409 } })).toBe('already_claimed');
    expect(rewardRevealState({ error: { code: 'functions/failed-precondition', reason: 'free_rewards_exhausted' } })).toBe('unavailable');
    expect(rewardRevealState({ error: { code: 'functions/failed-precondition', reason: 'reward_budget_unavailable' } })).toBe('unavailable');
    expect(rewardRevealState({ error: { code: 'functions/failed-precondition', message: 'This reward is no longer available.' } })).toBe('expired');
    expect(rewardRevealState({ error: { code: 'functions/not-found', status: 404 } })).toBe('expired');
    expect(rewardRevealState({ error: { code: 'functions/unavailable' } })).toBe('offline');
    expect(rewardRevealState({ error: { code: 'functions/internal', status: 500 } })).toBe('failed');
  });

  it('offers retry only where a retry can help', () => {
    expect(canRetryReward('failed')).toBe(true);
    expect(canRetryReward('offline')).toBe(true);
    expect(canRetryReward('already_claimed')).toBe(false);
    expect(canRetryReward('expired')).toBe(false);
    for (const k of Object.keys(REWARD_REVEAL_COPY)) if (k !== 'idle') expect(REWARD_REVEAL_COPY[k as keyof typeof REWARD_REVEAL_COPY].length).toBeGreaterThan(3);
  });

  it('the claimed reveal displays the amount the server returned', () => {
    const src = read('src/components/gamification/MotionBits.tsx');
    expect(src).toMatch(/state === 'claimed' \? `\+\$\{claim\.data\?\.coins\} Diamond`/);
  });
});

describe('streaks, quests and leaderboards', () => {
  it('celebrates exactly the 7 / 30 / 100-day milestones', () => {
    expect([6, 7, 8, 30, 100, 101].map(streakMilestone)).toEqual([null, 7, null, 30, 100, null]);
    expect(streakMilestone(undefined)).toBeNull();
  });

  it('marks rank moves only between two known ranks, and ignores huge jumps', () => {
    expect(rankChange(10, 7)).toEqual({ dir: 'up', by: 3 });
    expect(rankChange(7, 10)).toEqual({ dir: 'down', by: 3 });
    expect(rankChange(7, 7).dir).toBe('same');
    expect(rankChange(undefined, 7).dir).toBe('new');
    expect(rankChange(400, 2).dir).toBe('new');
  });

  it('animates progress only on meaningful server changes', () => {
    expect(meaningfulProgressChange(null, 5, 25)).toBe(false);
    expect(meaningfulProgressChange(5, 5, 25)).toBe(false);
    expect(meaningfulProgressChange(5, 7, 25)).toBe(true);
    expect(meaningfulProgressChange(24, 25, 25)).toBe(true);
  });
});

describe('cleanup on unmount and no writes', () => {
  it('every component with a timer clears it, and cancels its animations', () => {
    for (const f of ['XpGainFloat', 'LevelUpCelebration', 'MotionBits']) {
      const src = read(`src/components/gamification/${f}.tsx`);
      const timers = (src.match(/setTimeout\(/g) || []).length;
      const clears = (src.match(/clearTimeout|clearTimers\(\)/g) || []).length;
      expect(clears, f).toBeGreaterThanOrEqual(timers > 0 ? 1 : 0);
      expect(src, f).toContain('cancelAnimation');
    }
  });

  it('the XP feed clears its queue on unmount and holds no timers', () => {
    const src = read('src/hooks/useXpGainFeed.ts');
    expect(src).toContain('q.clear()');
    expect(src).not.toContain('setTimeout');
  });

  it('nothing in the animation layer can grant XP or rewards on its own', () => {
    for (const f of ['src/lib/xpAnimation.ts', 'src/hooks/useXpGainFeed.ts', 'src/components/gamification/XpGainFloat.tsx', 'src/components/gamification/LevelUpCelebration.tsx', 'src/components/gamification/LevelProgressBar.tsx']) {
      const src = read(f);
      expect(src, f).not.toMatch(/callApi\(|useMutation\(|claimRewardGrant|claimQuest/);
    }
    // The one claim in MotionBits goes through the server mutation and only on a tap.
    const motion = read('src/components/gamification/MotionBits.tsx');
    expect(motion).toMatch(/onPress=\{\(\) => claim\.mutate\(grantId\)\}/);
  });
});

// The reason code the reward reveal relies on must survive the API layer.
const h = vi.hoisted(() => ({ user: { uid: 'alice', getIdToken: async () => 'tok' } as any }));
vi.mock('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: true, isInternetReachable: true }) } }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { currentState: 'active' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn(async () => undefined) }));
vi.mock('@/src/services/firebase/initFirebase', () => ({ auth: { get currentUser() { return h.user; } } }));
vi.mock('@/src/lib/toastBridge', () => ({ emitToast: vi.fn() }));
vi.mock('@/src/lib/profileCompletion', () => ({ markOnboardingIncomplete: vi.fn(), PROFILE_INCOMPLETE_CODE: 'PROFILE_INCOMPLETE' }));

describe('offline / server errors reach the reveal intact', () => {
  it('carries the Worker error reason and status on ApiCallError', async () => {
    (globalThis as any).__DEV__ = false;
    const api = await import('@/src/services/api');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 412,
      headers: new Headers(),
      json: async () => ({ error: { status: 'FAILED_PRECONDITION', message: 'Rewards are used up', reason: 'free_rewards_exhausted' } }),
    })));
    const err: any = await api.callApi('claimRewardGrant', { grantId: 'g' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'functions/failed-precondition', status: 412, reason: 'free_rewards_exhausted' });
    expect(rewardRevealState({ error: err })).toBe('unavailable');
    vi.unstubAllGlobals();
  });
});
