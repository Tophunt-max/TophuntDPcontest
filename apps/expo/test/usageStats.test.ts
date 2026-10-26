/**
 * Anonymous usage counters, app side (src/lib/usageStats.ts): closed vocabulary,
 * aggregation, the same bounds as the Worker, and the off switch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { UsageBuffer, USAGE_EVENTS, setUsageEnabledFlag, setUsageSink, trackUsage, usageBuffer } from '@/src/lib/usageStats';

beforeEach(() => {
  setUsageEnabledFlag(true);
  setUsageSink(null);
  usageBuffer.clear();
});

describe('UsageBuffer', () => {
  it('merges per event and dimension and drops anything outside the vocabulary', () => {
    const b = new UsageBuffer();
    b.add('story', 'complete');
    b.add('story', 'complete', 2);
    b.add('video', 'first_frame', 1, 800);
    b.add('video', 'first_frame', 1, 200);
    b.add('story', 'user:abc' as any);
    b.add('login' as any, 'x' as any);
    expect(b.take()).toEqual([
      { n: 'story', d: 'complete', c: 3 },
      { n: 'video', d: 'first_frame', c: 2, ms: 1000 },
    ]);
    expect(b.size).toBe(0);
  });
  it('caps counts at 1000 and a duration at 10 minutes per occurrence', () => {
    const b = new UsageBuffer();
    b.add('upload', 'ok', 5000, 9e9);
    expect(b.take()).toEqual([{ n: 'upload', d: 'ok', c: 1000, ms: 600_000 }]);
  });
  it('matches the Worker vocabulary', () => {
    // apps/worker/src/lib/usageEvents.ts ANALYTICS_EVENTS; the Worker drops anything else.
    expect(USAGE_EVENTS).toEqual({
      feed_impression: ['home'],
      story: ['complete', 'skip', 'close'],
      video: ['first_frame', 'stall', 'error'],
      search: ['results', 'empty'],
      sync: ['sent', 'retry', 'failed'],
      upload: ['ok', 'failed', 'cancelled'],
    });
  });
});

describe('trackUsage', () => {
  it('counts and notifies the sender', () => {
    let notified = 0;
    setUsageSink(() => notified++);
    trackUsage('search', 'empty');
    trackUsage('search', 'empty');
    expect(notified).toBe(2);
    expect(usageBuffer.take()).toEqual([{ n: 'search', d: 'empty', c: 2 }]);
  });
  it('while switched off counts nothing, and switching off empties the buffer', () => {
    trackUsage('sync', 'sent', { count: 3 });
    setUsageEnabledFlag(false);
    expect(usageBuffer.size).toBe(0);
    trackUsage('sync', 'sent');
    expect(usageBuffer.size).toBe(0);
  });
});
