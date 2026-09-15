/**
 * Fan-out a real-time event to everyone connected to a channel's RealtimeHub
 * Durable Object. Best-effort: never throws into the request path.
 *
 * Channels:
 *   user:<uid>     notifications + chat-list bumps
 *   chat:<chatId>  new chat messages
 *   match:<id>     live vote/like/comment/reaction counts
 */
import type { Env } from "../types";

export async function publish(
  env: Env,
  channel: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const id = env.REALTIME.idFromName(channel);
    const stub = env.REALTIME.get(id);
    await stub.fetch("https://do.internal/publish", {
      method: "POST",
      body: JSON.stringify({ channel, ts: Date.now(), ...payload }),
    });
  } catch (e) {
    console.error(`[publish] ${channel} failed`, e);
  }
}

/** Publish to several channels concurrently. */
export async function publishMany(
  env: Env,
  channels: string[],
  payload: Record<string, unknown>,
): Promise<void> {
  await Promise.all(channels.map((ch) => publish(env, ch, payload)));
}


/**
 * Tell every RealtimeHub holding a socket for `uid` to close it.
 *
 * Lives here, next to `publish`, rather than in routes/admin.ts where it started — it is
 * needed by `lib/sessionRevocation.ts` now, and a copy in each place is how the two would
 * drift on which channels count.
 *
 * ---------------------------------------------------------------------------
 * Why revoking a token is not enough on its own
 * ---------------------------------------------------------------------------
 * A socket is authorised ONCE, at the upgrade. After that the connection is open and no
 * further token check happens, so a session that has since been revoked keeps receiving
 * everything the channel carries: `user:<uid>` is notifications and chat-list bumps,
 * `chat:<id>` is message content. It cannot mutate anything — the hub answers nothing but
 * `ping` — but a live read feed is precisely what someone pressing "log out of all
 * devices" is trying to cut off, and the client's own heartbeat will hold it open
 * indefinitely.
 *
 * `match:<id>` is deliberately not enumerated: those channels carry public vote and
 * comment counts that any signed-out visitor can already poll, so there is nothing in
 * them to withhold.
 *
 * Best-effort, and callers must treat it that way. The authoritative eviction is the D1
 * cutoff; this only closes sockets EARLY, so an unreachable Durable Object must never
 * fail the request that ended the sessions.
 */
export async function closeRealtimeSessions(env: Env, uid: string): Promise<void> {
  try {
    const chats = await env.DB.prepare(
      // Reads the membership SOURCE OF TRUTH (chats.users) rather than the
      // chat_members index. This runs only on eviction (block / logout-all /
      // credential change / deletion), never per request, so the scan cost is
      // irrelevant — and closing every one of the user's sockets is a completeness
      // job where reading the authoritative array beats trusting a derived index.
      // The hot per-request paths use chat_members instead (D1_R2_LOAD_AUDIT.md §4).
      `SELECT id FROM chats
        WHERE EXISTS (
          SELECT 1 FROM json_each(chats.users) WHERE json_each.value = ?
        )`,
    )
      .bind(uid)
      .all<{ id: string }>();

    const channels = new Set<string>([
      `user:${uid}`,
      ...(chats.results ?? []).map((chat) => `chat:${chat.id}`),
    ]);

    await Promise.all(
      [...channels].map(async (channel) => {
        const id = env.REALTIME.idFromName(channel);
        await env.REALTIME.get(id).fetch("https://do.internal/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid }),
        });
      }),
    );
  } catch (e) {
    console.error("[publish] realtime session close failed (continuing)", uid, e);
  }
}
