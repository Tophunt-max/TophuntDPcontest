/**
 * Channel sockets linger briefly after their last listener leaves, so a remount
 * (Home swapping cached cards for fresh ones, FlatList recycling) reuses the open
 * socket instead of paying a new Worker + Durable Object handshake. A lingering
 * socket is never handed to a DIFFERENT account.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ uid: 'alice' as string | null, sockets: [] as any[] }));

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('../src/services/api', () => ({ API_BASE_URL: 'https://api.example', probeSession: async () => {} }));
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

import { subscribeChannel, SOCKET_LINGER_MS, __resetRealtimeForTests } from '@/src/services/realtime';

/** Let openSocket's token await settle. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as any).WebSocket = FakeWebSocket;
  h.sockets.length = 0;
  h.uid = 'alice';
});
afterEach(() => {
  __resetRealtimeForTests();
  vi.useRealTimers();
});

describe('realtime socket linger', () => {
  it('a remount inside the linger window reuses the open socket', async () => {
    const off1 = subscribeChannel('match:m1', () => {});
    await flush();
    expect(h.sockets).toHaveLength(1);
    off1(); // cached card unmounts…
    const off2 = subscribeChannel('match:m1', () => {}); // …fresh card mounts
    await flush();
    vi.advanceTimersByTime(SOCKET_LINGER_MS * 2);
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].closed).toBe(false);
    off2();
  });

  it('closes the socket once the linger window passes with no listener', async () => {
    const off = subscribeChannel('match:m1', () => {});
    await flush();
    off();
    vi.advanceTimersByTime(SOCKET_LINGER_MS - 1);
    expect(h.sockets[0].closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(h.sockets[0].closed).toBe(true);
  });

  it('never hands a lingering socket to a different account', async () => {
    const off = subscribeChannel('chat:c1', () => {});
    await flush();
    off();
    h.uid = 'bob'; // account switch inside the linger window
    const offB = subscribeChannel('chat:c1', () => {});
    await flush();
    expect(h.sockets[0].closed).toBe(true); // alice's socket retired
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1].url).toContain('token-bob');
    offB();
  });

  it('a double unsubscribe does not close a socket another listener still uses', async () => {
    const offA = subscribeChannel('match:m1', () => {});
    const offB = subscribeChannel('match:m1', () => {});
    await flush();
    offA();
    offA();
    vi.advanceTimersByTime(SOCKET_LINGER_MS * 2);
    expect(h.sockets[0].closed).toBe(false);
    offB();
  });

  it('a guest opens a public match socket without a token', async () => {
    h.uid = null;
    const off = subscribeChannel('match:m1', () => {});
    await flush();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].url).not.toContain('token=');
    off();
  });

  it('a guest never opens a private channel (user:/chat:) without a token', async () => {
    h.uid = null;
    const off = subscribeChannel('chat:c1', () => {});
    await flush();
    vi.advanceTimersByTime(4100);
    await flush();
    expect(h.sockets).toHaveLength(0);
    off();
  });

  it('a socket that drops while idle is retired, not reconnected', async () => {
    const off = subscribeChannel('match:m1', () => {});
    await flush();
    h.sockets[0].onopen?.();
    off();
    h.sockets[0].close(); // network drop during the linger window
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(h.sockets).toHaveLength(1);
  });
});
