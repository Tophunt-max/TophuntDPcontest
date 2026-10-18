/**
 * The canonical battle share asset and the rules every share entry point uses.
 *
 * The defect this pins: share paths fell back to (or attached outright) ONE
 * participant's photo, or silently sent a link while claiming an image share.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createShareCounter,
  isCanonicalVsImageUrl,
  platformShareMode,
  resolveBattleShareAsset,
  shareOutcomeMessage,
} from '@/src/lib/vsShareAsset';

const CARD = 'https://media.tophunt.in/vs-cards/battles/m1-v1.jpg';
const ALICE_RAW = 'https://media.tophunt.in/contests/2026/10/alice.jpg';

describe('isCanonicalVsImageUrl', () => {
  it('accepts only THIS match\'s server card', () => {
    expect(isCanonicalVsImageUrl(CARD, 'm1')).toBe(true);
    expect(isCanonicalVsImageUrl('https://api.x.workers.dev/media/vs-cards/battles/m1-v2.jpg', 'm1')).toBe(true);
    expect(isCanonicalVsImageUrl(CARD, 'm2')).toBe(false); // another battle's card
    expect(isCanonicalVsImageUrl('https://media.tophunt.in/vs-cards/battles/m10-v1.jpg', 'm1')).toBe(false);
    expect(isCanonicalVsImageUrl(ALICE_RAW, 'm1')).toBe(false); // a participant photo
    expect(isCanonicalVsImageUrl('https://media.tophunt.in/vs-cards/2026/09/client.jpg', 'm1')).toBe(false); // legacy client card
    expect(isCanonicalVsImageUrl('http://media.tophunt.in/vs-cards/battles/m1-v1.jpg', 'm1')).toBe(false);
    expect(isCanonicalVsImageUrl(null, 'm1')).toBe(false);
  });
});

describe('resolveBattleShareAsset', () => {
  it('uses the server-confirmed composite', async () => {
    const a = await resolveBattleShareAsset('m1', {
      fetchShareImage: async () => ({ matchId: 'm1', status: 'ready', url: CARD, kind: 'photo' }),
    });
    expect(a).toEqual({ status: 'ready', matchId: 'm1', source: { kind: 'remote', url: CARD }, origin: 'server' });
  });

  it('never accepts a non-canonical url even if the server field is set', async () => {
    const a = await resolveBattleShareAsset('m1', {
      fetchShareImage: async () => ({ matchId: 'm1', status: 'ready', url: ALICE_RAW }),
    });
    expect(a.status).toBe('unavailable');
  });

  it('discards an answer about a different match', async () => {
    const capture = vi.fn(async () => 'file:///x.jpg');
    const a = await resolveBattleShareAsset('m1', {
      fetchShareImage: async () => ({ matchId: 'm2', status: 'ready', url: 'https://media.tophunt.in/vs-cards/battles/m2-v1.jpg' }),
      capture,
    });
    expect(a).toMatchObject({ status: 'unavailable', reason: 'mismatch' });
    expect(capture).not.toHaveBeenCalled();
  });

  it('on a failed fetch, uses a known url only if it is this match\'s card', async () => {
    const fail = async () => {
      throw new Error('offline');
    };
    expect((await resolveBattleShareAsset('m1', { fetchShareImage: fail, knownUrl: CARD })).status).toBe('ready');
    const raw = await resolveBattleShareAsset('m1', { fetchShareImage: fail, knownUrl: ALICE_RAW });
    expect(raw).toMatchObject({ status: 'unavailable', reason: 'network' });
  });

  it('a delayed image falls back to a gated frame capture for a photo battle', async () => {
    const a = await resolveBattleShareAsset('m1', {
      fetchShareImage: async () => ({ matchId: 'm1', status: 'preparing', kind: 'photo' }),
      capture: async () => 'file:///capture.jpg',
    });
    expect(a).toEqual({ status: 'ready', matchId: 'm1', source: { kind: 'local', uri: 'file:///capture.jpg' }, origin: 'capture' });
  });

  it('a capture that is not ready (or throws) never becomes a successful asset', async () => {
    for (const capture of [async () => null, async () => { throw new Error('view not found'); }]) {
      const a = await resolveBattleShareAsset('m1', {
        fetchShareImage: async () => ({ matchId: 'm1', status: 'preparing', kind: 'photo' }),
        capture: capture as any,
      });
      expect(a.status).toBe('preparing');
    }
  });

  it('never captures a video battle (a VideoView screenshots as black)', async () => {
    const capture = vi.fn(async () => 'file:///black.jpg');
    const a = await resolveBattleShareAsset('m1', {
      fetchShareImage: async () => ({ matchId: 'm1', status: 'unavailable', kind: 'video', reason: 'video_poster_unavailable' }),
      capture,
    });
    expect(a.status).toBe('unavailable');
    expect(capture).not.toHaveBeenCalled();
  });

  it('a waiting battle has no VS image and is never captured', async () => {
    const capture = vi.fn(async () => 'file:///x.jpg');
    const a = await resolveBattleShareAsset('m1', {
      fetchShareImage: async () => ({ matchId: 'm1', status: 'waiting_for_opponent', kind: 'photo' }),
      capture,
    });
    expect(a.status).toBe('waiting_for_opponent');
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('resolveBattleShareAsset — server refusals are final', () => {
  const capture = vi.fn(async () => 'file:///x.jpg');
  for (const [status, reason] of [[403, 'forbidden'], [429, 'rate_limited'], [400, 'refused']] as const) {
    it(`HTTP ${status}: no cached url, no capture`, async () => {
      capture.mockClear();
      const a = await resolveBattleShareAsset('m1', {
        fetchShareImage: async () => {
          throw Object.assign(new Error('x'), { code: 'functions/x', status });
        },
        knownUrl: CARD,
        capture,
      });
      expect(a).toMatchObject({ status: 'unavailable', reason });
      expect(capture).not.toHaveBeenCalled();
    });
  }

  it('a 5xx / offline is transport: the verified known url may be used', async () => {
    for (const err of [Object.assign(new Error('x'), { status: 503 }), Object.assign(new Error('x'), { code: 'functions/unavailable' }), new TypeError('fetch failed')]) {
      const a = await resolveBattleShareAsset('m1', { fetchShareImage: async () => { throw err; }, knownUrl: CARD });
      expect(a.status).toBe('ready');
    }
  });

  it('an `unavailable` answer (cancelled, blocked pair, untrusted media) is never captured around', async () => {
    for (const reason of ['cancelled', 'participants_blocked', 'participant_unavailable', 'untrusted_media']) {
      capture.mockClear();
      const a = await resolveBattleShareAsset('m1', {
        fetchShareImage: async () => ({ matchId: 'm1', status: 'unavailable', kind: 'photo', reason }),
        capture,
      });
      expect(a).toMatchObject({ status: 'unavailable', reason });
      expect(capture).not.toHaveBeenCalled();
    }
  });
});

describe('platformShareMode', () => {
  const ready = { assetStatus: 'ready' as const };
  it('image-capable apps get the image file on native and on file-sharing browsers', () => {
    for (const id of ['wa', 'ms', 'ig', 'tg', 'sc']) {
      expect(platformShareMode(id, { ...ready, isWeb: false, webCanShareFiles: false })).toBe('image_sheet');
      expect(platformShareMode(id, { ...ready, isWeb: true, webCanShareFiles: true })).toBe('image_sheet');
    }
  });
  it('X and Facebook are always link intents (they cannot carry a file)', () => {
    for (const id of ['tw', 'fb']) {
      expect(platformShareMode(id, { ...ready, isWeb: false, webCanShareFiles: true })).toBe('link_intent');
    }
  });
  it('waits while the image is preparing instead of silently sending a link', () => {
    expect(platformShareMode('wa', { assetStatus: 'preparing', isWeb: false, webCanShareFiles: false })).toBe('wait');
    expect(platformShareMode('ig', { assetStatus: 'loading', isWeb: true, webCanShareFiles: true })).toBe('wait');
  });
  it('falls back to the supported link behaviour when no image is possible', () => {
    expect(platformShareMode('wa', { assetStatus: 'unavailable', isWeb: false, webCanShareFiles: false })).toBe('link_intent');
    expect(platformShareMode('tg', { ...ready, isWeb: true, webCanShareFiles: false })).toBe('link_intent');
    expect(platformShareMode('ig', { assetStatus: 'waiting_for_opponent', isWeb: false, webCanShareFiles: false })).toBe('link_sheet');
    expect(platformShareMode('ms', { ...ready, isWeb: true, webCanShareFiles: false })).toBe('link_sheet');
  });
});

describe('createShareCounter', () => {
  it('counts one completed share per session, never opens/dismissals/failures', async () => {
    const bump = vi.fn(async () => ({}));
    const c = createShareCounter(bump);
    expect(c.record('dismissed')).toBe(false);
    expect(c.record('failed')).toBe(false);
    expect(c.record('image_unsupported')).toBe(false);
    expect(c.record('image_saved')).toBe(false);
    expect(c.record('needs_gesture')).toBe(false);
    expect(c.record('shared_image')).toBe(true);
    // Fallbacks, retries and repeat taps of Copy link in the same session.
    expect(c.record('copied_link')).toBe(false);
    expect(c.record('intent_opened')).toBe(false);
    expect(c.record('dm_sent')).toBe(false);
    expect(bump).toHaveBeenCalledTimes(1);
    c.reset();
    expect(c.record('copied_link')).toBe(true);
    expect(bump).toHaveBeenCalledTimes(2);
  });

  it('a failing count bump never throws into the share flow', () => {
    const c = createShareCounter(async () => {
      throw new Error('500');
    });
    expect(() => c.record('shared_link')).not.toThrow();
  });
});

describe('shareOutcomeMessage', () => {
  it('only claims an image when an image was sent', () => {
    expect(shareOutcomeMessage('shared_image')?.text).toContain('VS image');
    expect(shareOutcomeMessage('handed_off_caption_copied')?.text).toContain('VS image');
    for (const o of ['shared_link', 'copied_link', 'intent_opened'] as const) {
      expect(shareOutcomeMessage(o)?.text).not.toContain('image');
      expect(shareOutcomeMessage(o)?.text.toLowerCase()).toContain('link');
    }
    expect(shareOutcomeMessage('failed')?.tone).toBe('error');
    expect(shareOutcomeMessage('dismissed')).toBeNull();
  });
});
