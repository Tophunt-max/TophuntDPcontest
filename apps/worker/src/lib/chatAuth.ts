/**
 * Chat membership authorization.
 *
 * `chats.users` is a JSON array of uids, so membership is checked by expanding
 * it with `json_each` inside the same statement that looks up the chat. This is
 * the exact query the WebSocket upgrade path in `src/index.ts` already uses;
 * the REST handlers were never given the equivalent check, which left
 * `sendMessage`, `markChatRead`, `deleteChat` and `GET /read/chats/:id/messages`
 * open to any authenticated caller who knew (or guessed) a chat id.
 *
 * Always use this rather than re-deriving the check — a chat id is not a secret
 * and `requireAuth` only proves that *someone* is logged in.
 */
import type { Env } from "../types";
import { httpsError } from "./http";

/** True when `uid` is a participant of `chatId`. */
export async function isChatMember(env: Env, chatId: string, uid: string): Promise<boolean> {
  if (!chatId || !uid) return false;
  const row = await env.DB.prepare(
    `SELECT 1 FROM chats WHERE id = ?
       AND EXISTS (SELECT 1 FROM json_each(chats.users) WHERE json_each.value = ?)`,
  )
    .bind(chatId, uid)
    .first();
  return !!row;
}

/**
 * Throws unless `uid` is a participant of `chatId`.
 *
 * Deliberately reports `not-found` rather than `permission-denied`: a
 * non-member should not be able to tell an existing chat from a nonexistent one.
 */
export async function assertChatMember(env: Env, chatId: string, uid: string): Promise<void> {
  if (!(await isChatMember(env, chatId, uid))) {
    throw httpsError("not-found", "Chat not found.");
  }
}
