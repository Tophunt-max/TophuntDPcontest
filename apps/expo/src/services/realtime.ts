import { auth } from './firebase/initFirebase';
import { API_BASE_URL } from './api';

/**
 * Instant push over WebSockets, backed by the Worker's RealtimeHub Durable
 * Objects. Connections are multiplexed per channel and ref-counted, so many
 * subscribers to the same channel share one socket. Includes auto-reconnect
 * (exponential backoff) and a heartbeat.
 *
 * Channels:
 *   user:<uid>     notifications + chat-list bumps
 *   chat:<chatId>  new messages
 *   match:<id>     live vote/like/comment/reaction counts
 */
const WS_BASE = API_BASE_URL.replace(/^http/i, 'ws');

export type RealtimeEvent = { type: string; ts?: number; [k: string]: any };
type Listener = (event: RealtimeEvent) => void;

interface Conn {
  ws: WebSocket | null;
  listeners: Set<Listener>;
  heartbeat: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  attempts: number;
  closedByUs: boolean;
}

const conns = new Map<string, Conn>();

async function openSocket(channel: string, conn: Conn) {
  if (conn.closedByUs) return;
  let token: string | null = null;
  try {
    token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  } catch {
    token = null;
  }
  if (!token) {
    // Not signed in yet — retry shortly.
    conn.reconnectTimer = setTimeout(() => openSocket(channel, conn), 2000);
    return;
  }

  const url = `${WS_BASE}/ws?channel=${encodeURIComponent(channel)}&token=${encodeURIComponent(token)}`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect(channel, conn);
    return;
  }
  conn.ws = ws;

  ws.onopen = () => {
    conn.attempts = 0;
    conn.heartbeat = setInterval(() => {
      try {
        ws.send('ping');
      } catch {
        /* ignore */
      }
    }, 25000);
  };

  ws.onmessage = (ev: any) => {
    const raw = ev.data;
    if (raw === 'pong') return;
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (event.type === 'connected') return;
    conn.listeners.forEach((l) => {
      try {
        l(event);
      } catch {
        /* listener error ignored */
      }
    });
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  };

  ws.onclose = () => {
    if (conn.heartbeat) clearInterval(conn.heartbeat);
    conn.heartbeat = null;
    conn.ws = null;
    if (!conn.closedByUs && conn.listeners.size > 0) scheduleReconnect(channel, conn);
  };
}

function scheduleReconnect(channel: string, conn: Conn) {
  if (conn.closedByUs) return;
  conn.attempts += 1;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(conn.attempts, 5)); // 2s..30s
  conn.reconnectTimer = setTimeout(() => openSocket(channel, conn), delay);
}

/** Subscribe to raw events on a channel. Returns an unsubscribe function. */
export function subscribeChannel(channel: string, onEvent: Listener): () => void {
  let conn = conns.get(channel);
  if (!conn) {
    conn = { ws: null, listeners: new Set(), heartbeat: null, reconnectTimer: null, attempts: 0, closedByUs: false };
    conns.set(channel, conn);
    openSocket(channel, conn);
  }
  conn.listeners.add(onEvent);

  return () => {
    const c = conns.get(channel);
    if (!c) return;
    c.listeners.delete(onEvent);
    if (c.listeners.size === 0) {
      c.closedByUs = true;
      if (c.heartbeat) clearInterval(c.heartbeat);
      if (c.reconnectTimer) clearTimeout(c.reconnectTimer);
      try {
        c.ws?.close();
      } catch {
        /* ignore */
      }
      conns.delete(channel);
    }
  };
}

/**
 * Instant, self-healing data subscription. On connect and on every relevant
 * WebSocket event it (re)fetches from the server and invokes `callback`. A slow
 * background poll (default 30s) is kept purely as a safety net if a socket is
 * down or an event is missed. Drop-in replacement for `poll()`.
 *
 * `filter` lets a subscriber ignore events it doesn't care about.
 */
export function live<T>(
  channel: string,
  fetcher: () => Promise<T>,
  callback: (data: T) => void,
  opts: { fallbackMs?: number; filter?: (e: RealtimeEvent) => boolean } = {},
): () => void {
  const fallbackMs = opts.fallbackMs ?? 30000;
  let active = true;
  let inFlight = false;

  const refresh = async () => {
    if (!active || inFlight) return;
    inFlight = true;
    try {
      const data = await fetcher();
      if (active) callback(data);
    } catch {
      /* transient */
    } finally {
      inFlight = false;
    }
  };

  refresh(); // initial load
  const unsub = subscribeChannel(channel, (event) => {
    if (opts.filter && !opts.filter(event)) return;
    refresh();
  });
  const safety = setInterval(refresh, fallbackMs);

  return () => {
    active = false;
    clearInterval(safety);
    unsub();
  };
}
