/**
 * Live battle updates for signed-out viewers.
 *
 * Guest-first browsing shows the public feed to guests, but `/ws` required a
 * Firebase token, so a guest's battle cards never received live vote/like counts —
 * and the client retried the token-less socket every 2s per card, forever. Only
 * the safety-net poll (`GET /read/matches/:id` every 3 min per card) refreshed
 * them, which is both staler and more D1 work than a hibernating socket.
 *
 * A guest may now subscribe to `match:<id>` and nothing else. That channel carries
 * only public tallies (votes, like/comment/share counts, status/winner) — the same
 * numbers `/read/matches` already returns to guests. `user:` and `chat:` channels
 * still require a verified token.
 *
 * Guards, cheapest first:
 *   1. The id must look like a match id (no arbitrary Durable Object names).
 *   2. Per-IP rate limit on the existing GUEST_READ_LIMITER binding (fail-open,
 *      exactly like `guestReadLimit`).
 *   3. The match must exist, be in a live state and not be invite-only. One PK
 *      lookup, memoised per isolate for MEMO_SEC (positive and negative), so a
 *      popular battle costs one D1 read per isolate per minute, not one per guest.
 */
import type { Env } from "../types";
import { memoGet, memoPut } from "./memo";
import { APP_CONFIG_SHARDS } from "./appControl";

const MATCH_ID = /^[A-Za-z0-9_-]{6,64}$/;
const LIVE_STATUSES = new Set(["active", "waiting_for_opponent"]);
const MEMO_SEC = 60;

/** The identity a guest socket is tagged with in the RealtimeHub. */
export const GUEST_SOCKET_UID = "guest";

export type GuestWsDecision = { ok: true } | { ok: false; status: 400 | 403 | 404 | 429; reason: string };

export async function authorizeGuestMatchSocket(env: Env, ref: string, ip: string): Promise<GuestWsDecision> {
  if (!MATCH_ID.test(ref)) return { ok: false, status: 400, reason: "Bad match id." };

  const limiter = env.GUEST_READ_LIMITER;
  if (limiter) {
    try {
      if (!(await limiter.limit({ key: `guestws:${ip || "unknown"}` })).success) {
        return { ok: false, status: 429, reason: "Too many connections." };
      }
    } catch (e) {
      console.error("[wsGuest] limiter unavailable (failing open)", e);
    }
  }

  const key = `memo:wsGuestMatch:${ref}`;
  let allowed = memoGet<{ v: boolean }>(key)?.v;
  if (allowed === undefined) {
    const row = await env.DB.prepare("SELECT status, is_private FROM contest_matches WHERE id = ?")
      .bind(ref)
      .first<{ status: string; is_private: number | null }>()
      .catch(() => null);
    allowed = !!row && LIVE_STATUSES.has(row.status) && !row.is_private;
    memoPut(key, { v: allowed }, MEMO_SEC);
  }
  return allowed ? { ok: true } : { ok: false, status: 404, reason: "No live public battle." };
}

/**
 * The client's headers, minus every header the RealtimeHub treats as a fact
 * established by THIS Worker. The hub trusts `X-Authenticated-Uid` (revocation tag),
 * `X-Presence-Uid` (marks a presence socket: on close it stamps `last_seen_at` and
 * announces that user offline) and `X-Guest-Socket`. They used to be copied
 * straight from the client, so a scripted client could set `X-Presence-Uid` to any
 * uid and flip that user "offline" for their peers — with no token at all on the
 * guest path. Each branch sets the ones it means after this strips them.
 */
export function trustedHubHeaders(incoming: Headers): Headers {
  const h = new Headers(incoming);
  for (const name of ["X-Authenticated-Uid", "X-Presence-Uid", "X-Guest-Socket", "X-Guest-Cap"]) h.delete(name);
  return h;
}

/**
 * Split a `/ws` channel into kind and ref, or null. The whole string must be
 * exactly `<kind>:<ref>` with a known kind — it becomes the Durable Object name.
 */
export function parseWsChannel(channel: string): { kind: "user" | "chat" | "match" | "app"; ref: string } | null {
  const i = channel.indexOf(":");
  if (i <= 0) return null;
  const kind = channel.slice(0, i);
  const ref = channel.slice(i + 1);
  if (kind !== "user" && kind !== "chat" && kind !== "match" && kind !== "app") return null;
  if (!ref || ref.includes(":") || ref.length > 128) return null;
  // `app:cfg<N>` only, N < APP_CONFIG_SHARDS: a fixed, small set of DO names.
  if (kind === "app") {
    const m = ref.match(/^cfg(\d{1,2})$/);
    if (!m || Number(m[1]) >= APP_CONFIG_SHARDS) return null;
  }
  return { kind, ref };
}

/** Anonymous sockets one `app:cfg<N>` shard accepts (16 shards). */
export const MAX_APP_CONFIG_SOCKETS = 15000;

/**
 * App Control push (`app:cfg<N>`): public, the same payload GET /read/app-config
 * serves to anyone. Every app instance — signed in or not — holds one socket,
 * always anonymous (no token verify or account read per connect). Bounded by the
 * per-IP limiter and the per-shard cap.
 */
export async function authorizeAppConfigSocket(env: Env, ip: string): Promise<GuestWsDecision> {
  const limiter = env.GUEST_READ_LIMITER;
  if (limiter) {
    try {
      if (!(await limiter.limit({ key: `appws:${ip || "unknown"}` })).success) {
        return { ok: false, status: 429, reason: "Too many connections." };
      }
    } catch (e) {
      console.error("[wsGuest] limiter unavailable (failing open)", e);
    }
  }
  return { ok: true };
}
