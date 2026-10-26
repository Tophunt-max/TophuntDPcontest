/**
 * Short-lived WebSocket tickets, so the Firebase ID token stays out of URLs.
 *
 * A browser WebSocket cannot send an Authorization header, so `/ws` took the ID
 * token as `?token=`. Request URLs are recorded by Cloudflare Workers Logs
 * (`[observability]` in wrangler.toml), which put hour-long bearer tokens into
 * the log store. The app now asks `/api` (Authorization header) for a ticket and
 * opens the socket with `?ticket=`. A ticket:
 *  - names the uid and the session's sign-in time (so revocation still applies),
 *  - expires after WS_TICKET_TTL_SEC,
 *  - is HMAC-SHA256 signed, so it is stateless (no KV write per connection),
 *  - is only accepted by `/ws`.
 *
 * Key: `WS_TICKET_SECRET` if set, otherwise a key derived from
 * `ADMIN_PROXY_SECRET` with a domain prefix (the admin secret itself is never
 * used or revealed). With neither, tickets are off and `?token=` keeps working.
 */
import type { Env } from "../types";

export const WS_TICKET_TTL_SEC = 120;

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
};

async function keyFor(env: Env): Promise<CryptoKey | null> {
  const dedicated = (env as any).WS_TICKET_SECRET as string | undefined;
  const base = dedicated || (env.ADMIN_PROXY_SECRET ? `ws-ticket.v1|${env.ADMIN_PROXY_SECRET}` : "");
  if (!base) return null;
  return crypto.subtle.importKey("raw", enc.encode(base), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function mintWsTicket(
  env: Env,
  uid: string,
  authTime: number | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ ticket: string; expiresAt: number } | null> {
  const key = await keyFor(env);
  if (!key) return null;
  const exp = nowSec + WS_TICKET_TTL_SEC;
  const payload = b64url(enc.encode(JSON.stringify({ u: uid, a: authTime ?? 0, e: exp })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`ws1.${payload}`)));
  return { ticket: `${payload}.${b64url(sig)}`, expiresAt: exp * 1000 };
}

/** The ticket's identity, or null when it is malformed, forged or expired. */
export async function verifyWsTicket(
  env: Env,
  ticket: string,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ uid: string; authTime: number } | null> {
  if (typeof ticket !== "string" || ticket.length > 1024) return null;
  const dot = ticket.indexOf(".");
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  const key = await keyFor(env);
  if (!key) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(ticket.slice(dot + 1)), enc.encode(`ws1.${payload}`));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    if (typeof data?.u !== "string" || !data.u || typeof data?.e !== "number" || data.e < nowSec) return null;
    return { uid: data.u, authTime: Number(data.a) || 0 };
  } catch {
    return null;
  }
}
