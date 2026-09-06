/**
 * Fixed-window arithmetic for rate limiting.
 *
 * Its own module for one reason: the real limiter lives inside a Durable Object
 * (src/rateLimiter.ts), which imports `cloudflare:workers` and therefore cannot
 * be loaded by the Node test harness. The harness stands in for the actor with an
 * in-memory fake, and a fake that computed window boundaries even slightly
 * differently would let every rate-limit test pass while production behaved
 * otherwise. Both import these functions, so the one piece where an off-by-one
 * would be invisible is shared rather than duplicated.
 */

/**
 * Which fixed window `nowMs` falls in.
 *
 * Windows are absolute rather than per-key sliding: every key of the same size
 * rolls over at the same instant. That is what makes the counter a single row
 * lookup with no history to scan, and the documented trade-off is that a burst
 * straddling a boundary can spend both windows' budgets. That was already true of
 * the KV implementation this replaces; it is a coarse abuse throttle, not a quota.
 */
export function windowIdFor(nowMs: number, windowSec: number): number {
  return Math.floor(nowMs / 1000 / windowSec);
}

/** When the window ends, in ms since epoch — i.e. when its counter is dead. */
export function windowExpiresAt(windowId: number, windowSec: number): number {
  return (windowId + 1) * windowSec * 1000;
}

/** Guard the caller's numbers so a bad limit can never widen a window. */
export function normalizeSpec(max: number, windowSec: number): { max: number; windowSec: number } {
  return {
    max: Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0,
    windowSec: Number.isFinite(windowSec) ? Math.max(1, Math.floor(windowSec)) : 1,
  };
}
