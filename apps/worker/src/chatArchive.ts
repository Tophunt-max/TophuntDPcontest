/**
 * ChatArchive — a SQLite-backed Durable Object that owns the message bodies of
 * ONE chat (idFromName(chatId)).
 *
 * Why this exists
 * ---------------
 * D1 has a single writer for the WHOLE database. The `messages` table is the
 * fastest-growing, highest-write table in the app (one INSERT per message, plus
 * a read-flag UPDATE), and every one of those writes contends on that single
 * writer with wallet, votes, deposits and everything else. This is the classic
 * single-writer bottleneck, and messages are the worst offender because they
 * grow without bound.
 *
 * Moving message bodies into a per-chat Durable Object removes them from D1's
 * writer entirely:
 *   - Each chat is its own SQLite database with its own writer, so two active
 *     chats write in parallel instead of queuing behind one D1 writer.
 *   - D1's daily free write budget (100k/day, shared with the rest of the app)
 *     stops being spent on messages; the DO's own budget carries them.
 *
 * What STAYS in D1, and why
 * -------------------------
 * The `chats` row (last_message preview + updated_at) and the `chat_members`
 * index stay in D1. `/read/chats` orders every one of a user's conversations by
 * `updated_at DESC` and authorizes membership with an indexed seek — both are
 * cross-chat queries a per-chat DO cannot answer. So `sendMessage` still writes
 * ONE bounded UPDATE to `chats` (there is one row per conversation, not one per
 * message); only the unbounded per-message rows leave D1.
 *
 * Migration / cold start (this is the whole backfill)
 * ---------------------------------------------------
 * There is no separate backfill job. On first touch a chat's DO SEEDS itself
 * from the existing D1 `messages` rows for that chat (INSERT OR IGNORE), exactly
 * as VoteCounter seeds from `votes` / `contest_matches`. So a conversation that
 * predates this change keeps its full history the first time anyone opens it or
 * sends into it, and every message written afterwards is DO-only. The D1 rows
 * are left in place as the seed source (and are still cleaned up on chat/account
 * deletion); they simply stop growing.
 *
 * The Worker verifies auth + chat membership BEFORE calling this DO, so — like
 * RealtimeHub and VoteCounter — this class trusts its caller.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/** History page size — matches the previous `GET /read/chats/:id/messages` cap. */
const HISTORY_LIMIT = 200;

/**
 * A chat message kind. `text` is the default and the only value pre-dating media
 * messages; `image` carries a `mediaUrl` pointing at the R2 `chat/` folder.
 * Kept as a widenable string union so a future `video`/`audio` needs no schema
 * change here (the column is free-text).
 */
export type MessageType = "text" | "image";

/** One message as stored/returned. `chatId` is added by the client from the address. */
export interface ArchivedMessage {
  id: string;
  senderId: string;
  text: string | null;
  /** "text" | "image". Defaults to "text" for every pre-media row. */
  type: MessageType;
  /** Public R2 URL for a media message; null for a plain text message. */
  mediaUrl: string | null;
  createdAt: number;
}

interface MessageRow {
  id: string;
  sender_id: string;
  text: string | null;
  type: string | null;
  media_url: string | null;
  created_at: number;
}

export class ChatArchive extends DurableObject<Env> {
  private sql: SqlStorage;
  private seedPromise: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS messages (
         id         TEXT PRIMARY KEY,
         sender_id  TEXT NOT NULL,
         text       TEXT,
         read       INTEGER NOT NULL DEFAULT 0,
         type       TEXT NOT NULL DEFAULT 'text',
         media_url  TEXT,
         created_at INTEGER NOT NULL
       );`,
    );
    // Media columns are added to DOs that were created before this change — a DO
    // has no external migration runner, so the additive columns are applied here,
    // idempotently. A freshly-created table already has them (CREATE above), so
    // the ALTER throws "duplicate column name" and is swallowed. This is the same
    // append-only discipline as the D1 migrations, just self-applied per DO.
    this.addColumnIfMissing("type", "TEXT NOT NULL DEFAULT 'text'");
    this.addColumnIfMissing("media_url", "TEXT");
    // Serves the ORDER BY created_at of both history() (asc) and recent() (desc).
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_msg_created ON messages (created_at);`);
  }

  /** Add a column only if it does not already exist (per-DO self-migration). */
  private addColumnIfMissing(name: string, ddlType: string): void {
    try {
      this.sql.exec(`ALTER TABLE messages ADD COLUMN ${name} ${ddlType};`);
    } catch {
      /* column already present — expected on every table created with it inline */
    }
  }

  // ============================ RPC methods ================================

  /** Append a message and return it. Seeds first so history stays complete. */
  async append(chatId: string, m: ArchivedMessage): Promise<ArchivedMessage> {
    await this.ensureSeeded(chatId);
    this.sql.exec(
      "INSERT OR IGNORE INTO messages (id, sender_id, text, read, type, media_url, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
      m.id,
      m.senderId,
      m.text ?? null,
      m.type || "text",
      m.mediaUrl ?? null,
      m.createdAt,
    );
    return m;
  }

  /**
   * Oldest-first page of messages with `created_at > since`, capped at `limit`
   * (default 200). Mirrors the old REST shape, which deliberately omits `read`.
   */
  async history(chatId: string, since = 0, limit = HISTORY_LIMIT): Promise<ArchivedMessage[]> {
    await this.ensureSeeded(chatId);
    const cap = Math.min(Math.max(Number(limit) || HISTORY_LIMIT, 1), HISTORY_LIMIT);
    const rows = this.sql
      .exec(
        "SELECT id, sender_id, text, type, media_url, created_at FROM messages WHERE created_at > ? ORDER BY created_at ASC LIMIT ?",
        Number(since) || 0,
        cap,
      )
      .toArray() as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * Full-text-ish search over message bodies in THIS chat, newest-first.
   *
   * A per-chat `LIKE` scan, not a global index: message bodies are partitioned
   * one SQLite DB per chat, so "search my conversation" is answered entirely
   * inside the chat's own DO with no cross-chat fan-out. Media messages have a
   * null `text`, so they never match — search is over what was typed.
   */
  async search(chatId: string, query: string, limit = 50): Promise<ArchivedMessage[]> {
    await this.ensureSeeded(chatId);
    const q = String(query || "").trim();
    if (!q) return [];
    const cap = Math.min(Math.max(Number(limit) || 50, 1), HISTORY_LIMIT);
    // Escape LIKE wildcards so a user searching for "50%" or "a_b" matches those
    // literals rather than treating them as patterns. `\` is the ESCAPE char.
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = this.sql
      .exec(
        "SELECT id, sender_id, text, type, media_url, created_at FROM messages WHERE text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?",
        `%${escaped}%`,
        cap,
      )
      .toArray() as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /** Mark every inbound (not-mine) unread message as read. Returns the count changed. */
  async markRead(chatId: string, readerUid: string): Promise<{ updated: number }> {
    await this.ensureSeeded(chatId);
    const before = this.count("sender_id != ? AND read = 0", readerUid);
    if (before > 0) {
      this.sql.exec("UPDATE messages SET read = 1 WHERE sender_id != ? AND read = 0", readerUid);
    }
    return { updated: before };
  }

  /** Delete every message in this chat (chat deletion). */
  async purge(_chatId: string): Promise<{ deleted: number }> {
    const n = this.count("1 = 1");
    this.sql.exec("DELETE FROM messages");
    this.sql.exec("DELETE FROM meta");
    return { deleted: n };
  }

  /** Delete every message sent by `uid` (account deletion). */
  async deleteBySender(chatId: string, uid: string): Promise<{ deleted: number }> {
    await this.ensureSeeded(chatId);
    const n = this.count("sender_id = ?", uid);
    if (n > 0) this.sql.exec("DELETE FROM messages WHERE sender_id = ?", uid);
    return { deleted: n };
  }

  /** Messages sent by `uid`, newest-first, capped (account export). */
  async listBySender(chatId: string, uid: string, limit: number): Promise<ArchivedMessage[]> {
    await this.ensureSeeded(chatId);
    const cap = Math.min(Math.max(Number(limit) || 1, 1), 1000);
    const rows = this.sql
      .exec(
        "SELECT id, sender_id, text, type, media_url, created_at FROM messages WHERE sender_id = ? ORDER BY created_at DESC LIMIT ?",
        uid,
        cap,
      )
      .toArray() as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /** Delete a single message by id (admin moderation). */
  async deleteOne(chatId: string, id: string): Promise<{ deleted: number }> {
    await this.ensureSeeded(chatId);
    const n = this.count("id = ?", id);
    if (n > 0) this.sql.exec("DELETE FROM messages WHERE id = ?", id);
    return { deleted: n };
  }

  /** Most recent messages, newest-first, capped (admin moderation dump). */
  async recent(chatId: string, limit: number): Promise<ArchivedMessage[]> {
    await this.ensureSeeded(chatId);
    const cap = Math.min(Math.max(Number(limit) || 1, 1), 300);
    const rows = this.sql
      .exec(
        "SELECT id, sender_id, text, type, media_url, created_at FROM messages ORDER BY created_at DESC LIMIT ?",
        cap,
      )
      .toArray() as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  // --------------------------------------------------------------------- seed

  private async ensureSeeded(chatId: string): Promise<void> {
    if (this.getMeta("seeded") === "1") return;
    if (!this.seedPromise) this.seedPromise = this.doSeed(chatId);
    await this.seedPromise;
  }

  private async doSeed(chatId: string): Promise<void> {
    if (!chatId) return;
    try {
      const rows = await this.env.DB.prepare(
        "SELECT id, sender_id, text, read, type, media_url, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC",
      )
        .bind(chatId)
        .all<{ id: string; sender_id: string; text: string | null; read: number | null; type: string | null; media_url: string | null; created_at: number }>();
      for (const r of rows.results ?? []) {
        this.sql.exec(
          "INSERT OR IGNORE INTO messages (id, sender_id, text, read, type, media_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          r.id,
          r.sender_id,
          r.text ?? null,
          r.read ? 1 : 0,
          r.type || "text",
          r.media_url ?? null,
          r.created_at ?? Date.now(),
        );
      }
    } catch (e) {
      // Do NOT mark seeded: proceeding against an empty baseline would hide the
      // existing history until the next (successful) touch. Fail so the caller
      // retries, exactly as VoteCounter does on a seed error.
      console.error("[ChatArchive] seed failed", chatId, e);
      this.seedPromise = null;
      throw e;
    }
    this.setMeta("seeded", "1");
  }

  // ------------------------------------------------------------------ helpers

  private count(where: string, ...binds: unknown[]): number {
    const row = this.sql
      .exec(`SELECT COUNT(*) AS n FROM messages WHERE ${where}`, ...(binds as any[]))
      .toArray()[0] as { n: number } | undefined;
    return row ? Number(row.n) : 0;
  }

  private getMeta(k: string): string | null {
    const row = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0] as
      | { v: string }
      | undefined;
    return row ? row.v : null;
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k,
      v,
    );
  }
}

function toMessage(r: MessageRow): ArchivedMessage {
  return {
    id: r.id,
    senderId: r.sender_id,
    text: r.text ?? null,
    type: (r.type as MessageType) || "text",
    mediaUrl: r.media_url ?? null,
    createdAt: Number(r.created_at),
  };
}
