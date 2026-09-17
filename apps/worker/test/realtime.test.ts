/**
 * REALTIME HUB — the WebSocket push Durable Object.
 *
 * ---------------------------------------------------------------------------
 * Why this can be tested in plain Node at all
 * ---------------------------------------------------------------------------
 * The rest of the DO suite policy (test/README.md) is that a Durable Object
 * class needs the workerd runtime. RealtimeHub is the exception: its only import
 * is `import type { Env }`, which is erased at compile time, so nothing pulls in
 * `cloudflare:workers`. Everything else it touches — `WebSocketPair`,
 * `WebSocketRequestResponsePair`, `Response` — are runtime globals we can stub,
 * and the DO state is a small enough surface to fake precisely.
 *
 * These tests pin the behaviours that are the difference between "works in a demo"
 * and "survives the free tier in production":
 *
 *   1. Heartbeats are answered by the RUNTIME (setWebSocketAutoResponse), not by
 *      waking the DO. This is THE cost lever — a ping per connection every ~25s,
 *      handled in JS, would blow past the 100k/day free request budget by ~69x at
 *      2k idle connections. If a refactor drops the auto-response, the bill (or the
 *      free-tier cutoff) is how you'd find out; this test is cheaper.
 *   2. Fan-out reaches every connected socket, and revocation reaches ONLY the
 *      sockets tagged with the revoked uid — the private-channel guarantee behind
 *      "log out of all devices" / an admin block.
 *   3. The hub is push-only: an authenticated client cannot drive request traffic
 *      through the socket, and a flooder is closed rather than left to spend budget.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// --- Stubs for the workerd-only globals the DO uses at runtime -------------

class FakeWebSocket {
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private attachment: unknown = undefined;

  send(data: string) {
    if (this.closed) throw new Error('cannot send on a closed socket');
    this.sent.push(data);
  }
  close(code = 1000, reason = '') {
    // Mirror the runtime: closing an already-closed socket is a no-op, not a throw.
    if (!this.closed) this.closed = { code, reason };
  }
  serializeAttachment(value: unknown) {
    this.attachment = value;
  }
  deserializeAttachment() {
    return this.attachment;
  }
  /** Convenience for assertions on the greeting / published frames. */
  parsed(): any[] {
    return this.sent.map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return s;
      }
    });
  }
}

/** Records every accepted socket and its hibernation tags. */
function makeState() {
  const sockets: Array<{ ws: FakeWebSocket; tags: string[] }> = [];
  let autoResponse: { request: string; response: string } | null = null;
  return {
    _sockets: sockets,
    setWebSocketAutoResponse(pair: { request: string; response: string }) {
      autoResponse = pair;
    },
    getWebSocketAutoResponse() {
      return autoResponse;
    },
    acceptWebSocket(ws: FakeWebSocket, tags: string[] = []) {
      sockets.push({ ws, tags });
    },
    getWebSockets(tag?: string) {
      return sockets
        .filter((s) => tag === undefined || s.tags.includes(tag))
        .map((s) => s.ws);
    },
  };
}

/** A minimal Request stand-in: only the surface the DO reads. */
function makeRequest(
  url: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
) {
  const entries = Object.entries(opts.headers ?? {}).map(
    ([k, v]) => [k.toLowerCase(), v] as const,
  );
  const headers = new Map<string, string>(entries);
  return {
    url,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    async json<T>() {
      return JSON.parse(opts.body ?? '{}') as T;
    },
    async text() {
      return opts.body ?? '';
    },
  } as any;
}

let RealtimeHub: typeof import('../src/realtime').RealtimeHub;
const savedGlobals: Record<string, unknown> = {};

beforeAll(async () => {
  // Node's Response constructor rejects a 101 status (the upgrade response the
  // DO returns), so we swap in a fake that just records what the DO built.
  savedGlobals.Response = (globalThis as any).Response;
  savedGlobals.WebSocketPair = (globalThis as any).WebSocketPair;
  savedGlobals.WebSocketRequestResponsePair = (globalThis as any).WebSocketRequestResponsePair;

  (globalThis as any).Response = class FakeResponse {
    status: number;
    body: unknown;
    webSocket: unknown;
    constructor(body: unknown, init: { status?: number; webSocket?: unknown } = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.webSocket = init.webSocket;
    }
  };
  (globalThis as any).WebSocketPair = class {
    0: FakeWebSocket;
    1: FakeWebSocket;
    constructor() {
      this[0] = new FakeWebSocket(); // client
      this[1] = new FakeWebSocket(); // server (the one accept()'d)
    }
  };
  (globalThis as any).WebSocketRequestResponsePair = class {
    constructor(public request: string, public response: string) {}
  };

  ({ RealtimeHub } = await import('../src/realtime'));
});

afterAll(() => {
  (globalThis as any).Response = savedGlobals.Response;
  (globalThis as any).WebSocketPair = savedGlobals.WebSocketPair;
  (globalThis as any).WebSocketRequestResponsePair = savedGlobals.WebSocketRequestResponsePair;
});

function newHub() {
  const state = makeState();
  const hub = new RealtimeHub(state as any, {} as any);
  return { hub, state };
}

/**
 * Drive an authenticated upgrade and return the accepted SERVER socket — the one
 * the DO holds and pushes to. `res.webSocket` is the CLIENT half of the pair
 * (handed back over the 101), which in production is the app's end of the wire
 * and never receives anything server-side in this fake.
 */
async function connect(
  hub: any,
  state: ReturnType<typeof makeState>,
  uid: string,
): Promise<FakeWebSocket> {
  const res = await hub.fetch(
    makeRequest('https://do.internal/ws', {
      headers: { Upgrade: 'websocket', 'X-Authenticated-Uid': uid },
    }),
  );
  expect(res.status).toBe(101);
  return state._sockets[state._sockets.length - 1].ws;
}

// ---------------------------------------------------------------------------

describe('heartbeats are answered by the runtime, not by waking the DO', () => {
  it('registers a ping/pong auto-response in the constructor', () => {
    const { state } = newHub();
    // The single most important free-tier property: the client heartbeat is
    // satisfied without an incoming-message wake, so idle connections cost nothing.
    expect(state.getWebSocketAutoResponse()).toEqual({ request: 'ping', response: 'pong' });
  });

  it('never handles "ping" in webSocketMessage (it should not reach the DO)', () => {
    const { hub } = newHub();
    const ws = new FakeWebSocket();
    // Even if a ping somehow reached the handler, the hub must not treat it as a
    // meaningful message — there is no reply here, only in the runtime.
    hub.webSocketMessage(ws, 'ping');
    expect(ws.sent).toHaveLength(0);
  });
});

describe('the upgrade path', () => {
  it('refuses an upgrade with no verified identity', async () => {
    const { hub } = newHub();
    const res = await hub.fetch(
      makeRequest('https://do.internal/ws', { headers: { Upgrade: 'websocket' } }),
    );
    expect(res.status).toBe(401);
  });

  it('accepts an authenticated upgrade, tags it with the uid, and greets', async () => {
    const { hub, state } = newHub();
    const server = await connect(hub, state, 'alice');

    expect(state._sockets).toHaveLength(1);
    expect(state._sockets[0].tags).toEqual(['uid:alice']);
    // The greeting lets the client confirm the socket is live.
    expect(server.parsed()[0]).toMatchObject({ type: 'connected' });
  });

  it('rejects a non-websocket request', async () => {
    const { hub } = newHub();
    const res = await hub.fetch(makeRequest('https://do.internal/ws'));
    expect(res.status).toBe(400);
  });
});

describe('publish fans out to every connected socket', () => {
  it('sends the raw body verbatim to all sockets', async () => {
    const { hub, state } = newHub();
    const a = await connect(hub, state, 'alice');
    const b = await connect(hub, state, 'bob');

    const frame = JSON.stringify({ type: 'message', text: 'hi' });
    const res = await hub.fetch(
      makeRequest('https://do.internal/publish', { body: frame }),
    );
    expect(res.status).toBe(200);

    // Each socket got exactly the greeting, then the published frame.
    expect(a.sent[a.sent.length - 1]).toBe(frame);
    expect(b.sent[b.sent.length - 1]).toBe(frame);
  });

  it('a send that throws on one socket does not stop the fan-out', async () => {
    const { hub, state } = newHub();
    const a = await connect(hub, state, 'alice');
    const b = await connect(hub, state, 'bob');
    a.close(); // a.send() will now throw

    const res = await hub.fetch(
      makeRequest('https://do.internal/publish', { body: 'x' }),
    );
    expect(res.status).toBe(200);
    // b still received it despite a being dead.
    expect(b.sent[b.sent.length - 1]).toBe('x');
  });
});

describe('revoke closes only the targeted uid`s sockets', () => {
  it('closes alice with 4003 and leaves bob connected', async () => {
    const { hub, state } = newHub();
    const alice = await connect(hub, state, 'alice');
    const bob = await connect(hub, state, 'bob');

    const res = await hub.fetch(
      makeRequest('https://do.internal/revoke', { body: JSON.stringify({ uid: 'alice' }) }),
    );
    expect(res.status).toBe(200);

    expect(alice.closed).toEqual({ code: 4003, reason: 'Account blocked' });
    expect(bob.closed).toBeNull();
  });

  it('requires a uid', async () => {
    const { hub } = newHub();
    const res = await hub.fetch(
      makeRequest('https://do.internal/revoke', { body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });
});

describe('the hub is push-only', () => {
  it('drops an unexpected message without replying', () => {
    const { hub } = newHub();
    const ws = new FakeWebSocket();
    hub.webSocketMessage(ws, 'garbage');
    // No reply — a reply is what would turn junk into a billable request/response loop.
    expect(ws.sent).toHaveLength(0);
    expect(ws.closed).toBeNull();
  });

  it('closes a socket that floods unexpected messages', () => {
    const { hub } = newHub();
    const ws = new FakeWebSocket();
    for (let i = 0; i < 20; i++) hub.webSocketMessage(ws, 'garbage');
    expect(ws.closed).toEqual({ code: 1003, reason: 'unexpected data' });
  });
});
