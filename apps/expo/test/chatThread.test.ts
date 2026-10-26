/**
 * Chat thread merging (src/lib/chatThread.ts): a refresh brings only the newest
 * page, so it must merge by id instead of replacing the list.
 */
import { describe, it, expect } from 'vitest';
import { appendOlder, hasNewIncoming, mergeThread, newClientId, outgoingMessageId, type ThreadMessage } from '@/src/lib/chatThread';

const srv = (id: string, at: number, senderId = 'bob', text = id) => ({ id, senderId, text, createdAt: at });
const local = (id: string, at: number, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({
  _id: id,
  text: id,
  createdAt: new Date(at),
  user: { _id: 'alice' },
  ...extra,
});
const ids = (list: ThreadMessage[]) => list.map((m) => m._id);

describe('client ids', () => {
  it('fit the server rule and become the server id', () => {
    const id = newClientId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newClientId()).not.toBe(id);
    expect(outgoingMessageId('alice', id)).toBe(`alice_${id}`);
  });
});

describe('mergeThread', () => {
  it('keeps a bubble still being sent when a refresh lands', () => {
    const pending = local('alice_c1', 300, { pending: true });
    const out = mergeThread([pending], [srv('m1', 100), srv('m2', 200)]);
    expect(ids(out)).toEqual(['alice_c1', 'm2', 'm1']);
  });

  it('replaces the bubble with the server copy when it shares the id (no duplicate)', () => {
    const pending = local('alice_c1', 300, { pending: true });
    const out = mergeThread([pending], [srv('m1', 100), srv('alice_c1', 301, 'alice', 'hi')]);
    expect(ids(out)).toEqual(['alice_c1', 'm1']);
    expect(out[0].pending).toBeUndefined();
    expect(out[0].sent).toBe(true);
  });

  it('keeps older pages loaded with "load earlier"', () => {
    const older = [local('o1', 10, { sent: true }), local('o2', 20, { sent: true })];
    const out = mergeThread(older, [srv('m1', 100), srv('m2', 200)]);
    expect(ids(out)).toEqual(['m2', 'm1', 'o2', 'o1']);
  });

  it('drops an acknowledged message the server no longer returns inside the page range', () => {
    const shown = [local('m1', 100, { sent: true }), local('gone', 150, { sent: true })];
    const out = mergeThread(shown, [srv('m1', 100), srv('m2', 200)]);
    expect(ids(out)).toEqual(['m2', 'm1']);
  });
});

describe('appendOlder', () => {
  it('adds an older page below, without duplicates', () => {
    const shown = mergeThread([], [srv('m3', 300), srv('m4', 400)]);
    const out = appendOlder(shown, [srv('m1', 100), srv('m2', 200), srv('m3', 300)]);
    expect(ids(out)).toEqual(['m4', 'm3', 'm2', 'm1']);
  });
});

describe('hasNewIncoming', () => {
  it('is true only for someone else\'s message newer than the mark', () => {
    const page = [srv('m1', 100, 'bob'), srv('m2', 200, 'alice')];
    expect(hasNewIncoming(page, 'alice', 0)).toBe(true);
    expect(hasNewIncoming(page, 'alice', 100)).toBe(false);
    expect(hasNewIncoming(page, 'bob', 100)).toBe(true);
  });
});
