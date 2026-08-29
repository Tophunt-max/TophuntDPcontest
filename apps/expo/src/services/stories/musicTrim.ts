/**
 * Choosing WHICH PART of a track a story plays.
 *
 * A story is short — five seconds for a photo, the clip's own length for a video
 * — while a preview stream is around thirty. Without a start offset every story
 * began at 0:00, so the recognisable part of a song could not be used at all.
 *
 * The arithmetic lives here, away from the screen, because every bug in a trimmer
 * is an off-by-one at an edge: a window that runs past the end of the audio, a
 * negative start, or a window longer than the track. Those are cheap to assert
 * and expensive to notice by hand.
 *
 * All values are milliseconds.
 */

/**
 * Assumed preview length before the player reports a real one.
 *
 * Provider previews are 30s. Used only until `duration` is known — never to
 * clamp what gets published, which uses the measured length.
 */
export const PREVIEW_FALLBACK_MS = 30_000;

/**
 * How long a photo story shows, and therefore how much of a track it can use.
 *
 * Shared so the editor cuts exactly the window the viewer will play. If these two
 * drifted apart the trim would be quietly wrong — audio ending early, or running
 * past what the author auditioned — with nothing to point at.
 */
export const DEFAULT_STORY_WINDOW_MS = 5_000;

/** How much of a track a story can use: the window can never exceed the audio. */
export function usableWindowMs(windowMs: number, trackMs: number): number {
  if (!Number.isFinite(trackMs) || trackMs <= 0) return Math.max(0, windowMs);
  return Math.min(Math.max(0, windowMs), trackMs);
}

/**
 * The furthest the window may start and still fit inside the track.
 *
 * Zero when the window is at least as long as the audio — a 30s window over a 30s
 * preview has exactly one valid position, and offering a scrubber that appears to
 * move but cannot is worse than one that visibly cannot.
 */
export function maxStartMs(windowMs: number, trackMs: number): number {
  const track = Number.isFinite(trackMs) && trackMs > 0 ? trackMs : PREVIEW_FALLBACK_MS;
  return Math.max(0, track - usableWindowMs(windowMs, track));
}

/** Hold a start offset inside the range the track actually allows. */
export function clampStartMs(startMs: number, windowMs: number, trackMs: number): number {
  if (!Number.isFinite(startMs)) return 0;
  return Math.min(Math.max(0, Math.round(startMs)), maxStartMs(windowMs, trackMs));
}

/**
 * Where the window sits along the scrubber, 0..1.
 *
 * 0 when the window cannot move, so the handle pins to the left rather than
 * dividing by zero.
 */
export function startToFraction(startMs: number, windowMs: number, trackMs: number): number {
  const max = maxStartMs(windowMs, trackMs);
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, clampStartMs(startMs, windowMs, trackMs) / max));
}

/** Inverse of `startToFraction`, for turning a drag or tap into an offset. */
export function fractionToStart(fraction: number, windowMs: number, trackMs: number): number {
  if (!Number.isFinite(fraction)) return 0;
  const f = Math.min(1, Math.max(0, fraction));
  return clampStartMs(Math.round(f * maxStartMs(windowMs, trackMs)), windowMs, trackMs);
}

/** Where playback should stop and return to `startMs`. */
export function windowEndMs(startMs: number, windowMs: number, trackMs: number): number {
  const start = clampStartMs(startMs, windowMs, trackMs);
  const track = Number.isFinite(trackMs) && trackMs > 0 ? trackMs : PREVIEW_FALLBACK_MS;
  return Math.min(track, start + usableWindowMs(windowMs, track));
}

/**
 * Whether playback has run past the chosen window and should loop.
 *
 * A small tolerance absorbs the gap between status polls: without it a check that
 * fires slightly late reads as "still inside" and the story hears audio it was
 * never meant to include.
 */
export function shouldLoopBack(
  currentMs: number,
  startMs: number,
  windowMs: number,
  trackMs: number,
  toleranceMs = 120,
): boolean {
  if (!Number.isFinite(currentMs)) return false;
  const start = clampStartMs(startMs, windowMs, trackMs);
  // Seeking is not instant; a position still behind the start means the seek has
  // not landed yet, not that the track ran past the end.
  if (currentMs < start - toleranceMs) return true;
  return currentMs >= windowEndMs(start, windowMs, trackMs) - toleranceMs;
}

/**
 * How far into a pressed element the press landed, in px.
 *
 * `locationX` is NOT present on react-native-web: a press `nativeEvent` there
 * carries `offsetX`/`pageX` and nothing else. Reading only `locationX` therefore
 * yields `undefined` on web, which turns into a start of 0:00 — the scrubber
 * silently refuses to move, on the one platform where it was reported. Native is
 * the mirror image: `locationX` is set and `offsetX` is not.
 *
 * Both are measured from the left edge of the element that was pressed, so either
 * can position the window. Returns null when neither is usable, so the caller can
 * ignore the press instead of jumping to the start.
 */
export function pressOffsetX(nativeEvent: unknown): number | null {
  const e = (nativeEvent ?? {}) as { locationX?: unknown; offsetX?: unknown };
  const candidates = [e.locationX, e.offsetX];
  for (const value of candidates) {
    const n = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** `12_000` -> `"0:12"`. Clock label for the trim handles. */
export function formatClipTime(ms: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
