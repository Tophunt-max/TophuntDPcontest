/**
 * RealtimeHub — a Durable Object that powers instant push over WebSockets.
 *
 * One DO instance per "channel" (addressed via idFromName(channel)):
 *   user:<uid>     — a user's notifications + chat-list bumps
 *   chat:<chatId>  — new messages in a conversation
 *   match:<id>     — live vote / like / comment / reaction counts
 *
 * Uses the WebSocket Hibernation API so idle connections don't keep the DO
 * billed/resident: sockets are accepted with state.acceptWebSocket(), and the
 * runtime wakes the DO only when a message/close/publish arrives.
 *
 * Heartbeats are handled by the RUNTIME, not by this class, via
 * state.setWebSocketAutoResponse(). This is the single most important cost lever
 * for a WebSocket DO on the free plan:
 *
 *   - A billed "request" includes every incoming WebSocket message, and the
 *     client sends a "ping" every ~25s to keep the socket warm. Handling that in
 *     webSocketMessage() would WAKE the hibernated DO on every ping, on every
 *     connection — e.g. 2,000 idle-but-connected clients = ~6.9M wake-ups/day,
 *     ~69x the 100,000/day free request limit, for zero application work.
 *   - Auto-response answers "ping" -> "pong" inside the runtime WITHOUT waking
 *     the DO, so idle connections stay genuinely hibernated: no wake, and no
 *     wall-clock duration charge for the heartbeat
 *     (https://developers.cloudflare.com/durable-objects/platform/pricing/).
 *
 * The client keeps sending the same "ping" and receiving the same "pong", so
 * this is transparent to it — see apps/expo/src/services/realtime.ts.
 *
 * The Worker verifies the Firebase ID token + channel authorization BEFORE
 * forwarding the upgrade here, so this class trusts its caller.
 */
import type { Env } from "./types";

// Heartbeat handled entirely by the runtime (see class header). Constructed once
// per isolate and re-installed on every constructor run so it survives eviction.
const HEARTBEAT_REQUEST = "ping";
const HEARTBEAT_RESPONSE = "pong";

export class RealtimeHub {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    // Answer client heartbeats in the runtime without waking this DO. Must be set
    // in the constructor: it is per-DO configuration that has to be re-applied
    // every time the object is (re)constructed after hibernation/eviction.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal revocation: close every hibernating socket authenticated as uid.
    if (url.pathname === "/revoke") {
      const payload = await request.json<{ uid?: string }>()
        .catch(() => ({} as { uid?: string }));
      if (!payload.uid) return new Response("uid required", { status: 400 });
      for (const ws of this.state.getWebSockets(`uid:${payload.uid}`)) {
        try {
          ws.close(4003, "Account blocked");
        } catch {
          /* socket already closing */
        }
      }
      return new Response("ok");
    }

    // Internal fan-out: broadcast a JSON payload to every connected socket.
    if (url.pathname === "/publish") {
      const body = await request.text();
      for (const ws of this.state.getWebSockets()) {
        try {
          ws.send(body);
        } catch {
          /* socket going away; ignore */
        }
      }
      return new Response("ok");
    }

    // WebSocket upgrade (hibernatable).
    if (request.headers.get("Upgrade") === "websocket") {
      const uid = request.headers.get("X-Authenticated-Uid");
      if (!uid) return new Response("missing verified identity", { status: 401 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, [`uid:${uid}`]);
      // Greet so the client knows the socket is live.
      try {
        server.send(JSON.stringify({ type: "connected", ts: Date.now() }));
      } catch {
        /* ignore */
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("expected websocket", { status: 400 });
  }

  // --- Hibernation handlers ---
  webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer) {
    // The hub is PUSH-ONLY. Clients have exactly one thing to say — the "ping"
    // heartbeat — and that is now answered by the runtime via
    // setWebSocketAutoResponse(), so it never reaches this handler and never
    // wakes the DO.
    //
    // Anything that DOES land here is therefore unexpected: a stray frame, a
    // client bug, or an authenticated client trying to drive traffic through the
    // socket. Since there is no message this hub accepts, we neither parse nor
    // reply — a reply is what would turn junk into a request/response loop. We
    // simply drop it. A client that insists on flooding is closed rather than
    // left to spend the DO's request budget.
    try {
      const attachment = (ws.deserializeAttachment?.() ?? {}) as { bad?: number };
      const bad = (attachment.bad ?? 0) + 1;
      if (bad >= 20) {
        ws.close(1003, "unexpected data");
        return;
      }
      ws.serializeAttachment?.({ ...attachment, bad });
    } catch {
      /* attachment API unavailable or socket closing; ignore */
    }
  }

  webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean) {
    try {
      ws.close(code === 1006 ? 1000 : code);
    } catch {
      /* ignore */
    }
  }

  webSocketError(_ws: WebSocket, _error: unknown) {
    /* connection dropped; hibernation cleans it up */
  }
}
