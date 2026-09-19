/**
 * One switch that retunes the Worker between the Cloudflare FREE tier and the
 * Workers PAID plan — WITHOUT any code change at the transition.
 *
 * ---------------------------------------------------------------------------
 * Why this module exists
 * ---------------------------------------------------------------------------
 * The whole app is already written to be free-tier-optimal: hot reads are served
 * from the Cloudflare Cache API (lib/edgeCache.ts) and isolate memory (lib/memo.ts)
 * rather than KV, because the free plan's 1,000 KV writes/day is the scarcest
 * quota by three orders of magnitude; and the feed / stories / suggestions caches
 * are edge-only so they add ZERO KV writes. None of that has to change on paid — it
 * keeps working and simply runs with far more headroom.
 *
 * There is exactly ONE lever the free tier cannot afford but the paid plan makes
 * cheap, and this module is the switch for it (and any future one like it):
 *
 *   - `cacheAuthState` — caching the per-request auth account-state lookup
 *     (`status` / `isBlocked` / `tokensValidAfter`). D1_R2_LOAD_AUDIT.md §1 calls
 *     this the single HIGHEST-COUNT query in the system: it runs on every
 *     authenticated `/read/*` and `/api` request, before any route cache. Caching
 *     it in KV removes ~1 D1 row read from every one of those requests.
 *
 *     Why it is OFF on free: a per-user key at KV's 60s floor costs ~1,440
 *     writes/day per ACTIVE user (86400 / 60). At ~1,500 users that is ~2.1M KV
 *     writes/day against a 1,000/day free budget — it would exhaust KV, the one
 *     quota the rest of the architecture bends over backwards to protect.
 *
 *     Why it is safe on paid: the Workers Paid plan raises the included KV write
 *     allowance to ~1,000,000/day, so the same ~2.1M/day is a few cents of
 *     overage rather than a hard 429 — and it buys back a D1 read on every
 *     authenticated request, plus lower latency (a KV read beats a D1 query).
 *
 * ---------------------------------------------------------------------------
 * How to flip it — the entire "go paid" procedure
 * ---------------------------------------------------------------------------
 *   1. Upgrade the Cloudflare account to the Workers Paid plan (dashboard).
 *   2. Set `SCALE_TIER = "paid"` in apps/worker/wrangler.toml `[vars]` and deploy,
 *      OR set it as a dashboard environment variable for an instant flip with no
 *      redeploy. That is the ONLY change required.
 *
 * No handler, query, migration, or client build changes. `SCALE_TIER` defaults to
 * "free", so an unset or unrecognised value is always the safe, cheap tier — a
 * typo can never accidentally incur paid-tier writes.
 *
 * ---------------------------------------------------------------------------
 * Correctness of the auth-state cache when it is ON
 * ---------------------------------------------------------------------------
 * The cached row gates moderation (blocked / deleted) and session revocation, so a
 * stale copy must never outlive those facts for long. Two things bound it:
 *
 *   - EXPLICIT invalidation. Every writer of `tokensValidAfter` funnels through
 *     `setCutoff` (lib/sessionRevocation.ts) — which covers admin block, admin
 *     "log out everywhere", and every credential-change revocation — and every
 *     writer of `isBlocked`/`status` (admin block/unblock, account anonymisation,
 *     reactivation) calls `invalidateAuthState`. A KV delete is globally visible,
 *     so a block or revoke drops the cached copy in every colo.
 *   - The TTL is only the FALLBACK. `authStateTtlSec` (60s) bounds how long any
 *     writer that forgot to invalidate could serve stale — the same "TTL is the
 *     backstop, invalidation is the mechanism" framing D1_R2_LOAD_AUDIT.md §1 uses.
 *
 * Blocking additionally closes live sockets and revokes the Firebase refresh
 * token, so the only residual is an already-minted ID token making REST calls for
 * at most `authStateTtlSec` in a colo the delete has not yet reached — bounded,
 * self-healing, and exactly the trade the audit signed off on.
 */
import type { Env } from "../types";

export type ScaleTier = "free" | "paid" | "auto";

export interface ScaleConfig {
  /** The resolved tier. `"free"` unless `SCALE_TIER` is `"paid"` or `"auto"`. */
  tier: ScaleTier;
  /**
   * Cache the per-request auth account-state in CACHE_KV instead of hitting D1 on
   * every authenticated request. Only true on the paid tier — see the module
   * comment for the KV-write-budget reasoning.
   */
  cacheAuthState: boolean;
  /**
   * TTL for the auth-state cache, in seconds. Pinned at KV's 60s floor
   * (`KV_MIN_TTL_SEC`): a smaller value cannot be honoured by the platform, and a
   * larger one only widens the fallback staleness window for a writer that failed
   * to invalidate. Only meaningful when `cacheAuthState` is true.
   */
  authStateTtlSec: number;
}

/**
 * Resolve the tier from the environment. Recognises three values; anything unset,
 * empty or unrecognised resolves to `"free"` — the tier that never attempts
 * paid-only writes, so a typo can never change behaviour unsafely.
 *
 *   "free" — direct D1 for the auth-state read. Zero extra KV writes.
 *   "paid" — cache the auth-state in KV. For accounts on the Workers Paid plan.
 *   "auto" — the SELF-ADAPTING default we deploy (see the "auto" note below).
 */
export function scaleTier(env: Env): ScaleTier {
  const v = String((env as { SCALE_TIER?: string }).SCALE_TIER ?? "").trim().toLowerCase();
  if (v === "paid") return "paid";
  if (v === "auto") return "auto";
  return "free";
}

/**
 * The full tuning profile for the current tier.
 *
 * ---------------------------------------------------------------------------
 * The `"auto"` tier — one config, both billing directions, never a manual change
 * ---------------------------------------------------------------------------
 * `"auto"` enables the auth-state cache (like `"paid"`) but is SAFE to run on the
 * FREE plan too, so the app self-adapts when you upgrade or downgrade Cloudflare
 * billing with no code, flag, or deploy change at the transition:
 *
 *   - Upgrade free -> paid:  KV writes succeed -> full auth-state caching. Optimal.
 *   - Downgrade paid -> free: once the free KV write budget is spent, the cache
 *     `put`s start failing -> `cachePutJson` swallows the error (fail-open) and the
 *     request recomputes from D1. The app keeps working; it just caches less.
 *
 * Why this is CORRECT on free, not just non-breaking: revocation/block still take
 * effect immediately, because `invalidateAuthState` is a KV DELETE (metered
 * separately from writes, with a budget nowhere near its cap), so a block or
 * logout drops the cached row in every colo even when the write budget is gone —
 * and the 60s TTL is the same backstop the paid tier already relies on.
 *
 * The one honest trade-off: on a HEAVILY loaded free plan, auth-caching consumes
 * the small (1,000/day) KV write budget that other opportunistic caches
 * (feed-seen, read caches) would otherwise use — those also fail open, so nothing
 * breaks, but D1 read load rises. That is precisely the point at which the
 * capacity monitor (CAPACITY_MONITORING.md) tells you to upgrade — which is the
 * "free now, paid later" path this whole design serves. Use explicit `"free"` if
 * you want to guarantee zero auth-cache writes on a large free deployment.
 */
export function scaleConfig(env: Env): ScaleConfig {
  const tier = scaleTier(env);
  return {
    tier,
    // Both "paid" and "auto" cache; "auto" relies on the fail-open write path to
    // stay safe on free. Only explicit "free" (or the unset default) skips it.
    cacheAuthState: tier === "paid" || tier === "auto",
    // 60s == KV_MIN_TTL_SEC. Kept in sync deliberately; a lower value would be
    // clamped up (and warned about) by cachePutJson.
    authStateTtlSec: 60,
  };
}
