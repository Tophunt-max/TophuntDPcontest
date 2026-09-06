/**
 * Thin client for the RateLimiter Durable Object (one instance per SUBJECT).
 *
 * Purpose: throttle abusive bursts on write actions (votes, likes, comments) so
 * bots can't flood the app — which also protects D1 from junk writes — and cap
 * the endpoints where a burst costs real money.
 *
 * This used to count in `CACHE_KV`, and the note here used to concede that "KV is
 * eventually consistent, so the limit is approximate under heavy concurrency (a
 * few extra requests may slip through) ... for strict per-user limits a dedicated
 * Durable Object would be the next step." That is now what this is.
 *
 * Two things changed by moving:
 *
 *   - The limit is EXACT for a given subject. A read-then-write against an
 *     eventually-consistent store is not a counter: concurrent requests read the
 *     same value and each write value+1, so N simultaneous attempts spend one unit
 *     of budget. The drift grew with concurrency, which is backwards for a
 *     mechanism whose whole job is bursts. The actor serializes every request for
 *     a subject, so check-and-increment is atomic.
 *   - It no longer competes with the caches for the free plan's 1,000 KV
 *     writes/day. Durable Objects allow 100,000 requests and 100,000 rows written
 *     per day. Rate limiting cannot be given a longer ttl or switched off to save
 *     writes the way a cache can, so it needed the store with headroom.
 *
 * The exported surface is unchanged, so no call site needed to move.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import type { LimitSpec } from "../rateLimiter";

/**
 * Consume one unit from `key`'s budget and report whether it was allowed.
 *
 * Non-throwing counterpart to `rateLimit`, for callers that want to DEGRADE
 * rather than fail — e.g. suppressing a push notification while still writing
 * the in-app row. Fails OPEN (returns true) on any KV error, matching
 * `rateLimit`'s trade-off.
 */
export interface RateLimitOptions {
  /**
   * Reject instead of allowing when the counter cannot be read.
   *
   * The default (fail OPEN) is right for engagement throttles — a KV blip must
   * not stop people using the app. It is the WRONG default for endpoints where
   * an unlimited burst has a real cost or is a money/abuse risk: payouts, OTP
   * sends, uploads, credential probing. For those, an outage that removes all
   * throttling is worse than a brief refusal, so they opt into fail-closed.
   */
  failClosed?: boolean;
}

export async function consumeRateLimit(
  env: Env,
  key: string,
  max: number,
  windowSec: number,
  options: RateLimitOptions = {},
): Promise<boolean> {
  // NOTE: `KV_WRITES_DISABLED` does not reach this path, and now cannot: the
  // counters are not in KV at all. That flag once skipped every counter without
  // `failClosed: true`, on the reasoning that those are "just" engagement
  // throttles. It was wrong — `failClosed` means "refuse if the counter is
  // unreadable", NOT "this guard protects money", and several throttles that do
  // guard money or real spend are fail-open by omission: `deposit:{uid}`,
  // `ad:{uid}` (mints withdrawable coins), `vidup:{uid}` (Bunny transcode spend),
  // `create:{ip}` (the only per-IP signup limit, and signup grants a bonus
  // balance) and `exportdata:{uid}` (PII export).
  return consumeMany(env, [{ key, max, windowSec }], options);
}

/**
 * Which DO instance owns `key`.
 *
 * Keys are `{action}:{subject}` — `vote:uid123`, `vote:ip:1.2.3.4`,
 * `otpsend_num:+9198…`, `emailchange_to:someone@example.com`. Everything after the
 * FIRST colon is the subject, and the subject is the owner.
 *
 * Sharding this way rather than per-key is deliberate. It puts every limit that
 * throttles the same person on one serialized actor, so a user's hourly and daily
 * upload caps cannot disagree with each other; and it keeps unrelated subjects off
 * each other's actor, which matters because an individual Durable Object has a
 * soft ceiling near 1,000 requests/second — sharding by subject makes that a
 * per-user ceiling instead of a global one.
 *
 * A key with no colon (or nothing after it) is its own shard. No current key looks
 * like that, but a future one that did would otherwise land every subject on a
 * single actor, which is the one failure mode here worth being defensive about.
 */
function shardFor(key: string): string {
  const i = key.indexOf(":");
  if (i === -1) return key;
  const subject = key.slice(i + 1);
  return subject.length > 0 ? subject : key;
}

/**
 * Consume one or more limits and report whether ALL of them had budget.
 *
 * Every RPC method call is billed as one Durable Object request, so specs that
 * share a subject are sent together: a path checking three limits for one user
 * costs one request rather than three.
 *
 * Specs are GROUPED BY SHARD rather than assumed to share one. A counter only
 * means anything on the actor that owns its subject, so sending `upload:alice` and
 * `upload_ip:1.2.3.4` to a single actor would count the IP's usage on alice's
 * object — a limit that silently applies to the wrong subject, which is worse than
 * no limit because it looks like it works. Grouping makes that unrepresentable
 * instead of leaving it to a comment.
 *
 * Order is preserved across groups so the "stop at the first denial" contract
 * still holds for the caller.
 */
async function consumeMany(
  env: Env,
  specs: LimitSpec[],
  options: RateLimitOptions,
): Promise<boolean> {
  if (specs.length === 0) return true;
  try {
    const ns = env.RATE_LIMITER;
    if (!ns) throw new Error("RATE_LIMITER binding is not configured");

    // Preserve declaration order of the groups themselves, so which limit trips
    // first stays deterministic.
    const groups = new Map<string, LimitSpec[]>();
    for (const spec of specs) {
      const shard = shardFor(spec.key);
      const existing = groups.get(shard);
      if (existing) existing.push(spec);
      else groups.set(shard, [spec]);
    }

    for (const [shard, group] of groups) {
      const { allowed } = await ns.get(ns.idFromName(shard)).consume(group);
      if (!allowed) return false;
    }
    return true;
  } catch (e) {
    // Unchanged policy from the KV implementation: an unreachable counter is a
    // cache miss for engagement throttles and a refusal for anything where an
    // unlimited burst has a real cost.
    //
    // Known limitation, recorded rather than papered over: the set of failures
    // reaching here is WIDER than it was with KV. Alongside transport blips there is
    // now per-object overload (an individual DO has a soft ceiling near 1,000
    // req/s), the account's daily DO quota, and eviction of in-flight RPCs while a
    // new version is being deployed. For a fail-OPEN key that means a burst
    // concentrated on one subject can push its own actor over the ceiling and be
    // allowed through — the limiter shedding load in exactly the case it exists for.
    // Not mitigated here because the runtime does not distinguish "overloaded" from
    // "unavailable" in a way that is safe to branch on, and guessing wrong would
    // convert transient errors into user-visible refusals. It is far above this
    // application's traffic; if it ever becomes reachable the fix is a second tier
    // in front (Cloudflare WAF rate-limiting rules), not error-string sniffing.
    if (options.failClosed) {
      console.error("[rateLimit] limiter unavailable (failing CLOSED)", specs[0]?.key, e);
      return false;
    }
    console.error("[rateLimit] limiter unavailable (failing open)", specs[0]?.key, e);
    return true;
  }
}

/**
 * Allow at most `max` events per `windowSec` for `key`. Throws a
 * `resource-exhausted` HttpsError when the limit is exceeded.
 */
export async function rateLimit(
  env: Env,
  key: string,
  max: number,
  windowSec: number,
  options: RateLimitOptions = {},
): Promise<void> {
  if (!(await consumeRateLimit(env, key, max, windowSec, options))) {
    throw httpsError("resource-exhausted", "Too many requests. Please slow down.");
  }
}

export type { LimitSpec } from "../rateLimiter";

/**
 * Consume SEVERAL limits at once, returning false if any is over.
 *
 * Use this wherever a path checks more than one limit. Every RPC method call is
 * billed as one Durable Object request, and the free tier allows 100,000 a day
 * shared with RealtimeHub and VoteCounter — so on the paths that check three
 * limits, three separate `rateLimit` calls cost three times what one call does.
 * `consumeMany` groups the specs by subject, so limits on different subjects still
 * go to the right actor; a group is one request.
 *
 * Semantics match the sequential calls this replaces: specs are consumed in order
 * and the walk stops at the first denial, without refunding what came before.
 */
export async function consumeRateLimitAll(
  env: Env,
  specs: LimitSpec[],
  options: RateLimitOptions = {},
): Promise<boolean> {
  return consumeMany(env, specs, options);
}

/** Throwing counterpart of `consumeRateLimitAll`. */
export async function rateLimitAll(
  env: Env,
  specs: LimitSpec[],
  options: RateLimitOptions = {},
): Promise<void> {
  if (!(await consumeMany(env, specs, options))) {
    throw httpsError("resource-exhausted", "Too many requests. Please slow down.");
  }
}

// ---------------------------------------------------------------------------
// OTP-send abuse controls (added for auth hardening).
//
// `rateLimit` above is a coarse burst cap. For OTP *sends* we additionally want
// a strict per-recipient cooldown, because each send costs real money (Twilio
// SMS / Resend email) and is the main abuse vector. These live in OTP_KV
// alongside the OTP records themselves.
// ---------------------------------------------------------------------------

const cdKey = (scope: string, id: string) => `otpcd:${scope}:${id}`;

/**
 * Refuse to send another OTP to the same destination within `cooldownSec`.
 * Throws `resource-exhausted` when a code was sent too recently. The caller
 * records a successful send via `markSent`.
 */
export async function enforceSendCooldown(
  env: Env,
  scope: string,
  id: string,
  cooldownSec: number,
): Promise<void> {
  const existing = await env.OTP_KV.get(cdKey(scope, id));
  if (existing) {
    throw httpsError(
      "resource-exhausted",
      `Please wait ${cooldownSec}s before requesting another code.`,
    );
  }
}

/** Record that an OTP was just sent to `id`, starting its cooldown window. */
export async function markSent(
  env: Env,
  scope: string,
  id: string,
  cooldownSec: number,
): Promise<void> {
  await env.OTP_KV.put(cdKey(scope, id), "1", { expirationTtl: cooldownSec });
}

/**
 * Cancel a cooldown, for a send that turned out not to have happened.
 *
 * The cooldown has to be recorded BEFORE the provider call — otherwise two
 * concurrent requests both pass the check and both pay for an SMS. But that means
 * a failed delivery leaves a cooldown protecting nothing, and the user is told to
 * wait 60 seconds for a code that was never sent. Callers that report the failure
 * honestly should clear it so the retry is immediate.
 */
export async function clearSendCooldown(env: Env, scope: string, id: string): Promise<void> {
  await env.OTP_KV.delete(cdKey(scope, id)).catch((e) =>
    console.error("[rateLimit] cooldown clear failed", scope, id, e),
  );
}

/** Best-effort client IP for keying anonymous (pre-login) rate limits. */
export function clientIp(headers: Headers): string {
  return (
    headers.get("CF-Connecting-IP") ||
    headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}
