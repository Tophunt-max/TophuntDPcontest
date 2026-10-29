/**
 * Instagram-style offline data: the owner-scoped offline store, React Query
 * persistence (allow-list + private-field filter + owner check), and the
 * account-change rule that no longer wipes a restored login's own caches.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    getAllKeys: async () => [...store.keys()],
    multiRemove: async (ks: string[]) => ks.forEach((k) => store.delete(k)),
  },
}));

import {
  clearOffline, loadOffline, loadOfflineInGroup, MAX_ENTRY_BYTES, offlineOwner, saveOffline, saveOfflineInGroup, usableEntry,
} from '../src/lib/offlineStore';
import { buildSnapshot, persistQueries, restoreQueries, stripPrivateFields } from '../src/lib/queryPersistence';
import { shouldWipeDeviceCaches } from '../src/lib/authState';
import { hasLiveBalance } from '../src/lib/balances';

beforeEach(() => store.clear());

describe('offline store', () => {
  it('returns an entry only to its owner, within its age', async () => {
    await saveOffline(offlineOwner('alice'), 'chats', [{ id: 'c1' }]);
    expect((await loadOffline(offlineOwner('alice'), 'chats'))?.data).toEqual([{ id: 'c1' }]);
    expect(await loadOffline(offlineOwner('bob'), 'chats')).toBeNull();
    expect(await loadOffline(offlineOwner(null), 'chats')).toBeNull();
    expect(usableEntry({ owner: 'u:a', savedAt: 0, data: 1 }, 'u:a', 1000, 5000)).toBe(false);
  });

  it('skips over-size values and survives a full / broken storage', async () => {
    expect(await saveOffline('u:a', 'big', 'x'.repeat(MAX_ENTRY_BYTES + 10))).toBe(false);
    store.set('tophunt.offline.v1:bad', '{not json');
    expect(await loadOffline('u:a', 'bad')).toBeNull();
  });

  it('clearOffline wipes everything and drops a save that started before it', async () => {
    await saveOffline('u:a', 'n', [1]);
    const { offlineGeneration } = await import('../src/lib/offlineStore');
    const gen = offlineGeneration();
    await clearOffline();
    expect(await saveOffline('u:a', 'late', [2], gen)).toBe(false);
    expect([...store.keys()].filter((k) => k.startsWith('tophunt.offline'))).toEqual([]);
  });

  it('a group keeps only the most recent members', async () => {
    for (const id of ['c1', 'c2', 'c3']) await saveOfflineInGroup('u:a', 'chat', id, [id], 2);
    expect(await loadOfflineInGroup('u:a', 'chat', 'c1')).toBeNull();
    expect((await loadOfflineInGroup<string[]>('u:a', 'chat', 'c3'))?.data).toEqual(['c3']);
    expect((await loadOfflineInGroup<string[]>('u:a', 'chat', 'c2'))?.data).toEqual(['c2']);
  });
});

describe('query persistence', () => {
  const seed = (qc: QueryClient) => {
    qc.setQueryData(['profile', 'alice'], { uid: 'alice', username: 'alice', email: 'a@x.in', Dpcoin: 500, lockedCoins: 20, signupCompleted: true });
    qc.setQueryData(['explore', 'creators', 10], [{ uid: 'c', phoneNumber: '+91', name: 'C' }]);
    qc.setQueryData(['gamification', 'progression'], { level: 4 });
    qc.setQueryData(['wallet', 'alice'], { balance: 500 });
    qc.setQueryData(['transactions', 'alice'], [{ amount: 5 }]);
  };

  it('saves only allow-listed queries, without contact or balance fields', () => {
    const qc = new QueryClient();
    seed(qc);
    const snap = buildSnapshot(qc);
    const roots = snap.queries.map((q) => q.queryKey[0]).sort();
    expect(roots).toEqual(['explore', 'gamification', 'profile']);
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/a@x\.in|\+91|"Dpcoin"|"lockedCoins"/);
    const profile = snap.queries.find((q) => q.queryKey[0] === 'profile')!.state.data as any;
    expect(profile).toMatchObject({ username: 'alice', signupCompleted: true, __offline: true });
  });

  it('keeps public prize amounts (only account balances are removed)', () => {
    expect(stripPrivateFields({ prize: { coins: 100 }, entryFee: 50, Dpcoin: 9 })).toEqual({ prize: { coins: 100 }, entryFee: 50 });
  });

  it('restores for the same owner only, marked stale, never overwriting newer data', async () => {
    const a = new QueryClient();
    seed(a);
    await persistQueries(a, offlineOwner('alice'));

    const other = new QueryClient();
    expect(await restoreQueries(other, offlineOwner('bob'))).toBe(0);
    expect(other.getQueryData(['profile', 'alice'])).toBeUndefined();

    const b = new QueryClient();
    b.setQueryData(['gamification', 'progression'], { level: 9 }); // fresher in memory
    expect(await restoreQueries(b, offlineOwner('alice'))).toBe(3);
    expect(b.getQueryData(['gamification', 'progression'])).toEqual({ level: 9 });
    expect(b.getQueryData<any>(['profile', 'alice'])).toMatchObject({ username: 'alice', __offline: true });
    expect(b.getQueryCache().find({ queryKey: ['profile', 'alice'] })?.state.isInvalidated).toBe(true);
    expect(b.getQueryData(['wallet', 'alice'])).toBeUndefined();
  });

  it('a restored profile hides balances instead of showing 0', () => {
    expect(hasLiveBalance({ Dpcoin: 0, __offline: true })).toBe(false);
    expect(hasLiveBalance({ Dpcoin: 0 })).toBe(true);
    expect(hasLiveBalance(undefined)).toBe(false);
  });
});

describe('account change', () => {
  it('wipes device caches only when a real account leaves', () => {
    // Continue as guest, then the slow restore of the SAME saved login finishes.
    expect(shouldWipeDeviceCaches(null, 'alice')).toBe(false);
    expect(shouldWipeDeviceCaches('alice', null)).toBe(true); // sign-out
    expect(shouldWipeDeviceCaches('alice', 'bob')).toBe(true); // switch account
  });
});

describe('stories offline', () => {
  it('the stories bar and viewer run their query offline so the device cache is read', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const f of ['src/components/stories/StoriesBar.tsx', 'app/story/view/[userId].tsx']) {
      expect(readFileSync(join(__dirname, '..', f), 'utf8'), f).toContain("networkMode: 'offlineFirst'");
    }
  });
});
