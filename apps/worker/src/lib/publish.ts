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

/** Max conversations a single presence change fans out to. */
const PRESENCE_FANOUT_LIMIT = 20;

/**
 * Broadcast a user's online/offline transition to the people who can see it.
 *
 * Called exactly twice per session — once when the `user:<uid>` socket opens
 * (online) and once when it closes (offline) — never per message or per
 * heartbeat, so the fan-out cost is bounded to session edges, not traffic.
 *
 * Presence reaches two kinds of subscriber:
 *   - `chat:<chatId>`  so an OPEN conversation's header flips live.
 *   - `user:<peerUid>` so a peer's INBOX (which holds only their own user socket)
 *                      updates the green dot without opening every chat.
 *
 * Capped at the user's most-recent {@link PRESENCE_FANOUT_LIMIT} conversations:
 * presence only matters for active chats, and the cap keeps the number of DO
 * subrequests here well under the per-invocation ceiling. Best-effort — presence
 * must never fail the connect/disconnect it rides on.
 */
export async function publishPresence(
  env: Env,
  uid: string,
  online: boolean,
  lastSeen: number,
): Promise<void> {
  try {
    const rows = await env.DB.prepare(
      `SELECT c.id AS chat_id, c.users AS users
         FROM chat_members m JOIN chats c ON c.id = m.chat_id
        WHERE m.user_id = ?
        ORDER BY c.updated_at DESC
        LIMIT ?`,
    )
      .bind(uid, PRESENCE_FANOUT_LIMIT)
      .all<{ chat_id: string; users: string }>();

    const channels = new Set<string>();
    for (const r of rows.results ?? []) {
      channels.add(`chat:${r.chat_id}`);
      let members: string[] = [];
      try {
        members = JSON.parse(r.users || "[]");
      } catch {
        members = [];
      }
      for (const m of members) if (m && m !== uid) channels.add(`user:${m}`);
    }
    if (channels.size === 0) return;
    await publishMany(env, [...channels], { type: "presence", uid, online, lastSeen });
  } catch (e) {
    console.error("[publish] presence failed (continuing)", uid, online, e);
  }
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
