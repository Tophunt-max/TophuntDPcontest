/**
 * Lightweight per-key rate limiter backed by CACHE_KV (fixed window).
 *
 * Purpose: throttle abusive bursts on write actions (votes, likes, comments)
 * so bots can't flood the app — which also protects D1 from junk writes.
 *
 * Trade-off: KV is eventually consistent, so the limit is approximate under
 * heavy concurrency (a few extra requests may slip through). That is fine for
 * coarse abuse throttling. For strict per-user limits a dedicated Durable
 * Object would be the next step.
 */
import type { Env } from "../types";
import { httpsError } from "./http";

/**
 * Allow at most `max` events per `windowSec` for `key`. Throws a
 * `resource-exhausted` HttpsError when the limit is exceeded.
 */
export async function rateLimit(
  env: Env,
  key: string,
  max: number,
  windowSec: number,
): Promise<void> {
  try {
    const windowId = Math.floor(Date.now() / 1000 / windowSec);
    const cacheKey = `rl:${key}:${windowId}`;
    const current = Number((await env.CACHE_KV.get(cacheKey)) || 0);
    if (current >= max) {
      throw httpsError("resource-exhausted", "Too many requests. Please slow down.");
    }
    // Best-effort increment. TTL slightly longer than the window so the counter
    // survives until the window rolls over, then expires on its own.
    await env.CACHE_KV.put(cacheKey, String(current + 1), {
      expirationTtl: windowSec + 5,
    });
  } catch (e: any) {
    // Re-throw our own limit error; swallow KV transport errors (fail-open so a
    // KV blip never blocks legitimate traffic).
    if (e?.code === "resource-exhausted") throw e;
    console.error("[rateLimit] KV error (failing open)", e);
  }
}
