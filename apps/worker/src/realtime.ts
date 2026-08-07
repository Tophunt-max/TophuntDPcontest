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
 * The Worker verifies the Firebase ID token + channel authorization BEFORE
 * forwarding the upgrade here, so this class trusts its caller.
 */
import type { Env } from "./types";

export class RealtimeHub {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

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
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
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
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Heartbeat: client sends "ping", we reply "pong" to keep the socket warm.
    if (message === "ping") {
      try {
        ws.send("pong");
      } catch {
        /* ignore */
      }
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
