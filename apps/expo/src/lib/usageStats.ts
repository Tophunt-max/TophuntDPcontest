/**
 * Anonymous usage counters, the platform-free core: the vocabulary, the buffer
 * and `trackUsage`. Sending, the opt-out storage and the background flush are in
 * src/services/usageStats.ts, which plugs in through `setUsageSink`. Keeping this
 * file free of React Native lets any module (uploads, sync) count something
 * without pulling the app runtime into its imports or tests.
 *
 * Counts are aggregated in memory per (event, dimension) and sent as one small
 * batch, so a session of scrolling is a few data points, not one per card. No
 * identifier ever enters the buffer: the vocabulary below is closed and mirrors
 * the Worker's (apps/worker/src/lib/usageEvents.ts), which drops anything else.
 */
export const USAGE_EVENTS = {
  feed_impression: ['home'],
  story: ['complete', 'skip', 'close'],
  video: ['first_frame', 'stall', 'error'],
  search: ['results', 'empty'],
  sync: ['sent', 'retry', 'failed'],
  upload: ['ok', 'failed', 'cancelled'],
} as const;
export type UsageEvent = keyof typeof USAGE_EVENTS;
export type UsageDim<E extends UsageEvent> = (typeof USAGE_EVENTS)[E][number];

export interface UsageBatchEvent {
  n: UsageEvent;
  d: string;
  c: number;
  ms?: number;
}

/** Same bounds as the Worker, so a full buffer is never refused. */
const MAX_COUNT = 1000;
const MAX_MS = 600_000;

export class UsageBuffer {
  private counts = new Map<string, UsageBatchEvent>();

  add<E extends UsageEvent>(n: E, d: UsageDim<E>, count = 1, ms?: number): void {
    if (!(USAGE_EVENTS[n] as readonly string[] | undefined)?.includes(d)) return;
    const c = Math.max(1, Math.floor(count));
    const key = `${n}|${d}`;
    const cur = this.counts.get(key) ?? { n, d, c: 0 };
    cur.c = Math.min(cur.c + c, MAX_COUNT);
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
      cur.ms = Math.min((cur.ms ?? 0) + Math.min(Math.round(ms), MAX_MS), cur.c * MAX_MS);
    }
    this.counts.set(key, cur);
  }

  get size(): number {
    return this.counts.size;
  }

  /** Everything buffered so far, emptying the buffer. */
  take(): UsageBatchEvent[] {
    const out = [...this.counts.values()];
    this.counts.clear();
    return out;
  }

  clear(): void {
    this.counts.clear();
  }
}

/** The app-wide buffer. */
export const usageBuffer = new UsageBuffer();
let enabled = true;
let onAdd: (() => void) | null = null;

/** Called by the service layer: what to do after a counter is added (schedule a send). */
export function setUsageSink(fn: (() => void) | null): void {
  onAdd = fn;
}

export function usageEnabled(): boolean {
  return enabled;
}

/** Off empties the buffer and stops counting. */
export function setUsageEnabledFlag(next: boolean): void {
  enabled = next;
  if (!next) usageBuffer.clear();
}

/** Count one occurrence (or `count`), optionally with a duration in ms. Never throws. */
export function trackUsage<E extends UsageEvent>(event: E, dim: UsageDim<E>, opts?: { count?: number; ms?: number }): void {
  try {
    if (!enabled) return;
    usageBuffer.add(event, dim, opts?.count ?? 1, opts?.ms);
    onAdd?.();
  } catch {
    /* statistics must never break a screen */
  }
}
