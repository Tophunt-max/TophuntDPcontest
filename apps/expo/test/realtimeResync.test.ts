/**
 * Recovery after a socket drop, a return to the foreground, and refused upgrades.
 *
 * - A REconnect tells listeners to resync; `live()` refetches on it whatever its
 *   filter, because events published while the socket was down are not replayed.
 * - Returning to the foreground refetches at once.
 * - Three refused upgrades no longer sign the user out by themselves: they trigger
 *   one authenticated probe, and only the API's own 401 handling signs out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  uid: 'alice' as string | null,
  sockets: [] as any[],
  appListeners: [] as ((s: string) => void)[],
  appState: 'active',
  probes: 0,
  ticket: null as string | null,
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return h.appState;
    },
    addEventListener: (_: string, fn: (s: string) => void) => {
      h.appListeners.push(fn);
      return { remove: () => (h.appListeners = h.appListeners.filter((f) => f !== fn)) };
    },
  },
}));
vi.mock('../src/services/api', () => ({
  API_BASE_URL: 'https://api.example',
  probeSession: async () => {
    h.probes++;
  },
  callApi: async () => (h.ticket ? { ticket: h.ticket, expiresAt: Date.now() + 120_000 } : { ticket: null }),
}));
vi.mock('../src/services/firebase/initFirebase', () => ({
  auth: {
    get currentUser() {
      return h.uid ? { uid: h.uid, getIdToken: async () => `token-${h.uid}` } : null;
    },
  },
}));

class FakeWebSocket {
  url: string;
  closed = false;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (e: any) => void;
  onerror?: () => void;
  constructor(url: string) {
    this.url = url;
    h.sockets.push(this);
  }
  send() {}
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

import { live, subscribeChannel, RESYNC_EVENT, __resetRealtimeForTests } from '@/src/services/realtime';

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const last = () => h.sockets[h.sockets.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0); // reconnect immediately
  (globalThis as any).WebSocket = FakeWebSocket;
  h.sockets.length = 0;
  h.appListeners.length = 0;
  h.appState = 'active';
  h.uid = 'alice';
  h.probes = 0;
  h.ticket = null;
});
afterEach(() => {
  __resetRealtimeForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reconnect resync', () => {
  it('sends resync on a reconnect, not on the first open', async () => {
    const events: string[] = [];
    const off = subscribeChannel('chat:c1', (e) => events.push(e.type));
    await flush();
    last().onopen?.();
    expect(events).toEqual([]);

    last().close(); // network drop
    vi.advanceTimersByTime(1);
    await flush();
    expect(h.sockets).toHaveLength(2);
    last().onopen?.();
    expect(events).toEqual([RESYNC_EVENT]);
    off();
  });

  it('live() refetches on resync even when its filter would drop the event', async () => {
    const fetcher = vi.fn(async () => 'data');
    const off = live('chat:c1', fetcher, () => {}, { filter: (e) => e.type === 'message', fallbackMs: 10_000_000 });
    await flush();
    last().onopen?.();
    expect(fetcher).toHaveBeenCalledTimes(1); // initial load

    last().close();
    vi.advanceTimersByTime(1);
    await flush();
    last().onopen?.();
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    off();
  });
});

describe('network back online', () => {
  it('live() refetches at once, and a socket waiting out its backoff reconnects now', async () => {
    const { reportConnectivity, __resetNetworkRecoveryForTests } = await import('@/src/lib/networkRecovery');
    __resetNetworkRecoveryForTests();
    // reportConnectivity is module-level: re-register realtime's own listener.
    const { reconnectWaitingSockets } = await import('@/src/services/realtime');
    const { onNetworkRecovered } = await import('@/src/lib/networkRecovery');
    onNetworkRecovered(() => void reconnectWaitingSockets());

    vi.spyOn(Math, 'random').mockReturnValue(0.99); // a long backoff
    const fetcher = vi.fn(async () => 'data');
    const off = live('user:alice', fetcher, () => {}, { fallbackMs: 10_000_000 });
    await flush();
    last().onopen?.();
    expect(fetcher).toHaveBeenCalledTimes(1);

    reportConnectivity(false);
    last().close(); // dropped while offline: now waiting ~2-30 s
    await flush();
    const before = h.sockets.length;

    reportConnectivity(true);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2); // refetched without waiting
    expect(h.sockets.length).toBe(before + 1); // reopened without waiting
    off();
  });

  it('fires only on an offline -> online flip', async () => {
    const { reportConnectivity, onNetworkRecovered, __resetNetworkRecoveryForTests } = await import('@/src/lib/networkRecovery');
    __resetNetworkRecoveryForTests();
    const hits = vi.fn();
    onNetworkRecovered(hits);
    reportConnectivity(true);
    reportConnectivity(true);
    expect(hits).not.toHaveBeenCalled();
    reportConnectivity(false);
    reportConnectivity(true);
    expect(hits).toHaveBeenCalledTimes(1);
  });
});

describe('foreground', () => {
  it('live() refetches when the app returns to the foreground, and stops listening on cleanup', async () => {
    const fetcher = vi.fn(async () => 'data');
    const off = live('user:alice', fetcher, () => {}, { fallbackMs: 10_000_000 });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    h.appState = 'background';
    h.appListeners.forEach((f) => f('background'));
    h.appState = 'active';
    h.appListeners.forEach((f) => f('active'));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);

    off();
    expect(h.appListeners).toHaveLength(0);
  });
});

describe('refused upgrades', () => {
  it('three refusals probe the session instead of signing out', async () => {
    const off = subscribeChannel('chat:c1', () => {});
    await flush();
    for (let i = 0; i < 3; i++) {
      last().close(); // closed before onopen: a refused handshake
      vi.advanceTimersByTime(1);
      await flush();
    }
    expect(h.probes).toBe(1);
    // And it keeps trying to reconnect rather than giving up.
    expect(h.sockets.length).toBeGreaterThanOrEqual(4);
    off();
  });
});

describe('socket tickets', () => {
  it('opens with ?ticket= when the server issues one, never with the ID token', async () => {
    h.ticket = 'tkt-123';
    const off = subscribeChannel('user:alice', () => {});
    await flush();
    expect(last().url).toContain('ticket=tkt-123');
    expect(last().url).not.toContain('token=');
    off();
  });

  it('falls back to the token when tickets are off', async () => {
    const off = subscribeChannel('user:alice', () => {});
    await flush();
    expect(last().url).toContain('token=token-alice');
    off();
  });
});
