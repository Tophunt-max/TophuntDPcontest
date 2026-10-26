import { describe, it, expect, vi } from 'vitest';

import { shouldAutoplay, visibleIdsFor } from '@/src/lib/playbackPolicy';
import { hlsErrorKind, initialHlsRecovery, nextHlsRecovery, MAX_NETWORK_RECOVERIES } from '@/src/lib/hlsRecovery';

vi.mock('@/src/services/api', () => ({ callApi: async () => ({}) }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const { videoStatusPollMs } = await import('@/src/hooks/useVideoStatus');

const on = { visible: true, screenFocused: true, appActive: true, reduceMotion: false };

describe('feed autoplay policy', () => {
  it('plays only a visible card on a focused screen in a foreground app', () => {
    expect(shouldAutoplay(on)).toBe(true);
    expect(shouldAutoplay({ ...on, visible: false })).toBe(false);
    expect(shouldAutoplay({ ...on, screenFocused: false })).toBe(false); // another screen on top
    expect(shouldAutoplay({ ...on, appActive: false })).toBe(false);
    expect(shouldAutoplay({ ...on, reduceMotion: true })).toBe(false);
  });

  it('visible ids are exactly the viewable cards, with no look-ahead and no skeleton rows', () => {
    const ids = visibleIdsFor([{ item: { id: 'a' } }, { item: { id: 'b' } }, { item: 3 }, { item: null }]);
    expect([...ids]).toEqual(['a', 'b']);
  });
});

describe('hls.js fatal error recovery', () => {
  it('restarts loading for network errors a bounded number of times, then fails', () => {
    const st = initialHlsRecovery();
    for (let i = 0; i < MAX_NETWORK_RECOVERIES; i++) expect(nextHlsRecovery(st, 'networkError')).toBe('startLoad');
    expect(nextHlsRecovery(st, 'networkError')).toBe('fail');
  });

  it('media errors: recover, then swap audio codec and recover, then fail', () => {
    const st = initialHlsRecovery();
    expect(nextHlsRecovery(st, 'mediaError')).toBe('recoverMedia');
    expect(nextHlsRecovery(st, 'mediaError')).toBe('swapAudioAndRecover');
    expect(nextHlsRecovery(st, 'mediaError')).toBe('fail');
  });

  it('anything else fails at once, and the hls.js type strings map correctly', () => {
    expect(nextHlsRecovery(initialHlsRecovery(), 'other')).toBe('fail');
    expect(hlsErrorKind('networkError')).toBe('networkError');
    expect(hlsErrorKind('mediaError')).toBe('mediaError');
    expect(hlsErrorKind('keySystemError')).toBe('other');
  });
});

describe('video encode-status polling', () => {

  it('stops at a terminal status', () => {
    expect(videoStatusPollMs('ready', 1)).toBe(false);
    expect(videoStatusPollMs('failed', 1)).toBe(false);
  });
  it('polls every 5 s during a normal encode, then backs off to a minute, then stops', () => {
    expect(videoStatusPollMs('processing', 0)).toBe(5_000);
    expect(videoStatusPollMs('processing', 11)).toBe(5_000);
    expect(videoStatusPollMs('processing', 16)).toBe(10_000);
    expect(videoStatusPollMs('processing', 40)).toBe(60_000);
    expect(videoStatusPollMs('processing', 51)).toBe(false);
  });
  it('stops after three answers when the server has no row for the video', () => {
    expect(videoStatusPollMs(null, 2)).toBe(5_000);
    expect(videoStatusPollMs(null, 3)).toBe(false);
  });
});
