/**
 * The app's rollout bucket must match the Worker's (apps/worker/src/lib/appControl.ts
 * `rolloutBucket`), or the UI would show a feature the server then refuses. The
 * pinned values are the same ones the Worker test pins.
 */
import { describe, it, expect } from 'vitest';
import { inRollout, rolloutBucket } from '../src/lib/rollout';
import { featureOn } from '../src/lib/appControl';

describe('feature rollout (app side)', () => {
  it('computes the same buckets as the server', () => {
    expect(['user1', 'abc', 'Zx9'].map((u) => rolloutBucket('chat', u))).toEqual([39, 25, 40]);
    expect(rolloutBucket('stories', 'user1')).toBe(86);
  });
  it('follows the percentage; guests only at 100; absent means everyone', () => {
    expect(inRollout({ featureRollout: { chat: 40 } }, 'chat', 'user1')).toBe(true);
    expect(inRollout({ featureRollout: { chat: 39 } }, 'chat', 'user1')).toBe(false);
    expect(inRollout({ featureRollout: { chat: 99 } }, 'chat', null)).toBe(false);
    expect(inRollout({}, 'chat', null)).toBe(true);
  });
  it('a feature switched off stays off whatever the rollout', () => {
    const cfg: any = { features: { chat: false }, featureRollout: { chat: 100 } };
    expect(featureOn(cfg, 'chat' as any, 'user1')).toBe(false);
    expect(featureOn({ features: { chat: true }, featureRollout: { chat: 39 } } as any, 'chat' as any, 'user1')).toBe(false);
  });
});
