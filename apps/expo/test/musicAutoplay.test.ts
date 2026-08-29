/**
 * Autoplay with sound, and the fallback that makes it safe.
 *
 * The trap this guards: expo-audio's web backend calls `media.play()` without
 * awaiting it AND sets its own `isPlaying = true` regardless, so a browser refusal
 * is invisible through `playing`. Only `paused` tells the truth. Get this wrong and
 * the story is silent while the pill shows a live speaker — worse than starting
 * muted, because there is nothing to tap and no reason to think you should.
 */
import { describe, it, expect } from 'vitest';

import {
  STARTS_MUTED,
  AUTOPLAY_PROBE_MS,
  AUTOPLAY_CONFIRM_MS,
  shouldProbeAutoplay,
  autoplayRefused,
  isMutedNow,
  toggleMute,
  musicPillLabel,
} from '@/src/services/stories/musicAutoplay';

const base = { hasMusic: true, muted: false, intendedToPlay: true, alreadyBlocked: false };

describe('STARTS_MUTED', () => {
  it('starts audible — the whole point', () => {
    expect(STARTS_MUTED).toBe(false);
  });
});

describe('probe timings', () => {
  it('checks quickly, then confirms later', () => {
    expect(AUTOPLAY_PROBE_MS).toBeGreaterThanOrEqual(200);
    expect(AUTOPLAY_PROBE_MS).toBeLessThanOrEqual(1000);
    // The progress check must come strictly later: a cold fetch legitimately has
    // not advanced the clock by the time the fast probe runs.
    expect(AUTOPLAY_CONFIRM_MS).toBeGreaterThan(AUTOPLAY_PROBE_MS);
  });
});

describe('shouldProbeAutoplay', () => {
  it('probes when sound was asked for and something can play it', () => {
    expect(shouldProbeAutoplay(base)).toBe(true);
  });

  it('does not probe a story with no soundtrack', () => {
    expect(shouldProbeAutoplay({ ...base, hasMusic: false })).toBe(false);
  });

  it('does not probe while muted — a muted play is never refused', () => {
    expect(shouldProbeAutoplay({ ...base, muted: true })).toBe(false);
  });

  it('does not probe a story that is deliberately not playing', () => {
    // Long-pressed, or a sheet is open. Otherwise a paused story reads as refused.
    expect(shouldProbeAutoplay({ ...base, intendedToPlay: false })).toBe(false);
  });

  it('stops probing once the answer is known', () => {
    expect(shouldProbeAutoplay({ ...base, alreadyBlocked: true })).toBe(false);
  });
});

describe('autoplayRefused', () => {
  const playing = { paused: false, progressed: true, confirmed: true, muted: false, intendedToPlay: true };

  it('is false when audio is genuinely playing', () => {
    expect(autoplayRefused(playing)).toBe(false);
  });

  it('is true when the element never left paused', () => {
    // What a blocked autoplay looks like, and it is knowable quickly.
    expect(autoplayRefused({ ...playing, paused: true, confirmed: false, progressed: false })).toBe(true);
  });

  it('is true when it claims to play but the clock never moved', () => {
    // Measured in Chromium: a source that cannot play reports paused:false with
    // currentTime pinned at 0. `paused` alone would call this success.
    expect(autoplayRefused({ ...playing, paused: false, progressed: false, confirmed: true })).toBe(true);
  });

  it('does NOT call slow buffering a failure before the confirm window', () => {
    // Not progressed yet, but not conclusive either.
    expect(autoplayRefused({ ...playing, paused: false, progressed: false, confirmed: false })).toBe(false);
  });

  it('is false for a story paused during the probe window', () => {
    // A long-press mid-probe must not permanently mark sound as blocked.
    expect(autoplayRefused({ ...playing, paused: true, intendedToPlay: false })).toBe(false);
  });

  it('is false when the user muted mid-probe', () => {
    expect(autoplayRefused({ ...playing, paused: true, muted: true })).toBe(false);
  });

  it('treats a paused element as failed even before confirmation', () => {
    // The fast signal must not be gated behind the slow one.
    expect(autoplayRefused({ ...playing, paused: true, progressed: true, confirmed: false })).toBe(true);
  });
});

describe('musicPillLabel', () => {
  it('names the action while muted, whatever the reason', () => {
    // A refused autoplay and a user-muted track need the same one-tap remedy.
    expect(musicPillLabel(true, 'Husn', 'Anuv Jain')).toBe('Tap for sound · Husn');
    expect(musicPillLabel(true)).toBe('Tap for sound');
    expect(musicPillLabel(true, null)).toBe('Tap for sound');
  });

  it('reads as a now-playing label once sound is on', () => {
    expect(musicPillLabel(false, 'Husn', 'Anuv Jain')).toBe('Husn · Anuv Jain');
  });

  it('omits a missing artist rather than leaving a dangling separator', () => {
    expect(musicPillLabel(false, 'Husn')).toBe('Husn');
    expect(musicPillLabel(false, 'Husn', null)).toBe('Husn');
  });

  it('falls back to a generic label when the track has no title', () => {
    // A dead or unnamed track still gets a working control.
    expect(musicPillLabel(false, null, 'Anuv Jain')).toBe('Music');
  });

  it('never returns an empty label — the pill would be a blank pillow', () => {
    for (const muted of [true, false]) {
      expect(musicPillLabel(muted, '', '')).not.toBe('');
    }
  });
});


describe('mute state — a refusal and a choice are not the same thing', () => {
  it('is silent for either reason', () => {
    expect(isMutedNow({ userMuted: false, soundBlocked: false })).toBe(false);
    expect(isMutedNow({ userMuted: true, soundBlocked: false })).toBe(true);
    expect(isMutedNow({ userMuted: false, soundBlocked: true })).toBe(true);
  });

  it('clears BOTH reasons when sound is switched on', () => {
    // The tap is itself the gesture the browser was waiting for. Toggling
    // userMuted alone would leave a blocked story stuck silent however often it
    // was tapped — the bug this function exists to prevent.
    expect(toggleMute({ userMuted: false, soundBlocked: true })).toEqual({
      userMuted: false,
      soundBlocked: false,
    });
    expect(toggleMute({ userMuted: true, soundBlocked: true })).toEqual({
      userMuted: false,
      soundBlocked: false,
    });
  });

  it('records a deliberate mute when sound was on', () => {
    expect(toggleMute({ userMuted: false, soundBlocked: false })).toEqual({
      userMuted: true,
      soundBlocked: false,
    });
  });

  it('round-trips: on -> off -> on', () => {
    const off = toggleMute({ userMuted: false, soundBlocked: false });
    expect(isMutedNow(off)).toBe(true);
    const on = toggleMute(off);
    expect(isMutedNow(on)).toBe(false);
  });

  it('always ends unmuted from a blocked state, in one tap', () => {
    const s = toggleMute({ userMuted: false, soundBlocked: true });
    expect(isMutedNow(s)).toBe(false);
  });
});
