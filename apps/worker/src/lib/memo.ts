/**
 * Isolate-memory cache that sits IN FRONT of Workers KV.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * The Workers free plan allows 100,000 KV reads but only 1,000 KV **writes**
 * per day. Every cache entry in this Worker is written with a TTL, so a hot
 * entry costs one write per TTL lapse — and `feed:seen` cost one write per feed
 * request outright, with no TTL gating at all.
 *
 * The result was an inverted ratio: ~17.5k reads against ~3.7k writes, i.e. the
 * read quota sat under 1% used while the write quota was exhausted in about
 * three hours by ONE person testing the app. Cloudflare then returns 429 on
 * every `put` until 00:00 UTC. A cache that costs one write per read is not a
 * cache; it is a database with a short memory.
 *
 * A KV entry is only worth its write when MANY requests share it. This module
 * is the layer that makes that true: the isolate absorbs the repeat traffic, and
 * KV is left to do the one job it is actually good at — sharing a value across
 * isolates and colos.
 *
 * ---------------------------------------------------------------------------
 * What it is safe for
 * ---------------------------------------------------------------------------
 * A Worker isolate serves many requests, so a module-level Map survives between
 * them — but it is NOT shared between isolates and cannot be invalidated from
 * another one. So the staleness window for a memoised value is `ttlSec`, even
 * after an explicit `delCache`, in every isolate except the one that ran the
 * write.
 *
 * ---------------------------------------------------------------------------
 * When to reach for this, and when a longer KV ttl is the better tool
 * ---------------------------------------------------------------------------
 * All three callers are in the feed (routes/read.ts): the impression-fatigue map
 * `feed:seen:{uid}`, the shared candidate pool `cache:matches:cand:…`, and the
 * per-viewer ranked order `cache:feedorder:{uid}:…`. The list is short on purpose,
 * because there is a specific test for whether memoising helps at all.
 *
 * A KV write happens on a cache MISS. So there are exactly two reasons a cache can
 * be expensive in writes, and only one of them is fixed by memory:
 *
 *   1. It writes per REQUEST, not per ttl. `bumpSeen` did this. Memory becomes the
 *      working copy and KV a periodic flush — a real saving, and the reason this
 *      module exists.
 *   2. Its ttl is short and it is recomputable. The candidate pool (45s) and the
 *      feed order (60s) are this. Memory removes the write entirely because
 *      nothing needs the value to survive the isolate — a miss just recomputes.
 *
 * What memory does NOT fix is a cache that must be SHARED and INVALIDATED. There,
 * the write rate is set by the ttl, so memory saves KV *reads* — which sit under 1%
 * of their quota — and saves zero writes, while costing the ability to invalidate:
 * a KV delete reaches every isolate, an in-memory copy cannot be reached at all.
 * `settings` and `cache:blocks` were both tried here and both reverted to "longer
 * KV ttl + explicit invalidation on write", because memoising them would have
 * delayed an admin config change — including the `payoutsFrozen` fraud
 * kill-switch — and lengthened the window in which a blocked user's content is
 * still served, in exchange for no write saving whatsoever.
 *
 * ---------------------------------------------------------------------------
 * What must never come through here
 * ---------------------------------------------------------------------------
 * OTP records, OTP send cooldowns, re-auth grants, the password-reset verified
 * flag, rate-limit counters, payment order intents.
 *
 * That is not a style preference. Those values are consulted to decide whether an
 * action is ALLOWED, and a per-isolate copy that cannot be invalidated would mean
 * "revoked" takes effect everywhere except where it matters. They live in `OTP_KV`,
 * in D1, or — for the rate-limit counters — in the RateLimiter Durable Object,
 * which was chosen over any cache precisely because it is strongly consistent.
 * None of them come through here.
 *
 * Callers that do memoise must keep KV as the durable copy, so a cold isolate (a
 * deploy, a new colo, an eviction) still gets a warm value.
 */

interface MemoEntry {
  value: unknown;
  /** ms since epoch. */
  expiresAt: number;
}

/**
 * Entry ceiling.
 *
 * An isolate has a hard 128 MB memory limit shared with everything else the Worker
 * does, and two of the three key families here are per-viewer — `feed:seen:{uid}`
 * and `cache:feedorder:{uid}:…` — so their COUNT is unbounded: one per active user
 * this isolate happens to serve. Without a cap a long-lived isolate under real
 * traffic accumulates them until it OOMs, which presents as random 1102s rather
 * than as a cache problem.
 *
 * Sized against the worst case rather than picked round: a fatigue map is capped at
 * 300 ids (FEED_SEEN_MAX_KEYS) and an order list at the candidate-pool size, so
 * ~15 KB per entry at the top end. 1,000 entries is therefore ~15 MB of a 128 MB
 * budget, which leaves room for the candidate pools and for request work.
 *
 * Eviction is not free for `feed:seen`: dropping an entry loses up to
 * FEED_SEEN_FLUSH_INTERVAL_MS of unflushed impressions, and the next load re-reads
 * KV and flushes immediately. So the cap is deliberately well above the number of
 * viewers a single isolate serves concurrently — the point is to bound memory, not
 * to be reached in normal operation.
 */
const MAX_ENTRIES = 1000;

const store = new Map<string, MemoEntry>();

/**
 * The value for `key`, or `undefined` on a miss or once it has expired.
 *
 * `undefined` rather than `null` is deliberate: `null` is a legitimate cached
 * value, and callers need to tell "nothing cached" apart from "cached nothing".
 */
export function memoGet<T>(key: string): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
}

/**
 * Cache `value` in isolate memory for `ttlSec`.
 *
 * The value is stored BY REFERENCE — it is not cloned, because cloning every
 * settings blob and feed pool on every request would cost more CPU than the KV
 * read this saves. Callers must therefore not mutate a value after handing it
 * over unless they intend the cached copy to change too. `bumpSeen` in
 * routes/read.ts relies on exactly that: it mutates its working copy in place
 * and re-puts, so the isolate's fatigue map stays accurate on every feed load
 * while the durable KV write stays throttled.
 */
export function memoPut(key: string, value: unknown, ttlSec: number): void {
  if (!(ttlSec > 0)) return;
  // Delete before set so the key moves to the END of the Map's insertion order.
  // That is what makes the eviction below approximate LRU instead of "whichever
  // key was written first, however hot it still is".
  store.delete(key);
  store.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 });

  if (store.size <= MAX_ENTRIES) return;
  // Expired entries first — they cost nothing to give up.
  const now = Date.now();
  for (const [k, entry] of store) {
    if (entry.expiresAt <= now) store.delete(k);
  }
  // Still over: drop from the least-recently-written end.
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/**
 * Drop keys from this isolate's copy.
 *
 * Called by `delCache` (lib/cache.ts) so that a writer never reads back its own
 * stale value. It does NOT reach other isolates — see the module comment.
 */
export function memoDelete(...keys: string[]): void {
  for (const key of keys) store.delete(key);
}

/**
 * Empty the memo.
 *
 * Exists for tests. Module state outlives a single test in the same Vitest
 * module registry, so without this a value memoised by one test would be served
 * to the next one — which builds its own fresh D1 and fresh fake KV and would
 * then be reading the previous test's data. `makeEnv()` in test/helpers/harness
 * calls this.
 */
export function memoReset(): void {
  store.clear();
}

/** Current entry count. For tests and diagnostics. */
export function memoSize(): number {
  return store.size;
}
