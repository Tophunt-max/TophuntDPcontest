import { AppState } from 'react-native';
import { auth } from './firebase/initFirebase';
import { API_BASE_URL, callApi, probeSession } from './api';
import { onNetworkRecovered } from '@/src/lib/networkRecovery';

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
 *   app:cfg<N>     App Control pushes (maintenance, flags, banner) — public,
 *                  always opened WITHOUT a token, signed in or not
 */
const WS_BASE = API_BASE_URL.replace(/^http/i, 'ws');

export type RealtimeEvent = { type: string; ts?: number; [k: string]: any };
type Listener = (event: RealtimeEvent) => void;

interface Conn {
  ws: WebSocket | null;
  listeners: Set<Listener>;
  heartbeat: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Pending close after the last listener left (see SOCKET_LINGER_MS). */
  lingerTimer: ReturnType<typeof setTimeout> | null;
  /** Account whose token opened the current socket (null until opened). */
  authUid: string | null;
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
  /** True once any socket for this channel has opened; later opens are reconnects. */
  everOpened: boolean;
}

/**
 * Sent to a channel's listeners when its socket REconnects. Events published while
 * it was down are gone (the hub does not replay), so a subscriber must refetch.
 * `live()` always refreshes on it.
 */
export const RESYNC_EVENT = 'resync';

/**
 * How many failed handshakes in a row before concluding the session is gone.
 *
 * Three, spanning roughly 2s + 4s + 8s of backoff. High enough that a lift, a tunnel or a
 * cell handover does not sign anybody out; low enough that a revoked session resolves in
 * well under a minute instead of never.
 */
const PRE_OPEN_FAILURES_BEFORE_SIGNOUT = 3;

/**
 * How long an idle channel's socket stays open after its last listener leaves.
 *
 * Without this, the socket closed the instant a channel lost its last listener and
 * the next subscriber opened a brand-new one. Each open is a Worker request, a
 * token verify, an account-state read and a billed Durable Object request. Home
 * remounts every card when fresh data replaces the saved snapshot, and FlatList
 * unmounts and remounts cards during fast scrolling, so both closed and reopened
 * one `match:<id>` socket per card for nothing. A short linger lets the
 * remounted subscriber take over the socket that is already open. It is idle
 * meanwhile: heartbeats are answered by the runtime and never wake the DO.
 */
export const SOCKET_LINGER_MS = 5000;

const conns = new Map<string, Conn>();

/**
 * A short-lived socket ticket (Worker lib/wsTicket.ts), shared by every channel
 * of the same account while it is valid. The URL used to carry the ID token, and
 * request URLs end up in server logs. Null when the server has tickets off or the
 * call failed; the socket then falls back to `?token=`.
 */
let ticketCache: { uid: string; ticket: string; expiresAt: number } | null = null;
let ticketInFlight: Promise<string | null> | null = null;
async function socketTicket(uid: string): Promise<string | null> {
  if (ticketCache && ticketCache.uid === uid && ticketCache.expiresAt - Date.now() > 15_000) return ticketCache.ticket;
  if (!ticketInFlight) {
    ticketInFlight = (async () => {
      try {
        const res: any = await callApi('createWsTicket', {});
        if (typeof res?.ticket === 'string' && res.ticket) {
          ticketCache = { uid, ticket: res.ticket, expiresAt: Number(res.expiresAt) || Date.now() + 60_000 };
          return res.ticket as string;
        }
      } catch {
        /* fall back to the token */
      }
      return null;
    })().finally(() => {
      ticketInFlight = null;
    });
  }
  return ticketInFlight;
}

async function openSocket(channel: string, conn: Conn) {
  if (conn.closedByUs) return;
  // App Control is public: never send a token (no verify / account read per connect,
  // and a refused socket can never be mistaken for a revoked session).
  const anonymous = channel.startsWith('app:');
  let token: string | null = null;
  try {
    token = !anonymous && auth.currentUser ? await auth.currentUser.getIdToken() : null;
  } catch {
    token = null;
  }
  // A battle's public tallies are open to guests (worker lib/wsGuest.ts), so a
  // signed-out viewer connects without a token instead of retrying forever.
  const guestOk = !token && (channel.startsWith('match:') || anonymous);
  if (!token && !guestOk) {
    // Not signed in yet — retry shortly. Private channels (user:, chat:) only.
    conn.reconnectTimer = setTimeout(() => openSocket(channel, conn), 2000);
    return;
  }

  conn.authUid = token ? auth.currentUser?.uid ?? null : null;
  const ticket = token && conn.authUid ? await socketTicket(conn.authUid) : null;
  if (conn.closedByUs) return;
  const url = ticket
    ? `${WS_BASE}/ws?channel=${encodeURIComponent(channel)}&ticket=${encodeURIComponent(ticket)}`
    : token
      ? `${WS_BASE}/ws?channel=${encodeURIComponent(channel)}&token=${encodeURIComponent(token)}`
      : `${WS_BASE}/ws?channel=${encodeURIComponent(channel)}`;
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
    if (conn.everOpened) dispatch(conn, { type: RESYNC_EVENT });
    conn.everOpened = true;
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
    dispatch(conn, event);
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
    // Dropped while lingering with no listeners: nobody needs it, so retire the
    // channel now instead of reconnecting (a later subscriber opens a fresh one).
    if (!conn.closedByUs && conn.listeners.size === 0) retire(channel, conn);
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
      if (conn.preOpenFailures >= PRE_OPEN_FAILURES_BEFORE_SIGNOUT && auth.currentUser && token) {
        conn.preOpenFailures = 0;
        // Confirm over HTTP before acting: the same refusals come from a 403 (no
        // longer a chat member), a 503 or a dead network, none of which is a reason
        // to sign anybody out. A truly rejected session is signed out by the API.
        void probeSession();
      }
    }

    scheduleReconnect(channel, conn);
  };
}

function dispatch(conn: Conn, event: RealtimeEvent) {
  conn.listeners.forEach((l) => {
    try {
      l(event);
    } catch {
      /* listener error ignored */
    }
  });
}

/**
 * Network back: a socket waiting out its backoff (up to 30 s) reconnects now.
 * The reopen sends RESYNC to its `live()` subscribers, which refetch.
 * Exported for tests.
 */
export function reconnectWaitingSockets(): number {
  let n = 0;
  for (const [channel, conn] of conns) {
    if (conn.closedByUs || !conn.reconnectTimer) continue;
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    conn.attempts = 0;
    n += 1;
    void openSocket(channel, conn);
  }
  return n;
}
onNetworkRecovered(() => {
  reconnectWaitingSockets();
});

function scheduleReconnect(channel: string, conn: Conn) {
  if (conn.closedByUs) return;
  conn.attempts += 1;
  // Exponential backoff, capped at 30s.
  const base = Math.min(30000, 1000 * 2 ** Math.min(conn.attempts, 5)); // 2s..30s
  /**
   * FULL JITTER on top of the backoff. Without it, a single event that drops
   * every client's socket at once — most commonly a Worker redeploy, which the
   * repo does on every push to `main` — makes all of them reconnect in lockstep,
   * then again after the same 2s, 4s, 8s… backoff. That synchronised retry is a
   * self-inflicted thundering herd against the same RealtimeHub Durable Objects
   * the instant they come back. Spreading each client uniformly across [0, base]
   * turns the spike into a smooth ramp; the expected wait is only halved, so a
   * genuinely-down backend is not hammered any harder.
   */
  const delay = Math.floor(Math.random() * base);
  conn.reconnectTimer = setTimeout(() => openSocket(channel, conn), delay);
}

/** Close a channel's socket for good and forget it. */
function retire(channel: string, c: Conn) {
  c.closedByUs = true;
  if (c.heartbeat) clearInterval(c.heartbeat);
  if (c.reconnectTimer) clearTimeout(c.reconnectTimer);
  if (c.lingerTimer) clearTimeout(c.lingerTimer);
  c.heartbeat = null;
  c.reconnectTimer = null;
  c.lingerTimer = null;
  try {
    c.ws?.close();
  } catch {
    /* ignore */
  }
  if (conns.get(channel) === c) conns.delete(channel);
}

/** Subscribe to raw events on a channel. Returns an unsubscribe function. */
export function subscribeChannel(channel: string, onEvent: Listener): () => void {
  let conn = conns.get(channel);
  if (conn?.lingerTimer) {
    if (conn.authUid !== (auth.currentUser?.uid ?? null)) {
      // The idle socket was authenticated as a DIFFERENT account (sign-out or
      // account switch inside the linger window). Never hand it to the new viewer:
      // a chat channel would deliver messages on the old account's authorization.
      retire(channel, conn);
      conn = undefined;
    } else {
      // Re-subscribed within the linger window: keep the socket that is already open.
      clearTimeout(conn.lingerTimer);
      conn.lingerTimer = null;
    }
  }
  if (!conn) {
    conn = {
      ws: null, listeners: new Set(), heartbeat: null, reconnectTimer: null, lingerTimer: null,
      authUid: null, attempts: 0, closedByUs: false, preOpenFailures: 0, everOpened: false,
    };
    conns.set(channel, conn);
    openSocket(channel, conn);
  }
  conn.listeners.add(onEvent);

  let subscribed = true;
  return () => {
    if (!subscribed) return; // idempotent: a double unsubscribe must not close a shared socket
    subscribed = false;
    const c = conns.get(channel);
    if (!c) return;
    c.listeners.delete(onEvent);
    if (c.listeners.size === 0 && !c.lingerTimer) {
      c.lingerTimer = setTimeout(() => {
        c.lingerTimer = null;
        if (c.listeners.size === 0) retire(channel, c);
      }, SOCKET_LINGER_MS);
    }
  };
}

/** Test hook: drop every channel immediately. */
export function __resetRealtimeForTests(): void {
  ticketCache = null;
  for (const [channel, c] of [...conns]) retire(channel, c);
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
    /**
     * Called when a refresh could not produce data.
     *
     * Without this, `callback` firing only on SUCCESS made a screen whose loading
     * flag was cleared inside `callback` unable to ever leave its skeleton: a 500,
     * a timeout or an offline blip was swallowed by the catch below and looked
     * identical to "still loading". `reason` distinguishes a real failure from a
     * fetch that was deliberately skipped because the app is backgrounded, since a
     * subscriber should show a retry for the first and simply keep waiting for the
     * second.
     */
    onError?: (reason: 'fetch_failed' | 'backgrounded', error?: unknown) => void;
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
    // Skip the safety-net fetch while backgrounded; the AppState listener below
    // refreshes on return to the foreground.
    //
    // This also skips the INITIAL fetch, which is why it is reported: on iOS a
    // cold start from a push-notification tap can run this while AppState is
    // still 'inactive', so a subscriber that only learns about success would
    // wait forever for data that was never requested.
    if (AppState.currentState !== 'active') {
      if (active) opts.onError?.('backgrounded');
      return;
    }
    inFlight = true;
    try {
      const data = await fetcher();
      if (active) callback(data);
    } catch (e) {
      // Still transient — the socket and the safety-net poll will retry — but no
      // longer silent, so a subscriber can offer a retry instead of hanging.
      if (active) opts.onError?.('fetch_failed', e);
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
    // A reconnect means events were missed while the socket was down: refetch,
    // whatever this subscriber's filter is.
    if (event.type === RESYNC_EVENT) return void refresh();
    if (opts.filter && !opts.filter(event)) return;
    opts.onEvent?.(event);
    if (!opts.shouldRefresh || opts.shouldRefresh(event)) void refresh();
  });
  const safety = setInterval(refresh, fallbackMs);
  // Network back: refetch now. The socket may still be reconnecting, and the
  // safety poll above can be a minute away (three for notifications).
  const offRecovered = onNetworkRecovered(() => void refresh());
  // Back in the foreground: refetch now. Fetches are skipped while backgrounded,
  // and nothing used to trigger one on return, so a screen stayed stale until the
  // next event or safety poll (up to 60 s, 180 s for notifications).
  let lastState = AppState.currentState;
  const appSub = AppState.addEventListener?.('change', (next) => {
    if (next === 'active' && lastState !== 'active') void refresh();
    lastState = next;
  });

  return () => {
    active = false;
    clearInterval(safety);
    offRecovered();
    appSub?.remove?.();
    unsub();
  };
}
