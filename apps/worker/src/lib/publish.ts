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
