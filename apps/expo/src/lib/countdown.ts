/**
 * Deadline formatting for every countdown in the app.
 *
 * The logic lived inline in `PostCard`, which meant the contest cards had no
 * countdown at all and any new one would have been a second, subtly different
 * copy. The formatting and the "has this passed?" decision are pure functions so
 * they are testable without a renderer; the ticking lives in
 * `src/hooks/useCountdown.ts`.
 *
 * Deadlines arrive in three shapes and all three have to work:
 *  - epoch milliseconds (what the Worker sends: `contests.endsAt`,
 *    `contest_matches.expiresAt`),
 *  - an ISO string,
 *  - a Firestore `Timestamp` with `.toDate()`, still present on some legacy
 *    payloads.
 */

/** The string every caller shows once a deadline has passed. */
export const ENDED = 'Ended';

export type Deadline = number | string | Date | { toDate: () => Date } | null | undefined;

/**
 * Normalise any accepted deadline shape to epoch milliseconds.
 *
 * Returns null for "no deadline", which is NOT the same as 0: a missing
 * `endsAt` means the contest never expires, and coercing that to 0 would mark
 * every open contest as ended in 1970.
 */
export function deadlineMs(value: Deadline): number | null {
  if (value === null || value === undefined || value === '') return null;

  let ms: number;
  if (typeof value === 'number') {
    ms = value;
  } else if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'object' && typeof (value as any).toDate === 'function') {
    // Firestore Timestamp.
    ms = (value as { toDate: () => Date }).toDate().getTime();
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    ms = /^-?\d+$/.test(trimmed) ? Number(trimmed) : new Date(trimmed).getTime();
  } else {
    return null;
  }

  return Number.isFinite(ms) ? ms : null;
}

/**
 * Human countdown to `value`, or `ENDED` once it has passed.
 *
 * Shows the two or three most significant units and only ticks seconds under an
 * hour, so a week-long contest does not repaint a jittering seconds digit for
 * six days.
 *
 * A null deadline returns null, meaning "no countdown to show" — distinct from
 * `ENDED`, which means "there was a deadline and it is behind us". Callers use
 * that difference to decide between hiding the chip and disabling the card.
 */
export function formatTimeRemaining(value: Deadline, nowMs: number = Date.now()): string | null {
  const end = deadlineMs(value);
  if (end === null) return null;

  const diff = end - nowMs;
  if (diff <= 0) return ENDED;

  const totalSec = Math.floor(diff / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** True once the deadline is behind us. A missing deadline never expires. */
export function hasEnded(value: Deadline, nowMs: number = Date.now()): boolean {
  const end = deadlineMs(value);
  return end !== null && end <= nowMs;
}

/**
 * Milliseconds a `setTimeout` may safely be given.
 *
 * `setTimeout` stores its delay in a signed 32-bit int, so anything above
 * ~24.8 days overflows and fires immediately — which would flip a month-long
 * contest to "Ended" the moment it rendered. Clamped rather than skipped so the
 * 1s interval keeps the display correct either way.
 */
export const MAX_TIMEOUT_MS = 2_147_000_000;

export function clampTimeout(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_TIMEOUT_MS);
}
