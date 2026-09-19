/**
 * Thin client for the ChatArchive Durable Object (one instance per chatId).
 * Uses native Durable Object RPC — plain method calls on the stub, no URLs.
 *
 * Message BODIES live in these DOs; the `chats` preview row and `chat_members`
 * index stay in D1 (see src/chatArchive.ts for the rationale). Routes call these
 * helpers instead of touching a D1 `messages` table.
 */
import type { Env } from "../types";
import type { ArchivedMessage } from "../chatArchive";

export type { ArchivedMessage } from "../chatArchive";

/** A message as returned to clients — the archived shape plus its chatId. */
export interface ChatMessage extends ArchivedMessage {
  chatId: string;
}

function stub(env: Env, chatId: string) {
  const id = env.CHAT_ARCHIVE.idFromName(chatId);
  return env.CHAT_ARCHIVE.get(id);
}

const withChatId = (chatId: string) => (m: ArchivedMessage): ChatMessage => ({ ...m, chatId });

/** Persist a message in the chat's DO and return it (with chatId). */
export async function appendMessage(
  env: Env,
  chatId: string,
  m: ArchivedMessage,
): Promise<ChatMessage> {
  const saved = await stub(env, chatId).append(chatId, m);
  return { ...saved, chatId };
}

/** Oldest-first history page after `since` (epoch ms), capped at `limit`. */
export async function chatHistory(
  env: Env,
  chatId: string,
  since = 0,
  limit = 200,
): Promise<ChatMessage[]> {
  const rows = await stub(env, chatId).history(chatId, since, limit);
  return rows.map(withChatId(chatId));
}

/** Search this chat's message bodies (newest-first), capped at `limit`. */
export async function searchChatMessages(
  env: Env,
  chatId: string,
  query: string,
  limit = 50,
): Promise<ChatMessage[]> {
  const rows = await stub(env, chatId).search(chatId, query, limit);
  return rows.map(withChatId(chatId));
}

/** Mark all inbound unread messages in the chat as read for `readerUid`. */
export async function markChatMessagesRead(
  env: Env,
  chatId: string,
  readerUid: string,
): Promise<number> {
  const { updated } = await stub(env, chatId).markRead(chatId, readerUid);
  return updated;
}

/** Delete every message in the chat (chat deletion). Best-effort; never throws. */
export async function purgeChatMessages(env: Env, chatId: string): Promise<void> {
  try {
    await stub(env, chatId).purge(chatId);
  } catch (e) {
    console.error("[chatArchive] purge failed (continuing)", chatId, e);
  }
}

/** Delete every message `uid` sent in `chatId` (account deletion). Best-effort. */
export async function deleteChatMessagesBySender(
  env: Env,
  chatId: string,
  uid: string,
): Promise<number> {
  try {
    const { deleted } = await stub(env, chatId).deleteBySender(chatId, uid);
    return deleted;
  } catch (e) {
    console.error("[chatArchive] deleteBySender failed (continuing)", chatId, uid, e);
    return 0;
  }
}

/** Messages `uid` sent in `chatId`, newest-first, capped (account export). */
export async function listChatMessagesBySender(
  env: Env,
  chatId: string,
  uid: string,
  limit: number,
): Promise<ChatMessage[]> {
  const rows = await stub(env, chatId).listBySender(chatId, uid, limit);
  return rows.map(withChatId(chatId));
}

/** Delete a single message by id (admin moderation). Returns rows removed. */
export async function deleteChatMessage(
  env: Env,
  chatId: string,
  id: string,
): Promise<number> {
  const { deleted } = await stub(env, chatId).deleteOne(chatId, id);
  return deleted;
}

/** Most recent messages in the chat, newest-first, capped (admin moderation dump). */
export async function recentChatMessages(
  env: Env,
  chatId: string,
  limit: number,
): Promise<ChatMessage[]> {
  const rows = await stub(env, chatId).recent(chatId, limit);
  return rows.map(withChatId(chatId));
}
