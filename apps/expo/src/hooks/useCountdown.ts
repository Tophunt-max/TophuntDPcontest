import { useEffect, useState } from 'react';
import {
  clampTimeout,
  deadlineMs,
  ENDED,
  formatTimeRemaining,
  type Deadline,
} from '@/src/lib/countdown';

export interface Countdown {
  /**
   * "2d 4h 10m" / "45s", `ENDED` once the deadline has passed, or null when
   * there is no deadline at all. Null and `ENDED` are deliberately different:
   * the first means "nothing to show", the second means "this is over".
   */
  label: string | null;
  /** True only when a deadline existed and has passed. */
  ended: boolean;
  /** True in the final hour of a still-open deadline, for urgency styling. */
  urgent: boolean;
  /** The resolved deadline in epoch ms, or null. */
  endsAt: number | null;
}

/** Below this much time left, callers highlight the countdown. */
const URGENT_WINDOW_MS = 3_600_000;

/**
 * A live, ticking countdown to `deadline`.
 *
 * One second is the tick rate because the label shows seconds under an hour.
 * The extra `setTimeout` is not redundant: a backgrounded JS timer can be
 * throttled or coalesced, and this guarantees a repaint at the exact moment the
 * deadline lands rather than up to a second late — which is the difference
 * between a card disabling itself on time and accepting one last tap it should
 * have refused.
 *
 * When there is no deadline the hook subscribes to nothing at all, so the very
 * common "contest with no expiry" case costs no timers.
 */
export function useCountdown(deadline: Deadline): Countdown {
  const endsAt = deadlineMs(deadline);

  const [label, setLabel] = useState<string | null>(() => formatTimeRemaining(deadline));

  useEffect(() => {
    if (endsAt === null) {
      setLabel(null);
      return;
    }

    // Recompute immediately: the deadline may have changed since the last
    // render, and waiting a full second to correct the display is visible.
    setLabel(formatTimeRemaining(endsAt));

    const msLeft = endsAt - Date.now();
    if (msLeft <= 0) return; // Already over. Nothing left to tick towards.

    const interval = setInterval(() => setLabel(formatTimeRemaining(endsAt)), 1000);
    // Re-derive from the clock instead of asserting ENDED. For a deadline beyond
    // the ~24.8-day setTimeout ceiling the delay is clamped, so this callback
    // fires EARLY — asserting ENDED there would disable a card that is still
    // open until the next 1s tick corrected it.
    const atEnd = setTimeout(() => setLabel(formatTimeRemaining(endsAt)), clampTimeout(msLeft) + 50);

    return () => {
      clearInterval(interval);
      clearTimeout(atEnd);
    };
    // Keyed on the resolved number, not the raw prop: a parent that rebuilds an
    // equivalent Date or Timestamp object every render would otherwise tear the
    // timers down and rebuild them on every single render.
  }, [endsAt]);

  const ended = endsAt !== null && label === ENDED;
  const msLeft = endsAt === null ? 0 : endsAt - Date.now();

  return {
    label,
    ended,
    urgent: !ended && endsAt !== null && msLeft > 0 && msLeft < URGENT_WINDOW_MS,
    endsAt,
  };
}
