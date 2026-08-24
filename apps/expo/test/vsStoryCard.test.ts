/**
 * The gate that decides whether a permanent image gets written.
 *
 * `useVsStoryCard` records a card that the server keeps FIRST-writer-wins, so a
 * wrong decision here puts the wrong picture on both participants' stories for the
 * life of the battle. The React glue around it (a settle timer and two `matchId`
 * re-checks) is not reachable from a plain-Node test, so the decision itself is a
 * pure function and this is where it is pinned.
 */
import { describe, it, expect } from 'vitest';
import { shouldCaptureVsCard, vsImageOf } from '@/src/lib/vsStory';

const ok = {
  matchId: 'match-1',
  canGenerate: true,
  captureSupported: true,
  attempted: new Set<string>(),
};

describe('shouldCaptureVsCard', () => {
  it('captures a battle nobody has captured yet', () => {
    expect(shouldCaptureVsCard(ok)).toBe(true);
  });

  it('refuses without a battle to attribute the card to', () => {
    expect(shouldCaptureVsCard({ ...ok, matchId: null })).toBe(false);
    expect(shouldCaptureVsCard({ ...ok, matchId: undefined })).toBe(false);
    expect(shouldCaptureVsCard({ ...ok, matchId: '' })).toBe(false);
  });

  it('refuses when the viewer is not a participant', () => {
    // Only the two people in the battle may record its card, and the story viewer
    // establishes that from "this is my own reel" rather than by loading the match.
    // A non-participant would be rejected by the server anyway, after paying for a
    // full-screen upload.
    expect(shouldCaptureVsCard({ ...ok, canGenerate: false })).toBe(false);
  });

  it('refuses when the device cannot screenshot', () => {
    // Web, and every native install not rebuilt since the capture module landed.
    expect(shouldCaptureVsCard({ ...ok, captureSupported: false })).toBe(false);
  });

  it('refuses a battle this screen already captured', () => {
    // The ready signal can arrive more than once per battle across re-renders and
    // re-mounts within a reel; without this each one is another upload the server
    // discards.
    expect(shouldCaptureVsCard({ ...ok, attempted: new Set(['match-1']) })).toBe(false);
  });

  it('still captures a DIFFERENT battle in the same reel', () => {
    // Tapping between two of your own battles must produce a card for each.
    expect(shouldCaptureVsCard({ ...ok, matchId: 'match-2', attempted: new Set(['match-1']) })).toBe(true);
  });
});

describe('vsImageOf', () => {
  it('reads the card off the MATCH', () => {
    expect(vsImageOf({ vsImageUrl: 'https://cdn.test/vs-cards/images/a.jpg' })).toBe(
      'https://cdn.test/vs-cards/images/a.jpg',
    );
  });

  it('treats every kind of absence as "no card"', () => {
    // Null is the normal case, not an error: battles that predate the feature,
    // video battles, installs without the native module, and every battle whose
    // stories have expired (the cron deletes the card and clears the column). An
    // empty string is what a careless write would leave, and pointing an Image at
    // it renders nothing.
    expect(vsImageOf(null)).toBeNull();
    expect(vsImageOf(undefined)).toBeNull();
    expect(vsImageOf({})).toBeNull();
    expect(vsImageOf({ vsImageUrl: null })).toBeNull();
    expect(vsImageOf({ vsImageUrl: '' })).toBeNull();
    expect(vsImageOf({ vsImageUrl: 123 })).toBeNull();
  });
});
