/**
 * The shared request core in src/services/api.ts: caller cancellation, sharing
 * identical in-flight GETs, and not retrying once the device is known offline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  user: { uid: 'alice', getIdToken: async () => 'tok' } as any,
  online: true,
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: { fetch: async () => ({ isConnected: h.online, isInternetReachable: h.online }) },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: { currentState: 'active' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('firebase/auth', () => ({ signOut: vi.fn(async () => undefined) }));
vi.mock('@/src/services/firebase/initFirebase', () => ({
  auth: {
    get currentUser() {
      return h.user;
    },
  },
}));
vi.mock('@/src/lib/toastBridge', () => ({ emitToast: vi.fn() }));
vi.mock('@/src/lib/profileCompletion', () => ({ markOnboardingIncomplete: vi.fn(), PROFILE_INCOMPLETE_CODE: 'PROFILE_INCOMPLETE' }));

(globalThis as any).__DEV__ = false;
const api = await import('@/src/services/api');

/** A fetch whose responses the test releases by hand. */
function controllableFetch() {
  const calls: Array<{ url: string; signal: AbortSignal; resolve: (body: any) => void; reject: (e: any) => void }> = [];
  const fn = vi.fn((url: string, init: any) => {
    return new Promise((resolve, reject) => {
      const entry = {
        url,
        signal: init.signal as AbortSignal,
        resolve: (body: any) =>
          resolve({ ok: true, status: 200, headers: new Headers({ 'X-Next-Cursor': 'c2' }), json: async () => body }),
        reject,
      };
      init.signal?.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = (init.signal as any).reason?.name || 'AbortError';
        reject(e);
      });
      calls.push(entry);
    });
  });
  return { fn, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.user = { uid: 'alice', getIdToken: async () => 'tok' };
  h.online = true;
});

describe('identical GETs in flight share one request', () => {
  it('two callers, one fetch, independent copies of the answer', async () => {
    const f = controllableFetch();
    vi.stubGlobal('fetch', f.fn);
    const a = api.readApi('/read/matches', { limit: 8 });
    const b = api.readApi('/read/matches', { limit: 8 });
    await tick();
    await tick();
    expect(f.fn).toHaveBeenCalledTimes(1);
    f.calls[0].resolve({ items: [{ id: 'm1' }] });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    rb.items.push({ id: 'mutated' });
    expect(ra.items).toHaveLength(1); // one caller's mutation does not leak into the other's
    expect(api.__inFlightCountForTests()).toBe(0);
  });

  it('different accounts never share an answer', async () => {
    const f = controllableFetch();
    vi.stubGlobal('fetch', f.fn);
    const a = api.readApi('/read/me');
    await tick();
    h.user = { uid: 'bob', getIdToken: async () => 'tok2' };
    const b = api.readApi('/read/me');
    await tick();
    await tick();
    expect(f.fn).toHaveBeenCalledTimes(2);
    f.calls.forEach((c, i) => c.resolve({ who: i }));
    await Promise.all([a, b]);
  });

  it('one caller cancelling does not cancel the other', async () => {
    const f = controllableFetch();
    vi.stubGlobal('fetch', f.fn);
    const ac = new AbortController();
    const a = api.readApi('/read/search', { q: 'ab' }, { signal: ac.signal });
    const b = api.readApi('/read/search', { q: 'ab' });
    await tick();
    await tick();
    ac.abort();
    await expect(a).rejects.toSatisfy(api.isCancelledError);
    expect(f.calls[0].signal.aborted).toBe(false);
    f.calls[0].resolve({ people: [] });
    await expect(b).resolves.toEqual({ people: [] });
  });

  it('when every caller cancels, the network request is aborted and not retried', async () => {
    const f = controllableFetch();
    vi.stubGlobal('fetch', f.fn);
    const ac = new AbortController();
    const a = api.readApi('/read/search', { q: 'abc' }, { signal: ac.signal });
    await tick();
    await tick();
    ac.abort();
    await expect(a).rejects.toSatisfy(api.isCancelledError);
    expect(f.calls[0].signal.aborted).toBe(true);
    await tick();
    await tick();
    expect(f.fn).toHaveBeenCalledTimes(1);
    expect(api.__inFlightCountForTests()).toBe(0);
  });

  it('an already-aborted signal never touches the network', async () => {
    const f = controllableFetch();
    vi.stubGlobal('fetch', f.fn);
    const ac = new AbortController();
    ac.abort();
    await expect(api.readApi('/read/x', {}, { signal: ac.signal })).rejects.toSatisfy(api.isCancelledError);
    expect(f.fn).not.toHaveBeenCalled();
  });

  it('readApiWithCursor still returns the cursor header', async () => {
    const f = controllableFetch();
    vi.stubGlobal('fetch', f.fn);
    const p = api.readApiWithCursor('/read/matches', { sort: 'recent' });
    await tick();
    await tick();
    f.calls[0].resolve([{ id: 'm1' }]);
    await expect(p).resolves.toEqual({ data: [{ id: 'm1' }], nextCursor: 'c2' });
  });
});

describe('retries', () => {
  it('a network failure while known offline is not retried', async () => {
    h.online = false;
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });
    vi.stubGlobal('fetch', fetchFn);
    await expect(api.readApi('/read/matches')).rejects.toMatchObject({ code: 'functions/unavailable', status: undefined });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a network failure while online is still retried (READ_RETRIES)', async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      if (n++ < 2) throw new TypeError('Network request failed');
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ ok: 1 }) };
    });
    vi.stubGlobal('fetch', fetchFn);
    await expect(api.readApi('/read/flaky')).resolves.toEqual({ ok: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('a 4xx is not retried', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({ error: { status: 'NOT_FOUND', message: 'nope' } }),
    }));
    vi.stubGlobal('fetch', fetchFn);
    await expect(api.readApi('/read/missing')).rejects.toMatchObject({ status: 404 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
