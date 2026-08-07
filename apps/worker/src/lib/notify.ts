/**
 * Notification pipeline. In the Firebase backend, notifications were produced
 * two ways: (1) explicit createNotification() calls and (2) 12 Firestore
 * onDocument triggers. D1 has no triggers, so ALL notifications are now
 * explicit createNotification()/sendPushNotification() calls from the handlers.
 *
 * createNotification: writes a row to `notifications` (was
 * notifications/{uid}/items) AND sends an FCM push, pruning dead tokens.
 */
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { newId, now } from "./ids";
import { sendFcmToToken } from "./firebaseAdmin";
import { publish } from "./publish";

export async function sendPushNotification(
  env: Env,
  userId: string,
  title: string,
  body: string,
  type: string,
  data: Record<string, string> = {},
): Promise<void> {
  try {
    const db = getDb(env);
    const user = await db
      .select({ fcmTokens: schema.users.fcmTokens })
      .from(schema.users)
      .where(eq(schema.users.uid, userId))
      .get();

    const tokens: string[] = (user?.fcmTokens as string[]) || [];
    if (!tokens.length) return;

    const results = await Promise.all(
      tokens.map((t) => sendFcmToToken(env, t, { title, body }, { type, ...data })),
    );

    const validTokens = tokens.filter((_, i) => !results[i].invalid);
    if (validTokens.length !== tokens.length) {
      await db
        .update(schema.users)
        .set({ fcmTokens: validTokens })
        .where(eq(schema.users.uid, userId));
    }
  } catch (e) {
    console.error("[notify] push failed", e);
  }
}

export interface NotificationInput {
  title: string;
  body: string;
  type: "like" | "comment" | "follow" | "contest" | "admin" | string;
  targetId: string;
  image?: string;
  data?: Record<string, string>;
}

export async function createNotification(
  env: Env,
  recipientId: string,
  n: NotificationInput,
): Promise<void> {
  if (!recipientId) return;
  try {
    const db = getDb(env);
    const notifId = newId();
    await db.insert(schema.notifications).values({
      id: notifId,
      recipientId,
      title: n.title,
      body: n.body,
      type: n.type,
      targetId: n.targetId,
      image: n.image ?? null,
      data: n.data ?? null,
      read: false,
      createdAt: now(),
    });

    // Instant push to the recipient's live WebSocket (in-app real-time).
    await publish(env, `user:${recipientId}`, {
      type: "notification",
      notification: { id: notifId, title: n.title, body: n.body, notifType: n.type, targetId: n.targetId, image: n.image ?? null },
    });

    await sendPushNotification(env, recipientId, n.title, n.body, n.type, {
      targetId: n.targetId,
      image: n.image || "",
      ...(n.data || {}),
    });
  } catch (e) {
    console.error("[notify] createNotification failed", e);
  }
}

/** Broadcast to all users (admin). Batched to avoid huge parallelism. */
export async function sendBroadcastToAllUsers(
  env: Env,
  title: string,
  body: string,
  imageUrl?: string,
  data?: Record<string, string>,
): Promise<number> {
  const db = getDb(env);
  const rows = await db.select({ uid: schema.users.uid }).from(schema.users).all();
  let sent = 0;
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await Promise.all(
      batch.map((r) =>
        createNotification(env, r.uid, {
          title,
          body,
          type: "admin",
          targetId: "broadcast",
          image: imageUrl,
          data,
        }),
      ),
    );
    sent += batch.length;
  }
  return sent;
}
