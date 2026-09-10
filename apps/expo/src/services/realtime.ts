import { AppState } from 'react-native';
import { auth } from './firebase/initFirebase';
import { API_BASE_URL, endRejectedSession } from './api';

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
  /**
   * Consecutive closes that happened BEFORE the socket ever opened.
   *
   * The only evidence available that the upgrade is being REFUSED rather than the network
   * being flaky. React Native's WebSocket surfaces a rejected handshake as a plain close
   * with no status code, so a revoked session is indistinguishable from a dropped tunnel
   * — and without counting these, an app with no API traffic reconnects forever while
   * showing a signed-in UI on a dead session.
   */
  preOpenFailures: number;
}

/**
 * How many failed handshakes in a row before concluding the session is gone.
 *
 * Three, spanning roughly 2s + 4s + 8s of backoff. High enough that a lift, a tunnel or a
 * cell handover does not sign anybody out; low enough that a revoked session resolves in
 * well under a minute instead of never.
 */
const PRE_OPEN_FAILURES_BEFORE_SIGNOUT = 3;

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

  let opened = false;

  ws.onopen = () => {
    opened = true;
    conn.attempts = 0;
    // The handshake succeeded, so whatever the previous failures were, they were not a
    // refusal.
    conn.preOpenFailures = 0;
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
    if (conn.closedByUs || conn.listeners.size === 0) return;

    /**
     * A close that never reached `onopen` means the HANDSHAKE failed, not the connection.
     * Repeatedly, with a token attached, that is the server refusing the session — a
     * revoked or blocked account answers the upgrade with 401.
     *
     * Handing it to the API layer's sign-out path rather than reconnecting is the
     * difference between the user being told what happened and an app that looks signed
     * in forever on a dead session. Counted rather than acted on immediately because a
     * single failed handshake is far more likely to be a lift than a revocation.
     */
    if (!opened) {
      conn.preOpenFailures += 1;
      if (conn.preOpenFailures >= PRE_OPEN_FAILURES_BEFORE_SIGNOUT && auth.currentUser) {
        conn.preOpenFailures = 0;
        void endRejectedSession();
        return;
      }
    }

    scheduleReconnect(channel, conn);
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
    conn = { ws: null, listeners: new Set(), heartbeat: null, reconnectTimer: null, attempts: 0, closedByUs: false, preOpenFailures: 0 };
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
  opts: {
    fallbackMs?: number;
    filter?: (e: RealtimeEvent) => boolean;
    /** Apply self-contained push payloads immediately without an extra GET. */
    onEvent?: (e: RealtimeEvent) => void;
    /** Return false when onEvent fully handled this event and no refetch is needed. */
    shouldRefresh?: (e: RealtimeEvent) => boolean;
    /**
     * Skip the initial fetch when the caller already has fresh data (e.g. a
     * feed card seeded from the list response). Events + the safety-net poll
     * still keep it updated. Defaults to true (fetch on subscribe).
     */
    immediate?: boolean;
  } = {},
): () => void {
  // The WebSocket pushes updates instantly, so this poll is only a safety net.
  const fallbackMs = opts.fallbackMs ?? 60000;
  let active = true;
  let inFlight = false;
  let refreshPending = false;

  const refresh = async () => {
    if (!active) return;
    if (inFlight) {
      // Coalesce bursts, but never drop the last event. Once the current fetch
      // finishes, one trailing refresh observes everything that happened during it.
      refreshPending = true;
      return;
    }
    // Skip the safety-net fetch while backgrounded (the socket reconnects and
    // refreshes on foreground anyway).
    if (AppState.currentState !== 'active') return;
    inFlight = true;
    try {
      const data = await fetcher();
      if (active) callback(data);
    } catch {
      /* transient */
    } finally {
      inFlight = false;
      if (active && refreshPending) {
        refreshPending = false;
        void refresh();
      }
    }
  };

  if (opts.immediate !== false) void refresh(); // initial load (skippable)
  const unsub = subscribeChannel(channel, (event) => {
    if (opts.filter && !opts.filter(event)) return;
    opts.onEvent?.(event);
    if (!opts.shouldRefresh || opts.shouldRefresh(event)) void refresh();
  });
  const safety = setInterval(refresh, fallbackMs);

  return () => {
    active = false;
    clearInterval(safety);
    unsub();
  };
}
