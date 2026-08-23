/**
 * FCM device-token ownership.
 *
 * A push token identifies a DEVICE, not an account, so the same token can move
 * between users on a shared, resold, or multi-login phone. Nothing used to
 * detach it from the previous owner, which meant that after a logout the old
 * account kept receiving notifications on a device it no longer controlled.
 *
 * Two halves of the fix live in `routes/api.ts`:
 *  - `unregisterFcmToken` — the client detaches on sign-out;
 *  - `registerFcmToken` — calls `detachTokenFromOtherUsers` below, so even if
 *    sign-out never ran (app killed, uninstall, crash) the next login steals the
 *    token from whoever held it.
 */
import { like } from "drizzle-orm";
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { now } from "./ids";

/**
 * Remove `token` from every user except `keepUid`.
 *
 * `fcm_tokens` is a JSON array column, so candidates are narrowed with a LIKE on
 * the serialized text and then filtered exactly in JS — a LIKE match could be a
 * substring of a longer token, so it is treated as a prefilter only.
 */
export async function detachTokenFromOtherUsers(
  env: Env,
  token: string,
  keepUid: string,
): Promise<void> {
  if (!token) return;
  const db = getDb(env);
  try {
    const candidates = await db
      .select({ uid: schema.users.uid, fcmTokens: schema.users.fcmTokens })
      .from(schema.users)
      .where(like(schema.users.fcmTokens, `%${token}%`))
      .limit(50)
      .all();

    for (const row of candidates) {
      if (row.uid === keepUid) continue;
      const tokens = (row.fcmTokens as string[]) || [];
      // Exact match only — the LIKE above is just a prefilter.
      if (!tokens.includes(token)) continue;
      await db
        .update(schema.users)
        .set({ fcmTokens: tokens.filter((t) => t !== token), updatedAt: now() })
        .where(eq(schema.users.uid, row.uid))
        .run();
    }
  } catch (e) {
    // Never block a login on this — a stale token is a privacy nuisance, but a
    // failed login is worse.
    console.error("[pushTokens] detachTokenFromOtherUsers failed", e);
  }
}
