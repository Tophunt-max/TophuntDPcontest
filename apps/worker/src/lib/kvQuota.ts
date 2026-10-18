/**
 * Detect an exhausted KV daily write quota, and let `SCALE_TIER = "auto"` adapt to it.
 *
 * ## The problem `auto` had
 *
 * `auto` caches the per-request auth account-state in KV — one write per active
 * user per 60s. On the Workers PAID plan that is cheap. On the FREE plan (1,000 KV
 * writes/day for the whole Worker) those writes succeed until the quota is gone,
 * and from then until UTC midnight EVERY KV write fails: `settings:*`,
 * `cache:blocks:*` and `feed:seen:*` all fall back to D1. Correct, but the auth
 * cache spent the budget the other caches needed, every single day.
 *
 * ## What happens now
 *
 *  1. Any KV put that fails with the platform's DAILY-limit error is reported here.
 *     (A per-key 429 "1 write/sec" error is NOT a quota signal and is ignored.)
 *  2. This isolate stops attempting KV puts until the next UTC midnight — every
 *     attempt would fail anyway, and each costs a subrequest and latency.
 *  3. The fact is persisted ONCE per isolate per day as a `settings` row
 *     (`id = 'kvQuota'`), written straight to D1 — never through KV, which is the
 *     thing that just ran out.
 *  4. `auto` reads that row (isolate-memoised for STATE_MEMO_SEC) and skips the
 *     auth-state cache while the last exhaustion is younger than AUTO_BACKOFF_MS.
 *     That frees the whole KV budget for the caches that are cheaper per hit.
 *
 * Net effect: on a free account `auto` behaves like `free` for a week after any
 * exhaustion, then retries; on a paid account the daily limit never trips (paid
 * KV writes bill as overage instead of failing), so `auto` keeps caching. No plan
 * detection, no manual flip.
 *
 * Security: this only decides whether a CACHE is used. When the auth cache is
 * skipped, the account-state check reads D1 directly — the stricter path — so a
 * block or revocation is never delayed by it.
 */
import type { Env } from "../types";
import { memoDelete, memoGet, memoPut } from "./memo";

/** How long `auto` stays off the auth-state cache after an exhaustion. */
export const AUTO_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;
const STATE_MEMO_KEY = "memo:kvQuotaState";
const STATE_MEMO_SEC = 300;
const SETTINGS_ID = "kvQuota";

/** Isolate-local: KV puts are known to fail until this epoch-ms (next UTC midnight). */
let exhaustedUntil = 0;
/** Isolate-local: the UTC day already persisted, so D1 is written once per day. */
let persistedDay: string | null = null;

/** The KV daily write limit error. Deliberately narrow: a 429 per-key limit is not it. */
export function isKvDailyLimitError(e: unknown): boolean {
  const msg = String((e as any)?.message ?? e ?? "");
  return /limit exceeded for the day|daily (write )?limit|exceeded.*daily|quota exceeded/i.test(msg);
}

function nextUtcMidnight(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** True while this isolate knows KV puts will fail. Cheap; no I/O. */
export function kvPutsSuspended(nowMs = Date.now()): boolean {
  return nowMs < exhaustedUntil;
}

/**
 * Report a failed KV put. Never throws. Returns true if it was the daily limit.
 * Persists the exhaustion to D1 at most once per isolate per UTC day.
 */
export async function noteKvPutFailure(env: Env, e: unknown, nowMs = Date.now()): Promise<boolean> {
  if (!isKvDailyLimitError(e)) return false;
  exhaustedUntil = nextUtcMidnight(nowMs);
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (persistedDay === day) return true;
  persistedDay = day;
  try {
    await env.DB.prepare(
      "INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    )
      .bind(SETTINGS_ID, JSON.stringify({ lastExhaustedAt: nowMs, day }), nowMs)
      .run();
    memoDelete(STATE_MEMO_KEY);
    console.warn(`[kvQuota] KV daily write limit reached (${day}); SCALE_TIER=auto skips the auth-state cache for 7 days`);
  } catch (err) {
    persistedDay = null; // try again on the next failure
    console.error("[kvQuota] could not persist exhaustion (continuing)", err);
  }
  return true;
}

/** Last recorded exhaustion (epoch ms), or 0. Memoised; a D1 error reads as "none". */
export async function lastKvExhaustion(env: Env): Promise<number> {
  const memo = memoGet<{ at: number }>(STATE_MEMO_KEY);
  if (memo) return memo.at;
  let at = 0;
  try {
    const row = await env.DB.prepare("SELECT data FROM settings WHERE id = ?").bind(SETTINGS_ID).first<{ data: string }>();
    const parsed = row?.data ? JSON.parse(row.data) : null;
    at = Number(parsed?.lastExhaustedAt) || 0;
  } catch {
    at = 0;
  }
  memoPut(STATE_MEMO_KEY, { at }, STATE_MEMO_SEC);
  return at;
}

/**
 * May `auto` use the auth-state KV cache right now? False while this isolate has
 * seen the limit today, or while the persisted exhaustion is within the backoff.
 */
export async function autoAuthCacheAllowed(env: Env, nowMs = Date.now()): Promise<boolean> {
  if (kvPutsSuspended(nowMs)) return false;
  const at = await lastKvExhaustion(env);
  return !(at > 0 && nowMs - at < AUTO_BACKOFF_MS);
}

/** Test hook. */
export function __resetKvQuotaForTests(): void {
  exhaustedUntil = 0;
  persistedDay = null;
  memoDelete(STATE_MEMO_KEY);
}
