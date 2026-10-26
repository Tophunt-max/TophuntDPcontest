/**
 * Chat thread state, kept pure so it can be tested without rendering GiftedChat.
 *
 * Message ids: an outgoing message is created with a client id, and the server
 * stores it as `${senderUid}_${clientId}` (worker sendMessage). The optimistic
 * bubble uses that same id from the start, so the server copy (from the send
 * response, a realtime refresh, or a retry) always replaces the bubble instead
 * of appearing next to it.
 *
 * Merging: a refresh returns only the NEWEST page. Replacing the list with it
 * dropped older pages the user had loaded and any bubble still in flight, so
 * refreshes merge by id instead.
 */

/** One message as GiftedChat renders it (the subset this module touches). */
export interface ThreadMessage {
  _id: string;
  text: string;
  createdAt: Date | number;
  user: { _id: string };
  image?: string;
  /** Optimistic: not yet acknowledged by the server. */
  pending?: boolean;
  sent?: boolean;
  received?: boolean;
}

/** A server message row (GET /read/chats/:id/messages, sendMessage response). */
export interface ServerMessage {
  id: string;
  senderId: string;
  text: string | null;
  type?: string;
  mediaUrl?: string | null;
  createdAt: number;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 20 random characters: inside the server's clientId rule (8-64 of [A-Za-z0-9_-]). */
export function newClientId(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 20; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return out;
}

/** The id the server will store an outgoing message under. */
export const outgoingMessageId = (senderUid: string, clientId: string) => `${senderUid}_${clientId}`;

export function fromServer(m: ServerMessage): ThreadMessage {
  return {
    _id: m.id,
    // An image message may carry only a caption (or nothing); GiftedChat
    // renders `image` above `text`, so both flow through the same bubble.
    text: m.text || '',
    image: m.type === 'image' && m.mediaUrl ? m.mediaUrl : undefined,
    createdAt: new Date(m.createdAt),
    user: { _id: m.senderId },
    sent: true,
  };
}

const time = (m: ThreadMessage) => new Date(m.createdAt).getTime();

/**
 * Merge a server page into the thread (newest-first, as GiftedChat wants).
 *
 * - Server rows win over anything local with the same id (acknowledged copy).
 * - Local messages not in the page are kept: older loaded pages, and pending
 *   bubbles still in flight.
 * - A non-pending local message inside the page's time range that the page does
 *   not contain was removed on the server (moderation), so it is dropped.
 */
export function mergeThread(current: ThreadMessage[], page: ServerMessage[]): ThreadMessage[] {
  const byId = new Map<string, ThreadMessage>();
  const pageOldest = page.length ? Math.min(...page.map((m) => m.createdAt)) : Infinity;
  const pageIds = new Set(page.map((m) => m.id));
  for (const m of current) {
    if (!m.pending && !pageIds.has(m._id) && time(m) >= pageOldest) continue;
    byId.set(m._id, m);
  }
  for (const m of page) byId.set(m.id, fromServer(m));
  return [...byId.values()].sort((a, b) => time(b) - time(a) || (a._id < b._id ? 1 : -1));
}

/** Older page from "load earlier": appended below, deduplicated. */
export function appendOlder(current: ThreadMessage[], older: ServerMessage[]): ThreadMessage[] {
  const have = new Set(current.map((m) => m._id));
  const add = older.filter((m) => !have.has(m.id)).map(fromServer);
  return [...current, ...add].sort((a, b) => time(b) - time(a) || (a._id < b._id ? 1 : -1));
}

/** True when the page holds a message from someone else newer than `since`. */
export function hasNewIncoming(page: ServerMessage[], myUid: string, since: number): boolean {
  return page.some((m) => m.senderId !== myUid && m.createdAt > since);
}
