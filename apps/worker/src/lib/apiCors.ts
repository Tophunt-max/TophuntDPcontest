/**
 * CORS policy for the CREDENTIALED API surface (`/api`, `/read`, `/admin`, …).
 *
 * Distinct from `lib/mediaCors.ts`, which serves public, credential-free bytes and
 * answers `*` to everyone. This surface is origin-restricted.
 *
 * It lives in its own module for the same reason `mediaCors` does: the policy has
 * to be applied in TWO places — the normal middleware path and the error path —
 * and a header that is only correct on one of them is worse than no header,
 * because the failure is invisible until a user hits an error.
 *
 * ---------------------------------------------------------------------------
 * Why the error path needs it at all
 * ---------------------------------------------------------------------------
 * `hono/cors` sets `Access-Control-Allow-Origin` AFTER `await next()`. When a
 * handler THROWS, the middleware chain unwinds past that line and the header is
 * never set. So every thrown response — 401 from `requireAuth`, 403 from the
 * `/admin` gate, 429 from the rate limiter, any 500 — reached the browser without
 * it, and a browser will not expose a cross-origin response that lacks one. The
 * admin panel and the web build therefore showed a bare
 * `TypeError: Failed to fetch` instead of "your session expired" or "slow down",
 * which reads as a network outage and sends you looking in the wrong place.
 */
import type { Env } from "../types";

/** Response headers the browser may read on an API response. */
export const API_EXPOSED_HEADERS = ["X-Next-Cursor", "X-Request-Id"] as const;

/** Request headers the browser may send. */
export const API_ALLOWED_HEADERS = ["Content-Type", "Authorization"] as const;

/**
 * Methods the API accepts.
 *
 * PUT belongs here: the admin panel saves integration config and rotates
 * credentials with PUT (`saveIntegrations`, `setIntegrationSecret`). Omitting it
 * made those calls fail preflight with a bare `TypeError: Failed to fetch`, which
 * reads like a network outage rather than a policy rejection.
 */
export const API_ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/**
 * The configured allow-list, or `["*"]` when nothing is set.
 *
 * Logs loudly on the empty case, because an unset allow-list means any site can
 * make credentialed calls to this API. Production and staging both set
 * `ALLOWED_ORIGINS` in wrangler.toml `[vars]`; this exists so a new environment
 * that forgets cannot do so silently. It deliberately does NOT hard-fail —
 * refusing every cross-origin request would take a working deployment down over a
 * config omission, which is a worse outcome than a loud log line.
 */
export function allowedOrigins(env: Pick<Env, "ALLOWED_ORIGINS">): string[] {
  const raw = (env.ALLOWED_ORIGINS || "").trim();
  if (!raw) {
    console.error(
      "[cors] ALLOWED_ORIGINS is not set — defaulting to '*'. Set it to the app and admin origins.",
    );
    return ["*"];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when the allow-list is the wildcard (no origin restriction). */
export function isWildcardPolicy(origins: string[]): boolean {
  return origins.length === 1 && origins[0] === "*";
}

/**
 * The `Access-Control-Allow-Origin` value for this request, or null when the
 * request's origin is not allowed (or it sent no `Origin` header at all).
 *
 * Mirrors what `hono/cors` decides, so the error path cannot drift from the happy
 * path — the whole point of having one function.
 */
export function resolveApiCorsOrigin(
  env: Pick<Env, "ALLOWED_ORIGINS">,
  requestOrigin: string | undefined | null,
): string | null {
  const origins = allowedOrigins(env);
  if (isWildcardPolicy(origins)) return "*";
  return requestOrigin && origins.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * Apply the policy to a response that is being returned OUTSIDE the cors
 * middleware — i.e. from `app.onError`.
 *
 * A no-op when the origin is not allowed: omitting the header is what correctly
 * denies a disallowed origin, so there is nothing to add in that case.
 */
export function applyApiCorsHeaders(
  headers: { set: (name: string, value: string) => void },
  env: Pick<Env, "ALLOWED_ORIGINS">,
  requestOrigin: string | undefined | null,
): boolean {
  const origin = resolveApiCorsOrigin(env, requestOrigin);
  if (!origin) return false;
  headers.set("Access-Control-Allow-Origin", origin);
  // Required whenever the value is origin-dependent, or a shared cache can serve
  // one origin's response to another.
  if (origin !== "*") headers.set("Vary", "Origin");
  headers.set("Access-Control-Expose-Headers", API_EXPOSED_HEADERS.join(", "));
  return true;
}
