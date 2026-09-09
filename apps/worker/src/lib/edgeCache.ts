/**
 * The Cloudflare Cache API layer — the app's PRIMARY read cache.
 *
 * ---------------------------------------------------------------------------
 * Why this module exists, and why KV is no longer under most of it
 * ---------------------------------------------------------------------------
 * The read caches used to be "Cache API in front of Workers KV" everywhere, on the
 * reasoning that the edge tier is an accelerator and KV is the durable, globally
 * invalidatable tier beneath it. That reasoning is sound, but it was paired with a
 * cost model that turned out to be wrong, and the wrong half is the one that
 * exhausted the account's KV quota:
 *
 *   AN EDGE TIER SAVES KV *READS*. IT SAVES ALMOST NO KV *WRITES*.
 *
 * A KV write happens when both tiers miss, and a KV entry's lifetime is set by its
 * own TTL — not by the edge TTL. So writes land at roughly `86400 / kvTtl` per key
 * per day no matter how effective the edge tier is. Combined with the platform's
 * 60-second minimum TTL (see `KV_MIN_TTL_SEC` in lib/cache.ts), the write FLOOR for
 * any continuously-read KV cache key is 1,440/day — while the free plan allows
 * 1,000/day for the entire Worker. One hot key was therefore over budget on its own,
 * which is why raising TTLs and throttling `feed:seen` did not fix the quota.
 *
 * lib/memo.ts already recorded the same asymmetry for the isolate tier: "the write
 * rate is set by the ttl, so memory saves KV *reads* ... and saves zero writes".
 * This module is that lesson applied to the edge tier.
 *
 * ---------------------------------------------------------------------------
 * The rule for choosing a tier
 * ---------------------------------------------------------------------------
 * Pass `kvTtlSec` — i.e. keep the durable tier — ONLY when a stale entry has a
 * consequence that a short TTL does not adequately bound, because a KV delete is
 * the one invalidation that reaches every colo. In practice that means editorial
 * takedowns: an unpublished or deleted blog post must stop being served promptly,
 * and the Cache API cannot be purged outside the colo running the code.
 *
 * Omit `kvTtlSec` — edge only — when the value is a pure function of D1 that a miss
 * simply recomputes, or when the freshness requirement is below KV's 60s floor
 * (in which case KV cannot honour it anyway and only adds cost and staleness).
 *
 * ---------------------------------------------------------------------------
 * What edge-only costs, stated plainly
 * ---------------------------------------------------------------------------
 * The Cache API only does real work for a Worker on a CUSTOM DOMAIN. Production
 * traffic is on `api.tophunt.in`, where it is live. App builds predating that
 * custom domain still call the `*.workers.dev` host (see `R2_LEGACY_BASE_URLS` in
 * wrangler.toml), and for those clients an edge-only endpoint has NO shared cache:
 * every request recomputes from D1.
 *
 * That is a deliberate, bounded trade. The affected queries are indexed and small
 * (a page of at most 100 battles, a leaderboard of at most 100 rows, a user by
 * primary key, at most 51 comments), D1's free allowance is measured in millions of
 * rows read per day, and the population on that host only shrinks. It is the same
 * trade routes/read.ts already made when the feed candidate pool and per-viewer
 * order moved to isolate memory: "D1's free allowance is measured in millions of
 * rows a day ... while KV writes are the scarce resource by three orders of
 * magnitude."
 *
 * If legacy-host D1 load ever does become a concern, the answer is an isolate memo
 * tier (lib/memo.ts) in front of the loader — NOT a return to KV, which is the one
 * option the quota rules out.
 */
import type { Env } from "../types";
import {
  cacheGetJson,
  cachePutJson,
  contestDetailCacheKey,
  contestListCacheKeys,
  delCache,
  kvWritesDisabled,
} from "./cache";

/**
 * The slice of a Hono context this module needs.
 *
 * Declared structurally so the purge helpers can be called from any route
 * (routes/api.ts, routes/admin.ts) as well as from lib code holding a context —
 * and so a caller with no request at all (the cron sweep) is a compile-time
 * visible `undefined` rather than a runtime crash.
 */
export interface EdgeCtx {
  req: { url: string };
  env: Env;
  executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * The colo's shared cache, or null where the Cache API is unavailable.
 *
 * `caches` is a runtime-provided global. Reading `.default` from outside a try
 * meant any runtime without the Cache API threw a ReferenceError and 500'd the
 * endpoint — the exact opposite of fail-open — so the access belongs inside one.
 */
export function defaultCache(): Cache | null {
  try {
    return ((caches as any)?.default as Cache) ?? null;
  } catch {
    return null;
  }
}

/**
 * Cache-API key for a LOGICAL cache entry.
 *
 * Same origin, because the Cache API is per-zone and the host has to stay ours,
 * but a reserved path with the cache key as the only query parameter.
 *
 * Deriving the edge key from the same string the KV tier would use is the whole
 * point: the two tiers can never disagree about what they hold, and — now that the
 * invalidators live in other files — a writer purging a colo entry cannot drift
 * from the reader that produced it. A stale-cache bug is usually a key-mismatch
 * bug, so there is exactly one function that builds this.
 */
export function logicalEdgeKey(c: EdgeCtx, key: string): Request {
  const u = new URL(c.req.url);
  u.pathname = "/__edge";
  u.search = `?k=${encodeURIComponent(key)}`;
  return new Request(u.toString(), { method: "GET" });
}

/**
 * Cache-API key for a whole-RESPONSE entry, keyed on a normalised url.
 *
 * `params` is an explicit allow-list of the query parameters that actually change
 * the payload, and everything else in the request url is dropped. That is a
 * deliberate difference from keying on the raw url, which is what this used to do:
 * `/read/app-config` takes no parameters at all, so `?x=1`, `?x=2`, … each minted a
 * separate colo entry for a byte-identical response. Unbounded, attacker-controlled
 * cache keys on an unauthenticated endpoint are a cache-flooding lever — cheap to
 * pull and capable of evicting the entries that matter — and the allow-list removes
 * it without changing a single response body.
 */
export function urlEdgeKey(
  c: EdgeCtx,
  pathname: string,
  params?: Record<string, string | number | null | undefined>,
): Request {
  const u = new URL(c.req.url);
  u.pathname = pathname;
  u.search = "";
  if (params) {
    // Sorted so two requests that differ only in parameter ORDER share one entry.
    for (const name of Object.keys(params).sort()) {
      const value = params[name];
      if (value === null || value === undefined || value === "") continue;
      u.searchParams.set(name, String(value));
    }
  }
  return new Request(u.toString(), { method: "GET" });
}

/**
 * Store a payload in the colo cache. Best-effort; never delays the response.
 *
 * Honours the `KV_WRITES_DISABLED` kill switch even though nothing here touches KV:
 * that flag's contract is "every cache read misses and the value is recomputed from
 * D1", and letting the edge tier write through would leave a test deployment
 * serving cached data from every endpoint in this module.
 */
function edgeStore(c: EdgeCtx, cache: Cache, cacheKey: Request, data: unknown, ttlSec: number): void {
  if (kvWritesDisabled(c.env)) return;
  try {
    const res = new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        // The Cache API honours Cache-Control on the response handed to put(), so
        // this IS the edge ttl.
        "Cache-Control": `public, max-age=${ttlSec}`,
      },
    });
    // `.catch` on the promise as well as the try/catch: the try only covers a
    // synchronous throw, and an unhandled rejection from inside waitUntil is
    // reported as a request failure.
    const put = cache.put(cacheKey, res).catch(() => {});
    if (c.executionCtx) c.executionCtx.waitUntil(put);
  } catch {
    /* best-effort */
  }
}

/**
 * Drop LOGICAL entries from THIS COLO's cache. Best-effort and fire-and-forget.
 *
 * Read the scope carefully, because it is the sharp edge of an edge-only cache:
 * `cache.delete()` only affects the colo running the code. An entry written in
 * Mumbai still exists in Singapore, and purge-by-tag is an Enterprise feature. So
 * this makes a writer's own colo consistent immediately — which is the colo the
 * person who just made the change is almost always served from — and every other
 * colo converges when the (deliberately short) TTL lapses.
 *
 * It is therefore an improvement on the tail, never a correctness guarantee. Any
 * cache that needs a real global purge must keep a KV tier; see the module comment.
 *
 * A missing context (the cron sweep has no request, so no origin and no
 * `waitUntil`) is a silent no-op rather than a throw: cron-driven invalidation
 * relies on TTL expiry at the edge, and an invalidator must never be able to fail
 * the write it follows.
 */
export function edgePurge(c: EdgeCtx | undefined, ...keys: string[]): void {
  if (!c || keys.length === 0) return;
  const cache = defaultCache();
  if (!cache) return;
  for (const key of keys) {
    try {
      const p = cache.delete(logicalEdgeKey(c, key)).catch(() => {});
      if (c.executionCtx) c.executionCtx.waitUntil(p);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Colo-local purge for a whole-RESPONSE entry. Same scope caveats as `edgePurge`.
 *
 * Params must match the allow-list the reader passed to `urlEdgeKey`, or the key
 * will not match — which is precisely why both sides now go through one builder
 * instead of the hand-rolled `new URL(c.req.url)` this replaces in routes/admin.ts.
 */
export function edgePurgeUrl(
  c: EdgeCtx | undefined,
  pathname: string,
  params?: Record<string, string | number | null | undefined>,
): void {
  if (!c) return;
  const cache = defaultCache();
  if (!cache) return;
  try {
    const p = cache.delete(urlEdgeKey(c, pathname, params)).catch(() => {});
    if (c.executionCtx) c.executionCtx.waitUntil(p);
  } catch {
    /* best-effort */
  }
}

/**
 * Invalidate shared read caches for `keys` after a write — the call every mutating
 * handler should use.
 *
 * Does BOTH tiers, and deliberately keeps the KV delete even though the read caches
 * are edge-only now:
 *
 *  - `edgePurge` makes the writer's own colo consistent immediately. That is the
 *    colo serving the person who just made the change, which is what turns "I saved
 *    my profile and it still shows the old name" into a non-event.
 *
 *  - `delCache` is belt-and-braces for ROLLOUT, and for the keys that genuinely
 *    still live in KV. A Cloudflare deploy is not atomic across colos, so for a
 *    short window after this ships an isolate still running the previous build will
 *    read `cache:user:*` / `cache:comments:*` / … from KV. Without the delete, that
 *    isolate would keep serving a value this request just invalidated. It also costs
 *    almost nothing: deletes are metered separately from writes and the daily delete
 *    quota is nowhere near its limit.
 *
 * Once no build that reads those keys from KV is running, the `delCache` here
 * becomes dead weight for the edge-only keys and can go — but it must stay for
 * `settings:*`, `cache:blocks:*` and `feed:seen:*`, which are still KV-backed and
 * are invalidated through their own helpers rather than this one.
 *
 * Accepts either a request context or a bare `Env`, so that a writer reached from
 * BOTH a request and the cron sweep has one call form rather than a branch at every
 * site. With a context the colo purge runs; with only an `Env` it cannot (there is no
 * origin to build a key from) and the edge tier converges on its TTL instead. Callers
 * that can obtain a context should always pass one — `purgeShared(c ?? env, …)` is the
 * idiomatic form for a function whose own context is optional.
 */
export async function purgeShared(source: EdgeCtx | Env, ...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  // `req` is the discriminator: an `Env` is a bag of bindings and has no request.
  const c = "req" in source ? (source as EdgeCtx) : undefined;
  const env = c ? c.env : (source as Env);
  edgePurge(c, ...keys);
  await delCache(env, ...keys);
}

/**
 * Drop every public cache entry a contest write can invalidate.
 *
 * Lives in one place because there are three writers — the admin CRUD routes, the
 * `createContest` action, and the cron sweep that ends expired templates — and a
 * second copy of this key list is how one of them ends up forgetting a key and
 * serving a contest the app should no longer show.
 *
 * `c` is OPTIONAL because the cron sweep has no request, and therefore no origin to
 * build an edge key from and no `waitUntil` to run the purge in. Cron-driven
 * invalidation relies on the (60s) edge TTL instead; a caller that HAS a context
 * should always pass it, so the colo serving the admin who just made the change is
 * consistent on their next read.
 */
export async function invalidateContestCaches(
  env: Env,
  id?: string | string[],
  c?: EdgeCtx,
): Promise<void> {
  const ids = id === undefined ? [] : Array.isArray(id) ? id : [id];
  // The three list keys are shared by every contest, so they are collected once
  // rather than re-purged per id — a batch of 200 expiries would otherwise spend
  // 600 redundant operations.
  const keys = [...contestListCacheKeys(), ...ids.map(contestDetailCacheKey)];
  edgePurge(c, ...keys);
  await delCache(env, ...keys);
}

export interface CachedJsonOptions<T> {
  /** Logical cache key. Must contain every parameter that changes the payload. */
  key: string;
  /** Colo cache lifetime. 0 disables the edge tier. */
  edgeTtlSec: number;
  /**
   * Durable KV lifetime. OMIT (or pass null) for edge-only — see the module
   * comment for the rule.
   *
   * Must be >= `KV_MIN_TTL_SEC`; a smaller value cannot be honoured by the platform
   * and is clamped up (with a warning) by `cachePutJson`.
   */
  kvTtlSec?: number | null;
  load: () => Promise<T>;
  /**
   * Return true to serve this value without caching it in either tier.
   *
   * Exists for negative results on a key space the CALLER controls. `/blog/:slug`
   * takes its key straight from the url on an unauthenticated, unthrottled
   * endpoint, so caching not-found would mint one entry per novel slug — and while
   * that is merely wasteful at the edge, on the KV tier it is one write per slug
   * against a 1,000/day budget for the whole Worker. A script walking a thousand
   * made-up slugs would stop every cache in the app from writing for the day.
   */
  skipCache?: (data: T) => boolean;
}

/**
 * Read-through cache returning the DATA, not a Response.
 *
 * That distinction is load-bearing. `cachedResponse` below returns the cached
 * Response and so returns from the handler early, which silently skips everything
 * the handler would otherwise do — INCLUDING PER-VIEWER AUTHORIZATION. Every
 * endpoint using this helper layers a per-viewer pass onto a shared payload:
 * `/matches` applies the viewer's block filter and hydrates their vote state,
 * `/leaderboard` and `/users/:id/followers` drop blocked accounts, `/users/:id`
 * filters the target's following list and adds `isMutedByMe`, `/comments` drops
 * blocked authors and layers `likedByMe`. A response-level cache on any of those
 * would either skip the pass or bake one viewer's exclusions into an entry every
 * other viewer then reads. Handing back data keeps the pass running, and
 * test/edgeCache.test.ts asserts exactly that.
 *
 * The loader must not resolve to `null` — a cached `null` is indistinguishable from
 * a miss. Wrap it, as `/contests/:id` does with `{ contest }`.
 */
export async function cachedJson<T>(c: any, opts: CachedJsonOptions<T>): Promise<T> {
  const { key, edgeTtlSec, kvTtlSec, load, skipCache } = opts;
  const cache = edgeTtlSec > 0 ? defaultCache() : null;
  const cacheKey = cache ? logicalEdgeKey(c, key) : null;

  if (cache && cacheKey) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return (await hit.json()) as T;
    } catch {
      /* cache unavailable or unparseable — fall through */
    }
  }

  // The durable tier is consulted only when the caller asked for one. For an
  // edge-only entry this is where a KV read used to happen on every colo miss.
  if (kvTtlSec != null) {
    const fromKv = await cacheGetJson<T>(c.env, key);
    if (fromKv !== null && fromKv !== undefined) {
      if (cache && cacheKey) edgeStore(c, cache, cacheKey, fromKv, edgeTtlSec);
      return fromKv;
    }
  }

  const data = await load();
  if (skipCache?.(data)) return data;
  if (kvTtlSec != null) await cachePutJson(c.env, key, data, kvTtlSec);
  if (cache && cacheKey) edgeStore(c, cache, cacheKey, data, edgeTtlSec);
  return data;
}

/**
 * Edge-cache a fully-public (user-agnostic) JSON GET at the colo.
 *
 * On a hit the Worker returns immediately without touching D1 or KV. Only use for
 * responses that are identical for every caller AND need no per-viewer pass at all;
 * otherwise use `cachedJson` above.
 *
 * `varyParams` names the query parameters that change the payload — see
 * `urlEdgeKey` for why an allow-list rather than the raw url.
 */
export async function cachedResponse<T>(
  c: any,
  ttlSec: number,
  producer: () => Promise<T>,
  opts: {
    /**
     * Query parameters that affect the payload, ALREADY NORMALISED.
     *
     * Pass the same clamped/parsed values the producer uses, not the raw query
     * strings: `?limit=abc` and `?limit=99999` both collapse to the same payload,
     * so keying on the raw text would mint a distinct entry per spelling and hand
     * an unauthenticated caller an unbounded supply of cache keys.
     */
    varyParams?: Record<string, string | number | null | undefined>;
    /** Defaults to the request's own path. */
    pathname?: string;
  } = {},
): Promise<Response> {
  const { varyParams } = opts;
  const pathname = opts.pathname ?? new URL(c.req.url).pathname;
  const cache = defaultCache();
  const cacheKey = urlEdgeKey(c, pathname, varyParams);
  try {
    const hit = cache ? await cache.match(cacheKey) : null;
    if (hit) return hit;
  } catch {
    /* cache unavailable — fall through */
  }
  const data = await producer();
  const res = c.json(data) as Response;
  res.headers.set("Cache-Control", `public, max-age=${ttlSec}`);
  try {
    // Honours the kill switch for the same reason `edgeStore` does.
    if (cache && !kvWritesDisabled(c.env)) {
      const put = cache.put(cacheKey, res.clone()).catch(() => {});
      if (c.executionCtx) c.executionCtx.waitUntil(put);
    }
  } catch {
    /* best-effort */
  }
  return res;
}
