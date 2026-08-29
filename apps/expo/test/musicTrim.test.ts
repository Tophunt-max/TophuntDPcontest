/**
 * Trim arithmetic. Every bug in a trimmer is an edge case: a window running past
 * the end of the audio, a negative start, or a window longer than the track. The
 * screen cannot assert any of that, so it is all pinned here.
 */
import { describe, it, expect } from 'vitest';

import {
  PREVIEW_FALLBACK_MS,
  usableWindowMs,
  maxStartMs,
  clampStartMs,
  startToFraction,
  fractionToStart,
  windowEndMs,
  shouldLoopBack,
  pressOffsetX,
  formatClipTime,
} from '@/src/services/stories/musicTrim';

const TRACK = 30_000; // a provider preview
const PHOTO = 5_000; // a photo story

describe('usableWindowMs', () => {
  it('uses the whole window when the track is longer', () => {
    expect(usableWindowMs(PHOTO, TRACK)).toBe(PHOTO);
  });

  it('never exceeds the track', () => {
    // A 40s video against a 30s preview can only use 30s.
    expect(usableWindowMs(40_000, TRACK)).toBe(TRACK);
  });

  it('survives an unknown track length', () => {
    expect(usableWindowMs(PHOTO, 0)).toBe(PHOTO);
    expect(usableWindowMs(PHOTO, NaN)).toBe(PHOTO);
  });
});

describe('maxStartMs', () => {
  it('leaves room for the window', () => {
    expect(maxStartMs(PHOTO, TRACK)).toBe(25_000);
  });

  it('is zero when the window fills the track', () => {
    // Exactly one valid position — the scrubber must not pretend to move.
    expect(maxStartMs(TRACK, TRACK)).toBe(0);
    expect(maxStartMs(40_000, TRACK)).toBe(0);
  });

  it('falls back to the assumed preview length before duration is known', () => {
    expect(maxStartMs(PHOTO, 0)).toBe(PREVIEW_FALLBACK_MS - PHOTO);
  });
});

describe('clampStartMs', () => {
  it('keeps a valid start untouched', () => {
    expect(clampStartMs(12_000, PHOTO, TRACK)).toBe(12_000);
  });

  it('refuses a negative start', () => {
    expect(clampStartMs(-5_000, PHOTO, TRACK)).toBe(0);
  });

  it('pulls a start back so the window fits', () => {
    // 29s start + 5s window would run 4s past the end of the audio.
    expect(clampStartMs(29_000, PHOTO, TRACK)).toBe(25_000);
  });

  it('collapses to 0 when the window fills the track', () => {
    expect(clampStartMs(10_000, TRACK, TRACK)).toBe(0);
  });

  it('rounds to whole milliseconds', () => {
    expect(clampStartMs(1234.7, PHOTO, TRACK)).toBe(1235);
  });

  it('treats a non-finite start as the beginning', () => {
    expect(clampStartMs(NaN, PHOTO, TRACK)).toBe(0);
  });
});

describe('scrubber position round-trip', () => {
  it('maps a fraction to a start and back', () => {
    const start = fractionToStart(0.5, PHOTO, TRACK);
    expect(start).toBe(12_500);
    expect(startToFraction(start, PHOTO, TRACK)).toBeCloseTo(0.5, 5);
  });

  it('pins both ends', () => {
    expect(fractionToStart(0, PHOTO, TRACK)).toBe(0);
    expect(fractionToStart(1, PHOTO, TRACK)).toBe(25_000);
    expect(startToFraction(0, PHOTO, TRACK)).toBe(0);
    expect(startToFraction(25_000, PHOTO, TRACK)).toBe(1);
  });

  it('clamps a drag past either edge', () => {
    expect(fractionToStart(-0.4, PHOTO, TRACK)).toBe(0);
    expect(fractionToStart(1.8, PHOTO, TRACK)).toBe(25_000);
  });

  it('reports 0 rather than dividing by zero when the window cannot move', () => {
    expect(startToFraction(0, TRACK, TRACK)).toBe(0);
    expect(fractionToStart(0.7, TRACK, TRACK)).toBe(0);
  });
});

describe('windowEndMs', () => {
  it('is start plus window', () => {
    expect(windowEndMs(10_000, PHOTO, TRACK)).toBe(15_000);
  });

  it('never runs past the track', () => {
    expect(windowEndMs(29_000, PHOTO, TRACK)).toBe(30_000);
    expect(windowEndMs(0, 40_000, TRACK)).toBe(TRACK);
  });
});

describe('shouldLoopBack', () => {
  it('is false in the middle of the window', () => {
    expect(shouldLoopBack(12_000, 10_000, PHOTO, TRACK)).toBe(false);
  });

  it('is true at the end of the window', () => {
    // The whole point: loop back to the chosen start, not to 0:00.
    expect(shouldLoopBack(15_000, 10_000, PHOTO, TRACK)).toBe(true);
  });

  it('fires slightly early so a late poll cannot leak audio past the window', () => {
    expect(shouldLoopBack(14_950, 10_000, PHOTO, TRACK)).toBe(true);
  });

  it('is true when playback is behind the start, because looping restarts at 0', () => {
    // `loop` on the player restarts at 0:00, which is outside the chosen window.
    expect(shouldLoopBack(200, 10_000, PHOTO, TRACK)).toBe(true);
  });

  it('tolerates a seek that has not quite landed', () => {
    expect(shouldLoopBack(9_950, 10_000, PHOTO, TRACK)).toBe(false);
  });

  it('ignores a non-finite position rather than seeking in a loop', () => {
    expect(shouldLoopBack(NaN, 10_000, PHOTO, TRACK)).toBe(false);
  });
});

describe('formatClipTime', () => {
  it('formats as m:ss', () => {
    expect(formatClipTime(0)).toBe('0:00');
    expect(formatClipTime(9_000)).toBe('0:09');
    expect(formatClipTime(12_400)).toBe('0:12');
    expect(formatClipTime(65_000)).toBe('1:05');
  });

  it('does not render a negative or bogus time', () => {
    expect(formatClipTime(-1_000)).toBe('0:00');
    expect(formatClipTime(NaN)).toBe('0:00');
  });
});


/**
 * Where a press landed.
 *
 * Verified against react-native-web in a real browser: a Pressable's press
 * nativeEvent there has NO `locationX` — only `offsetX`/`pageX`. Reading just
 * `locationX` made the scrubber silently refuse to move on web, which is the
 * platform it was reported on. Native is the mirror image.
 */
describe('pressOffsetX', () => {
  it('uses locationX on native', () => {
    expect(pressOffsetX({ locationX: 200, pageX: 220 })).toBe(200);
  });

  it('falls back to offsetX on web, where locationX is absent', () => {
    // The exact shape observed in Chromium via react-native-web.
    expect(pressOffsetX({ pageX: 220, clientX: 220, offsetX: 200 })).toBe(200);
  });

  it('prefers locationX when both are present', () => {
    expect(pressOffsetX({ locationX: 10, offsetX: 999 })).toBe(10);
  });

  it('accepts a press at the very left edge', () => {
    // 0 is a real position, so it must not be mistaken for "missing".
    expect(pressOffsetX({ offsetX: 0 })).toBe(0);
  });

  it('returns null rather than 0 when neither is usable', () => {
    // Null lets the caller ignore the press; 0 would silently jump to the start.
    expect(pressOffsetX({ pageX: 220 })).toBeNull();
    expect(pressOffsetX({})).toBeNull();
    expect(pressOffsetX(null)).toBeNull();
    expect(pressOffsetX({ locationX: NaN, offsetX: undefined })).toBeNull();
  });
});
