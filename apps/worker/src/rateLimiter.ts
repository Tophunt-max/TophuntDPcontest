/**
 * RateLimiter — one Durable Object per rate-limited SUBJECT (a uid, an IP, a
 * phone number, an email address).
 *
 * ---------------------------------------------------------------------------
 * Why this is a Durable Object and not KV
 * ---------------------------------------------------------------------------
 * The previous implementation counted in `CACHE_KV` with a read-then-write, and
 * lib/rateLimit.ts said so plainly: "KV is eventually consistent, so the limit is
 * approximate under heavy concurrency (a few extra requests may slip through) ...
 * For strict per-user limits a dedicated Durable Object would be the next step."
 * Two separate problems with that, and this actor fixes both.
 *
 *   1. CORRECTNESS. Read-then-write on an eventually-consistent store is not a
 *      counter. Concurrent requests read the same value and each write value+1,
 *      so N simultaneous attempts consume ONE unit of budget. The looser the
 *      concurrency, the further the real limit drifts above the configured one —
 *      exactly backwards, because bursts are what a limiter exists to stop. A
 *      Durable Object serializes every request to the same subject, so
 *      check-and-increment is atomic and `max` means `max`.
 *
 *   2. COST. Every check cost one KV write against a free-plan budget of 1,000
 *      per DAY for the entire Worker, shared with every cache in the app. Durable
 *      Object free limits are 100,000 requests and 100,000 rows written per day —
 *      two orders of magnitude more headroom for the same work — and unlike the
 *      caches, rate limiting is not something that can be given a longer ttl or
 *      switched off to save writes.
 *
 * ---------------------------------------------------------------------------
 * Addressing: one actor per subject, not per key
 * ---------------------------------------------------------------------------
 * Keys are `{action}:{subject}` — `vote:uid123`, `vote:ip:1.2.3.4`,
 * `otpsend_num:+9198…`. The client (lib/rateLimit.ts) addresses this class by the
 * SUBJECT, so every limit throttling the same person lands on the same actor.
 * That choice matters twice over:
 *
 *   - It is what makes the guarantee meaningful. A user's hourly and daily upload
 *     caps are enforced by one serialized actor, so they cannot disagree.
 *   - It keeps unrelated subjects off each other's actor. An individual Durable
 *     Object has a soft ceiling around 1,000 requests/second; sharding by subject
 *     means that ceiling is per-user rather than global, which a single shared
 *     "limiter" object would not give.
 *
 * Several keys for one subject can be consumed in a single `consume()` call, so a
 * path with three limits costs one billed DO request rather than three.
 *
 * ---------------------------------------------------------------------------
 * Trust boundary
 * ---------------------------------------------------------------------------
 * Like VoteCounter and RealtimeHub, this actor trusts its caller. The Worker has
 * already authenticated the request and derived the key; nothing here re-checks
 * who the caller is.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";
import { normalizeSpec, windowExpiresAt, windowIdFor } from "./lib/rateLimitWindow";
import {
  RATE_LIMIT_DDL,
  SQL_CONSUME,
  SQL_NEXT_EXPIRY,
  SQL_PRUNE,
  SQL_RESET,
  SQL_SELECT_COUNT,
} from "./lib/rateLimitSql";

/** One limit to consume: at most `max` events per `windowSec` for `key`. */
export interface LimitSpec {
  key: string;
  max: number;
  windowSec: number;
}

export interface ConsumeResult {
  /** True when every spec had budget left. */
  allowed: boolean;
  /** The first key that was over its limit, or null when allowed. */
  deniedKey: string | null;
}

/**
 * Extra time a counter row is kept past its window's end before pruning.
 *
 * Not cosmetic: a row deleted the instant its window closes would be re-created
 * by any request still in flight for that window, and the alarm that does the
 * pruning is itself scheduled approximately. The grace period costs a few bytes
 * and removes a class of race from the cleanup path.
 */
const PRUNE_GRACE_MS = 60_000;

export class RateLimiter extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Local (DO-owned) SQLite schema. Idempotent, cheap. The DDL and every
    // statement below live in lib/rateLimitSql.ts so the Node test suite can run
    // the same SQL against node:sqlite — see that module's header.
    for (const stmt of RATE_LIMIT_DDL) this.sql.exec(stmt);
  }

  // ============================ RPC methods ================================

  /**
   * Consume one unit from each spec's budget, in order, and report the verdict.
   *
   * Semantics are deliberately identical to the sequential
   * `await rateLimit(a); await rateLimit(b);` calls this replaced: specs are
   * consumed left to right and the walk STOPS at the first one that is over. So a
   * later denial does not refund an earlier consumption.
   *
   * That is not the tidiest possible contract — all-or-nothing would be — but it
   * is the one the call sites were already written against, and quietly changing
   * when a budget is spent would change which limit trips first on the paths that
   * check several (uploads, OTP sends, identifier changes). Preserve it.
   *
   * The whole method runs inside the actor's single-threaded execution, so it is
   * atomic with respect to every other request for this subject.
   */
  async consume(specs: LimitSpec[]): Promise<ConsumeResult> {
    if (!Array.isArray(specs) || specs.length === 0) return { allowed: true, deniedKey: null };

    const now = Date.now();
    let deniedKey: string | null = null;
    let earliestExpiry = 0;

    for (const raw of specs) {
      const key = String(raw?.key ?? "");
      if (!key) continue;
      const { max, windowSec } = normalizeSpec(raw?.max, raw?.windowSec);
      // A max of 0 can never be satisfied. Report it rather than writing a row
      // that will never be under its limit.
      if (max === 0) {
        deniedKey = key;
        break;
      }

      const windowId = windowIdFor(now, windowSec);
      const expiresAt = windowExpiresAt(windowId, windowSec);

      const rows = this.sql
        .exec(SQL_SELECT_COUNT, key, windowId)
        .toArray() as Array<{ count: number }>;
      const current = rows.length > 0 ? Number(rows[0].count) || 0 : 0;
      if (current >= max) {
        deniedKey = key;
        break;
      }

      this.sql.exec(SQL_CONSUME, key, windowId, expiresAt);
      // Earliest expiry, so the pruner is armed for the first row that dies rather
      // than the last — see SQL_NEXT_EXPIRY for why that matters.
      if (earliestExpiry === 0 || expiresAt < earliestExpiry) earliestExpiry = expiresAt;
    }

    if (earliestExpiry > 0) await this.scheduleCleanup(earliestExpiry);
    return { allowed: deniedKey === null, deniedKey };
  }

  /**
   * Current usage for a key, without consuming. For diagnostics and the admin
   * health surface — never call this to make a decision, because reading and then
   * acting on the result reintroduces exactly the race `consume` exists to close.
   */
  async peek(key: string, windowSec: number): Promise<number> {
    const norm = normalizeSpec(0, windowSec);
    const rows = this.sql
      .exec(SQL_SELECT_COUNT, key, windowIdFor(Date.now(), norm.windowSec))
      .toArray() as Array<{ count: number }>;
    return rows.length > 0 ? Number(rows[0].count) || 0 : 0;
  }

  /**
   * Forget a key's counters entirely.
   *
   * Exists for operator recovery — lifting a throttle off a specific account
   * after a false positive — and for tests. Not reachable from any user-facing
   * route.
   */
  async reset(key: string): Promise<void> {
    this.sql.exec(SQL_RESET, key);
  }

  // ------------------------------------------------------------------ cleanup

  /**
   * Arm the pruning alarm if one is not already pending.
   *
   * Coalesced the same way VoteCounter coalesces its flush: `setAlarm` is billed
   * as a row written, and re-arming on every throttled action would make the
   * cleanup cost as much as the counting.
   */
  private async scheduleCleanup(nextExpiry: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) await this.ctx.storage.setAlarm(nextExpiry + PRUNE_GRACE_MS);
  }

  /**
   * Alarm handler — drop dead counter rows.
   *
   * Re-arms whenever ANY row is left, not only when one is still live.
   *
   * The obvious version — re-arm if `nextExpiry > now` — has a hole exactly at the
   * boundary, which is the normal case rather than a rare one, because absolute
   * windows make rows expire on aligned instants and the alarm is scheduled from
   * one of them. A row whose window closed at `now` is spared by the grace period
   * in the DELETE above and is not in the future either, so nothing would be
   * rearmed and that row would sit in storage forever. Since the stated reason for
   * ever stopping is "empty storage lets the platform reclaim this actor", leaving a
   * row behind defeats the entire point: the object would be kept alive by the very
   * residue the alarm exists to remove.
   *
   * `Math.max(next, now)` keeps the retry from being scheduled in the past.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec(SQL_PRUNE, now - PRUNE_GRACE_MS);

    const rows = this.sql
      .exec(SQL_NEXT_EXPIRY)
      .toArray() as Array<{ next: number | null; remaining: number }>;
    const remaining = rows.length > 0 ? Number(rows[0].remaining) || 0 : 0;
    // Nothing left: stop. An actor with empty storage is reclaimed, and re-arming
    // here would keep one object alive per subject ever rate limited, each paying a
    // scheduled alarm to do nothing.
    if (remaining === 0) return;

    const next = rows.length > 0 ? Number(rows[0].next) || 0 : 0;
    await this.ctx.storage.setAlarm(Math.max(next, now) + PRUNE_GRACE_MS);
  }
}
