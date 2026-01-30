export interface Env {
  CHAT_ROOM: DurableObjectNamespace;
  DB: D1Database;
}

const BRIDGE_URL = "https://us-central1-tophuntdpcontest.cloudfunctions.net/sendChatNotificationBridge";
const BRIDGE_KEY = "your-secure-shared-key";

async function notifyRecipient(payload: any) {
  try {
    await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': BRIDGE_KEY },
      body: JSON.stringify({
        recipientId: payload.recipientId,
        senderName: payload.senderName || "User",
        text: payload.text || "Sent an attachment",
        chatId: payload.chatId
      })
    });
  } catch (e) {
    console.error("FCM Bridge Error:", e);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const chatId = url.searchParams.get("chatId");
    const userId = url.searchParams.get("userId");

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // 1. Block User
    if (url.pathname === "/block" && request.method === "POST") {
        const { chatId, userId, block } = await request.json() as any;
        const chat = await env.DB.prepare("SELECT blocked_status FROM chats WHERE id = ?").bind(chatId).first();
        if (chat) {
            const status = JSON.parse(chat.blocked_status || "{}");
            status[userId] = block;
            await env.DB.prepare("UPDATE chats SET blocked_status = ?, updated_at = ? WHERE id = ?")
                .bind(JSON.stringify(status), Date.now(), chatId).run();
            return Response.json({ success: true }, { headers: { "Access-Control-Allow-Origin": "*" } });
        }
    }

    // 2. Fetch Inbox
    if (url.pathname === "/chats" && userId) {
      const { results } = await env.DB.prepare(`
        SELECT c.*, 
        (SELECT json_object('id', id, 'content', content, 'sender_id', sender_id, 'created_at', created_at, 'type', type, 'status', status) 
         FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND sender_id != ? AND status != 'seen') as unread_count
        FROM chats c
        WHERE participants LIKE ?
        ORDER BY updated_at DESC
      `).bind(userId, `%${userId}%`).all();
      return Response.json(results, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // 3. Chat History
    if (url.pathname === "/history" && chatId) {
      const { results } = await env.DB.prepare(
        "SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT 100"
      ).bind(chatId).all();
      return Response.json(results, { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // WebSocket Upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const id = env.CHAT_ROOM.idFromName(chatId!);
      const roomObject = env.CHAT_ROOM.get(id);
      return roomObject.fetch(request);
    }

    return new Response("Chat Worker API", { status: 200 });
  },
};

export class ChatRoom {
  state: DurableObjectState;
  env: Env;
  sessions: Map<WebSocket, { userId: string }>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
  }

  async fetch(request: Request) {
    const [client, server] = Object.values(new WebSocketPair());
    const userId = new URL(request.url).searchParams.get("userId")!;
    await this.handleSession(server, userId);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleSession(ws: WebSocket, userId: string) {
    ws.accept();
    this.sessions.set(ws, { userId });
    this.broadcast({ type: "presence", from: userId, status: "online" }, ws);

    ws.addEventListener("message", async (msg) => {
      try {
        const payload = JSON.parse(msg.data as string);
        const timestamp = Date.now();

        if (['text', 'image', 'voice_note'].includes(payload.type)) {
          // Check for blocks before broadcasting
          const chat = await this.env.DB.prepare("SELECT blocked_status FROM chats WHERE id = ?").bind(payload.chatId).first();
          if (chat) {
              const blocked = JSON.parse(chat.blocked_status || "{}");
              if (Object.values(blocked).some(v => v === true)) return;
          }

          const msgId = crypto.randomUUID();
          await this.env.DB.prepare(
            "INSERT INTO messages (id, chat_id, sender_id, type, content, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).bind(msgId, payload.chatId, userId, payload.type, payload.text || payload.content, timestamp, 'sent').run();

          await this.env.DB.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").bind(timestamp, payload.chatId).run();

          this.broadcast({ ...payload, id: msgId, from: userId, timestamp, status: 'sent' });

          const onlineUserIds = [...this.sessions.values()].map(s => s.userId);
          if (payload.recipientId && !onlineUserIds.includes(payload.recipientId)) {
             this.state.waitUntil(notifyRecipient({ ...payload, chatId: payload.chatId }));
          }
        } 
        else if (payload.type === 'delivered') {
           await this.env.DB.prepare("UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?")
             .bind(timestamp, payload.messageId).run();
           this.broadcast({ ...payload, status: 'delivered' }, ws);
        }
        else if (payload.type === 'mark-seen') {
          await this.env.DB.prepare("UPDATE messages SET status = 'seen', seen_at = ? WHERE chat_id = ? AND sender_id != ? AND status != 'seen'")
            .bind(timestamp, payload.chatId, userId).run();
          this.broadcast({ ...payload, from: userId }, ws);
        }
        else {
          this.broadcast({ ...payload, from: userId, timestamp }, ws);
        }
      } catch (err) { console.error(err); }
    });

    ws.addEventListener("close", () => {
      this.sessions.delete(ws);
      this.broadcast({ type: "presence", from: userId, status: "offline" });
    });
  }

  broadcast(message: any, exclude?: WebSocket) {
    const data = JSON.stringify(message);
    for (const [ws] of this.sessions) {
      if (ws !== exclude) {
        try { ws.send(data); } catch (e) { this.sessions.delete(ws); }
      }
    }
  }
}
