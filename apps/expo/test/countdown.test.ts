/**
 * The countdown label format.
 *
 * This is a FORMAT CONTRACT, not decoration. The label is rendered inside
 * fixed-width badges (`ContestCountdownBadge`) and inside a chip wedged between
 * two vote percentages (`PostCard`), so its maximum width is a layout input.
 * It used to show three units — "12d 23h 59m", eleven characters — which was the
 * main reason the countdown was hard to read at badge size, and on the Explore
 * card it was long enough to wrap the row it shared and push the title out of the
 * card. Nothing pinned that, so nothing would notice it coming back.
 */
import { describe, it, expect } from 'vitest';

import { ENDED, deadlineMs, formatTimeRemaining, hasEnded } from '@/src/lib/countdown';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** `formatTimeRemaining` for a deadline `ms` in the future. */
const inFuture = (ms: number) => formatTimeRemaining(NOW + ms, NOW);

describe('formatTimeRemaining', () => {
  it('shows at most two units', () => {
    expect(inFuture(12 * DAY + 23 * HOUR + 59 * MIN + 59 * SEC)).toBe('12d 23h');
    expect(inFuture(23 * HOUR + 59 * MIN + 59 * SEC)).toBe('23h 59m');
    expect(inFuture(59 * MIN + 59 * SEC)).toBe('59m 59s');
    expect(inFuture(59 * SEC)).toBe('59s');
  });

  it('never exceeds seven characters, which is what the badge is sized for', () => {
    // Sampled across every branch and both sides of each boundary rather than a
    // couple of happy cases, because the regression this guards against is one
    // unit too many in a single branch.
    const samples = [
      1 * SEC, 59 * SEC,
      1 * MIN, 1 * MIN + 1 * SEC, 59 * MIN + 59 * SEC,
      1 * HOUR, 1 * HOUR + 1 * MIN, 23 * HOUR + 59 * MIN,
      1 * DAY, 1 * DAY + 1 * HOUR,
      9 * DAY + 9 * HOUR, 99 * DAY + 23 * HOUR, 365 * DAY,
    ];
    for (const ms of samples) {
      const label = inFuture(ms);
      expect(label, `label for ${ms}ms`).not.toBeNull();
      expect(label!.length, `"${label}" is too wide for the badge`).toBeLessThanOrEqual(7);
    }
  });

  it('keeps ticking seconds only below an hour', () => {
    // Below an hour a moving digit is information; above it, it is noise that also
    // costs a character. Asserted as "does the label change over one second".
    expect(inFuture(30 * MIN)).not.toBe(inFuture(30 * MIN + SEC));
    expect(inFuture(5 * HOUR)).toBe(inFuture(5 * HOUR + SEC));
    expect(inFuture(5 * DAY)).toBe(inFuture(5 * DAY + SEC));
  });

  it('rolls units over at the boundary rather than showing a zero unit', () => {
    expect(inFuture(1 * DAY)).toBe('1d 0h');
    expect(inFuture(1 * HOUR)).toBe('1h 0m');
    expect(inFuture(1 * MIN)).toBe('1m 0s');
  });

  it('distinguishes "no deadline" from "the deadline passed"', () => {
    // Callers branch on exactly this difference: null hides the chip, ENDED
    // disables the card. Collapsing them would either show "Ended" on every
    // open-ended contest or let a closed one keep accepting taps.
    expect(formatTimeRemaining(null, NOW)).toBeNull();
    expect(formatTimeRemaining(undefined, NOW)).toBeNull();
    expect(formatTimeRemaining('', NOW)).toBeNull();
    expect(formatTimeRemaining(NOW - SEC, NOW)).toBe(ENDED);
    expect(formatTimeRemaining(NOW, NOW)).toBe(ENDED);
  });

  it('treats a missing deadline as never expiring', () => {
    expect(hasEnded(null, NOW)).toBe(false);
    expect(hasEnded(undefined, NOW)).toBe(false);
    // 0 is NOT "no deadline" — coercing it would mark every open contest as
    // having ended in 1970.
    expect(deadlineMs(null)).toBeNull();
    expect(hasEnded(0, NOW)).toBe(true);
  });
});
