/**
 * Coarse per-subject backstops on the Workers Rate Limiting bindings.
 *
 * lib/rateLimit.ts (the RateLimiter Durable Object) gives exact per-action limits,
 * but each check is one billed DO request against a 100k/day budget shared with
 * RealtimeHub and VoteCounter. That is too expensive to put in front of EVERY
 * request, so until now only individual actions were limited and a script could
 * call any unlisted action, or read as a signed-in user, without bound.
 *
 * These bindings are in memory per Cloudflare location and cost no DO request,
 * so they can sit in front of whole routes. They are deliberately generous: they
 * stop scripts and runaway clients, not people. The exact per-action limits stay
 * where they are.
 *
 * All of them fail OPEN (missing binding locally and in tests, or a binding
 * error): a limiter outage must not take the API down. The money and OTP paths
 * keep their own fail-closed DO limits underneath.
 */
import type { Env } from "../types";
import { httpsError } from "./http";

export type EdgeLimiterName =
  | "API_ACTION_LIMITER"
  | "AUTH_IP_LIMITER"
  | "USER_READ_LIMITER"
  | "WS_CONNECT_LIMITER";

/** True when `key` is within the binding's budget (or the binding is unavailable). */
export async function edgeAllowed(env: Env, name: EdgeLimiterName, key: string): Promise<boolean> {
  const limiter = env[name];
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch (e) {
    console.error(`[edgeLimit] ${name} unavailable (failing open)`, e);
    return true;
  }
}

/** Throwing form: 429 `resource-exhausted` with a Retry-After hint. */
export async function edgeLimit(
  env: Env,
  name: EdgeLimiterName,
  key: string,
  setHeader?: (name: string, value: string) => void,
): Promise<void> {
  if (await edgeAllowed(env, name, key)) return;
  setHeader?.("Retry-After", "60");
  throw httpsError("resource-exhausted", "Too many requests. Please slow down.");
}
