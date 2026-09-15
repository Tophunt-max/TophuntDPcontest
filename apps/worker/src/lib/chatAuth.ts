/**
 * Chat membership authorization.
 *
 * Membership is an indexed row in `chat_members` (see D1_R2_LOAD_AUDIT.md §4 and
 * migration 0045) — a `(chat_id, user_id)` existence check, which replaces the old
 * EXISTS(json_each(chats.users)) test. The REST handlers `sendMessage`,
 * `markChatRead`, `deleteChat` and `GET /read/chats/:id/messages` all gate on this;
 * without it any authenticated caller who knew (or guessed) a chat id could act on
 * it, since a chat id is not a secret and `requireAuth` only proves *someone* is
 * logged in. Always use this rather than re-deriving the check.
 */
import type { Env } from "../types";
import { httpsError } from "./http";

/** True when `uid` is a participant of `chatId`. */
export async function isChatMember(env: Env, chatId: string, uid: string): Promise<boolean> {
  if (!chatId || !uid) return false;
  // Index seek on the chat_members PK — no scan of `chats`, no json_each.
  const row = await env.DB.prepare(
    `SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?`,
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
