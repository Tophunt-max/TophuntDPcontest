/**
 * Format an epoch-millisecond timestamp as a short local clock time (e.g. "09:41").
 *
 * The Worker returns all story/view timestamps as plain INTEGER epoch
 * milliseconds — not Firestore Timestamps. Several call sites used to read
 * `.seconds` off these numbers, which yielded `Invalid Date`. Returns an empty
 * string for missing or unparseable values so the UI renders nothing rather
 * than "NaN".
 */
export function formatClockTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
