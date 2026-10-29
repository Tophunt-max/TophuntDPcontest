/**
 * Pure logic behind the XP / level-up / reward animations. No React, so every
 * rule is unit-tested (test/xpAnimation.test.ts).
 *
 * The rule that matters most: animations only ever DISPLAY values the server
 * returned. Nothing here computes XP, a level or a reward — it decides what to
 * animate between two server snapshots, and makes sure the same server event
 * is never animated twice (polling, refetches, remounts, a second device open).
 */
import type { LevelInfo } from './progression';

// ---------------------------------------------------------------------------
// Bounded seen-set (stable event ids)
// ---------------------------------------------------------------------------

/** A FIFO set that forgets its oldest ids past `max`, so it can never grow unbounded. */
export class BoundedIdSet {
  private ids: string[] = [];
  private set = new Set<string>();
  constructor(private readonly max = 200, initial: string[] = []) {
    for (const id of initial.slice(-max)) this.add(id);
  }
  has(id: string): boolean {
    return this.set.has(id);
  }
  add(id: string): void {
    if (this.set.has(id)) return;
    this.set.add(id);
    this.ids.push(id);
    while (this.ids.length > this.max) this.set.delete(this.ids.shift()!);
  }
  toArray(): string[] {
    return [...this.ids];
  }
  get size(): number {
    return this.set.size;
  }
}

// ---------------------------------------------------------------------------
// XP gain queue
// ---------------------------------------------------------------------------

export interface ServerXpEvent {
  /** The server's event id (user_xp_events.id) — the stable dedupe key. */
  id: string;
  delta: number;
  label: string;
  createdAt: number;
}

export interface XpGainItem {
  key: string;
  amount: number;
  label: string;
  /** Events merged into this item (1 unless batched). */
  count: number;
}

/**
 * Which events in a server snapshot are new to this device.
 *
 * `baseline` is true on the first snapshot a device ever sees (no stored ids):
 * everything is marked seen and nothing animates, so opening the app does not
 * replay history.
 */
export function unseenEvents(events: ServerXpEvent[], seen: BoundedIdSet, baseline: boolean): ServerXpEvent[] {
  const fresh = events.filter((e) => e && typeof e.id === 'string' && !seen.has(e.id));
  for (const e of fresh) seen.add(e.id);
  if (baseline) return [];
  // Only positive, non-zero gains are celebrated; reversals just move the bar.
  return fresh.filter((e) => Number(e.delta) > 0).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Bounded XP-gain queue. A burst (e.g. 12 vote events after a long session)
 * collapses into one "+60 XP" item rather than twelve floating labels.
 */
export class XpGainQueue {
  private items: XpGainItem[] = [];
  constructor(private readonly maxItems = 3, private readonly batchOver = 3) {}
  push(events: ServerXpEvent[]): void {
    if (!events.length) return;
    if (events.length > this.batchOver || this.items.length + events.length > this.maxItems) {
      const total = this.items.reduce((a, i) => a + i.amount, 0) + events.reduce((a, e) => a + Math.max(0, Math.floor(e.delta)), 0);
      const count = this.items.reduce((a, i) => a + i.count, 0) + events.length;
      this.items = [{ key: `batch:${events[events.length - 1].id}`, amount: total, label: `${count} XP events`, count }];
      return;
    }
    for (const e of events) this.items.push({ key: e.id, amount: Math.floor(e.delta), label: e.label, count: 1 });
  }
  shift(): XpGainItem | undefined {
    return this.items.shift();
  }
  get length(): number {
    return this.items.length;
  }
  clear(): void {
    this.items = [];
  }
}

// ---------------------------------------------------------------------------
// Progress bar plan between two server snapshots
// ---------------------------------------------------------------------------

export interface BarSegment {
  /** 0..100 */
  from: number;
  to: number;
  /** Level shown while this segment plays. */
  level: number;
}

const pct = (info: Pick<LevelInfo, 'progress' | 'isMaxLevel'>) =>
  info.isMaxLevel ? 100 : Math.round(Math.max(0, Math.min(1, Number(info.progress) || 0)) * 1000) / 10;

/**
 * How to move the bar from `prev` to `next` (both SERVER snapshots):
 *  - same level: one segment from old % to new %;
 *  - level(s) crossed: fill to 100 on the old level, then 0 → new % on the new
 *    level. Several levels at once still play only these two steps (the
 *    celebration names the range), so the bar never loops N times;
 *  - XP went DOWN (a reversal): jump, no celebration-style fill;
 *  - no previous snapshot: draw the current value without animating.
 */
export function barPlan(prev: LevelInfo | null | undefined, next: LevelInfo): { segments: BarSegment[]; animate: boolean; levelsGained: number } {
  const end = pct(next);
  if (!prev) return { segments: [{ from: end, to: end, level: next.level }], animate: false, levelsGained: 0 };
  if (next.xp < prev.xp || next.level < prev.level) {
    return { segments: [{ from: end, to: end, level: next.level }], animate: false, levelsGained: 0 };
  }
  if (next.level === prev.level) {
    const start = pct(prev);
    return { segments: [{ from: start, to: end, level: next.level }], animate: end !== start, levelsGained: 0 };
  }
  return {
    segments: [
      { from: pct(prev), to: 100, level: prev.level },
      { from: 0, to: end, level: next.level },
    ],
    animate: true,
    levelsGained: next.level - prev.level,
  };
}

// ---------------------------------------------------------------------------
// Timings (ms). Reduced motion: zero durations and no particles.
// ---------------------------------------------------------------------------

export interface MotionTimings {
  bar: number;
  float: number;
  pulse: number;
  dim: number;
  badgeIn: number;
  burst: number;
  levelSwap: number;
  rankReveal: number;
  unlocksReveal: number;
  /** When the Continue button appears (the whole sequence is skippable earlier). */
  continueAt: number;
  /** Auto-dismiss: the celebration never holds the screen. */
  autoDismiss: number;
  particles: number;
}

export function motionTimings(reduceMotion: boolean): MotionTimings {
  if (reduceMotion) {
    return { bar: 0, float: 0, pulse: 0, dim: 0, badgeIn: 0, burst: 0, levelSwap: 0, rankReveal: 0, unlocksReveal: 0, continueAt: 0, autoDismiss: 6000, particles: 0 };
  }
  return {
    bar: 600,
    float: 900,
    pulse: 450,
    dim: 200,
    badgeIn: 450,
    burst: 650,
    levelSwap: 900,
    rankReveal: 1300,
    unlocksReveal: 1650,
    continueAt: 1900,
    autoDismiss: 6000,
    particles: 10,
  };
}

/** The celebration's ordered steps, for tests and for the component's delays. */
export function celebrationSteps(t: MotionTimings): { step: string; at: number }[] {
  return [
    { step: 'dim', at: 0 },
    { step: 'badge', at: t.dim },
    { step: 'burst', at: t.dim + t.badgeIn * 0.6 },
    { step: 'levelSwap', at: t.levelSwap },
    { step: 'rank', at: t.rankReveal },
    { step: 'unlocks', at: t.unlocksReveal },
    { step: 'continue', at: t.continueAt },
  ];
}

// ---------------------------------------------------------------------------
// Level-up events
// ---------------------------------------------------------------------------

/** Stable id for "this account reached this level". It can only happen once. */
export const levelUpEventId = (uid: string, level: number) => `levelup:${uid}:${level}`;

/** Stable id for an achievement unlock (one per tier). */
export const achievementEventId = (uid: string, id: string, tier: number) => `ach:${uid}:${id}:${tier}`;

// ---------------------------------------------------------------------------
// Reward claim result → what the reveal shows
// ---------------------------------------------------------------------------

export type RewardRevealState = 'idle' | 'claiming' | 'claimed' | 'already_claimed' | 'unavailable' | 'expired' | 'offline' | 'failed';

/**
 * Map a claim outcome to a display state. `claimed` requires a SERVER result:
 * the success animation only ever plays with the coins the Worker returned.
 */
export function rewardRevealState(input: {
  pending?: boolean;
  result?: { coins?: number } | null;
  error?: { code?: string; status?: number; reason?: string; message?: string } | null;
}): RewardRevealState {
  if (input.pending) return 'claiming';
  if (input.result && Number.isFinite(Number(input.result.coins))) return 'claimed';
  const e = input.error;
  if (!e) return 'idle';
  if (e.code === 'functions/already-exists' || e.status === 409) return 'already_claimed';
  if (e.reason === 'free_rewards_exhausted' || e.reason === 'reward_budget_unavailable') return 'unavailable';
  if (e.code === 'functions/unavailable' || e.code === 'functions/deadline-exceeded') return 'offline';
  if (e.code === 'functions/not-found' || e.status === 404) return 'expired';
  if (e.code === 'functions/failed-precondition' && /no longer available/i.test(e.message || '')) return 'expired';
  if (e.code === 'functions/failed-precondition') return 'unavailable';
  return 'failed';
}

export const REWARD_REVEAL_COPY: Record<RewardRevealState, string> = {
  idle: '',
  claiming: 'Claiming…',
  claimed: 'Added to your wallet',
  already_claimed: 'Already claimed',
  unavailable: 'Not available right now — your reward is saved',
  expired: 'This reward is no longer available',
  offline: "You're offline — try again when connected",
  failed: 'Could not claim. Try again.',
};

/** Whether the user may retry from this state. */
export const canRetryReward = (s: RewardRevealState) => s === 'failed' || s === 'offline' || s === 'unavailable';

// ---------------------------------------------------------------------------
// Streaks and leaderboard
// ---------------------------------------------------------------------------

export const STREAK_MILESTONES = [7, 30, 100] as const;

/** The milestone this exact streak value hits, if any (server streak after a claim). */
export function streakMilestone(streak: number | null | undefined): number | null {
  const s = Math.floor(Number(streak) || 0);
  return (STREAK_MILESTONES as readonly number[]).includes(s) ? s : null;
}

/**
 * Rank movement between two fetches of the SAME leaderboard. Only shown when
 * both ranks are known; very large jumps (a first page reload, a reset) are
 * treated as "new" rather than animated as a huge climb.
 */
export function rankChange(prev: number | null | undefined, next: number | null | undefined, maxJump = 50): { dir: 'up' | 'down' | 'same' | 'new'; by: number } {
  if (!prev || !next) return { dir: 'new', by: 0 };
  const by = prev - next;
  if (by === 0) return { dir: 'same', by: 0 };
  if (Math.abs(by) > maxJump) return { dir: 'new', by: 0 };
  return { dir: by > 0 ? 'up' : 'down', by: Math.abs(by) };
}

/** Animate a quest/progress change only when it moved by a meaningful step. */
export function meaningfulProgressChange(prev: number | null | undefined, next: number, target: number): boolean {
  if (prev == null || !Number.isFinite(prev)) return false;
  if (next <= prev) return false;
  const step = Math.max(1, target) / 20;
  return next - prev >= step || next >= target;
}
