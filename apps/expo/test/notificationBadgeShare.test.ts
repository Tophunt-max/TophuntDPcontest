/**
 * The bell and the open notifications list share one fetch per event.
 *
 * Both subscribe to `user:<uid>` with the same filter. While the list is open,
 * its fetch carries the badge count (X-Unread-Count) and the bell must not issue
 * its own `/unread-count` request for the same event. Against an older Worker
 * that sends no header, the bell must keep fetching for itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  type Sub = { channel: string; fetcher: () => Promise<any>; callback: (d: any) => void; opts: any };
  const subs: Sub[] = [];
  const calls: string[] = [];
  let unreadHeader: string | null = '4';
  return {
    subs,
    calls,
    setHeader: (v: string | null) => {
      unreadHeader = v;
    },
    live: (channel: string, fetcher: () => Promise<any>, callback: (d: any) => void, opts: any = {}) => {
      const sub = { channel, fetcher, callback, opts };
      subs.push(sub);
      return () => {
        subs.splice(subs.indexOf(sub), 1);
      };
    },
    readApi: async (path: string) => {
      calls.push(path);
      if (path === '/read/notifications/unread-count') return { count: 9 };
      return [];
    },
    readApiWithHeaders: async (path: string, params: any) => {
      calls.push(`${path}?withUnread=${params?.withUnread}`);
      return { data: [{ id: 'n1' }], headers: new Headers(unreadHeader == null ? {} : { 'X-Unread-Count': unreadHeader }) };
    },
    callApi: async () => ({}),
  };
});

vi.mock('../src/services/realtime', () => ({ live: h.live }));
vi.mock('@/src/services/realtime', () => ({ live: h.live }));
vi.mock('../src/services/api', () => ({
  readApi: h.readApi, readApiWithHeaders: h.readApiWithHeaders, readApiWithCursor: async () => ({ data: [], nextCursor: null }), callApi: h.callApi,
}));
vi.mock('@/src/services/api', () => ({
  readApi: h.readApi, readApiWithHeaders: h.readApiWithHeaders, readApiWithCursor: async () => ({ data: [], nextCursor: null }), callApi: h.callApi,
}));
vi.mock('expo-notifications', () => ({ setBadgeCountAsync: async () => {}, setNotificationHandler: () => {} }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));
vi.mock('firebase/app', () => ({ getApp: () => ({}) }));

import { notificationService, __resetBadgeStateForTests } from '@/src/services/notifications/notificationService';

/** Fire a socket event the way realtime.live() would. */
async function emit(event: any) {
  for (const s of [...h.subs]) {
    if (s.opts.filter && !s.opts.filter(event)) continue;
    if (!s.opts.shouldRefresh || s.opts.shouldRefresh(event)) s.callback(await s.fetcher());
  }
}

beforeEach(() => {
  h.subs.length = 0;
  h.calls.length = 0;
  h.setHeader('4');
  __resetBadgeStateForTests();
});

describe('notification badge sharing', () => {
  it('alone, the bell fetches its own count', async () => {
    const counts: number[] = [];
    notificationService.subscribeToUnreadCount('alice', (n) => counts.push(n));
    await emit({ type: 'notification' });
    expect(h.calls).toEqual(['/read/notifications/unread-count']);
    expect(counts).toEqual([9]);
  });

  it('with the list open, one event costs one request and still updates the bell', async () => {
    const counts: number[] = [];
    notificationService.subscribeToUnreadCount('alice', (n) => counts.push(n));
    notificationService.subscribeToNotifications('alice', 30, () => {});
    // First list fetch learns the Worker supports the header.
    await h.subs[1].callback(await h.subs[1].fetcher());
    h.calls.length = 0;
    counts.length = 0;

    await emit({ type: 'notification' });
    expect(h.calls).toEqual(['/read/notifications?withUnread=1']);
    expect(counts).toEqual([4]);
  });

  it('the bell’s safety-net poll reuses a fresh shared count instead of fetching', async () => {
    const counts: number[] = [];
    notificationService.subscribeToUnreadCount('alice', (n) => counts.push(n));
    notificationService.subscribeToNotifications('alice', 30, () => {});
    await h.subs[1].callback(await h.subs[1].fetcher());
    h.calls.length = 0;
    h.subs[0].callback(await h.subs[0].fetcher()); // the interval tick
    expect(h.calls).toEqual([]);
  });

  it('against a Worker without X-Unread-Count, the bell keeps fetching for itself', async () => {
    h.setHeader(null);
    const counts: number[] = [];
    notificationService.subscribeToUnreadCount('alice', (n) => counts.push(n));
    notificationService.subscribeToNotifications('alice', 30, () => {});
    await emit({ type: 'notification' });
    await emit({ type: 'notification' });
    expect(h.calls.filter((c) => c === '/read/notifications/unread-count')).toHaveLength(2);
    expect(counts.at(-1)).toBe(9);
  });

  it('one account’s count never reaches another account’s bell', async () => {
    const bob: number[] = [];
    notificationService.subscribeToUnreadCount('bob', (n) => bob.push(n));
    notificationService.subscribeToNotifications('alice', 30, () => {});
    await h.subs[1].callback(await h.subs[1].fetcher());
    expect(bob).toEqual([]);
  });

  it('a bell that mounts while the list is open still gets the shared count', async () => {
    notificationService.subscribeToNotifications('alice', 30, () => {});
    await h.subs[0].callback(await h.subs[0].fetcher()); // list publishes 4
    const counts: number[] = [];
    notificationService.subscribeToUnreadCount('alice', (n) => counts.push(n));
    const bell = h.subs[1];
    h.calls.length = 0;
    bell.callback(await bell.fetcher()); // its initial fetch
    expect(h.calls).toEqual([]); // served from the shared count…
    expect(counts).toEqual([4]); // …and delivered to the NEW bell
  });

  it('a list response that started before mark-all-seen cannot repaint the dot', async () => {
    const counts: number[] = [];
    notificationService.subscribeToUnreadCount('alice', (n) => counts.push(n));
    notificationService.subscribeToNotifications('alice', 30, () => {});
    const list = h.subs[1];
    await list.callback(await list.fetcher()); // learn header support
    counts.length = 0;
    const inFlight = list.fetcher(); // started before the mark (count still 4 server-side)
    await notificationService.markAllAsSeen();
    list.callback(await inFlight);
    expect(counts).toEqual([0]);
  });

  it('marking all seen clears the bell without another request', async () => {
    const counts: number[] = [];
    notificationService.subscribeToUnreadCount('alice', (n) => counts.push(n));
    h.calls.length = 0;
    await notificationService.markAllAsSeen();
    expect(counts.at(-1)).toBe(0);
    expect(h.calls).toEqual([]);
  });
});
