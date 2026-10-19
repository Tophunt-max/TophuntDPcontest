/**
 * Declare a battle's result the moment its voting window ends, instead of waiting
 * for the 10-minute cron.
 *
 * The cron (`resolveContests`) is still the backstop and the only path for a
 * battle nobody is looking at. But a battle somebody IS looking at is, by
 * definition, being read through `GET /read/matches/:id` — the app re-reads it
 * when its countdown hits zero — so that read kicks `resolveMatch` in
 * `waitUntil` and the result lands within seconds.
 *
 * Why this is safe to call from a read, and concurrently with the cron:
 *   - `finalizeVotes` refuses before the deadline and is idempotent after it
 *     (the VoteCounter DO closes once and returns the same final tally).
 *   - Every outcome in `resolveMatch` (win, tie, refund, void) is claimed by ONE
 *     atomic `UPDATE … WHERE status = 'active' AND settlement_id IS NULL`, and
 *     money, notifications and emails only happen for the caller that won that
 *     claim. A second caller sees `settled = false` and returns.
 *   - Snapshot back-fills before settlement are first-writer-wins.
 *
 * Throttled per isolate per match so a viewer refreshing (or many viewers) do
 * not each start a settlement; the atomic claim already makes duplicates
 * harmless, this just stops them costing a DO call each.
 */
import type { Env } from "../types";
import { memoGet, memoPut } from "./memo";
import { resolveMatch, type Match } from "../cron";

/** One settlement attempt per match per isolate in this window. */
export const SETTLE_KICK_THROTTLE_SEC = 15;

/** Is this row due for settlement right now? Pure. */
export function isDueForSettlement(row: Pick<Match, "status" | "expiresAt"> | null | undefined, nowMs = Date.now()): boolean {
  if (!row || row.status !== "active") return false;
  const exp = Number(row.expiresAt);
  return Number.isFinite(exp) && exp > 0 && exp <= nowMs;
}

/**
 * Start settling `row` in the background if it is due. Returns whether a kick
 * was scheduled. Never throws and never delays the response.
 */
export function kickSettlementIfDue(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void } | undefined,
  row: Match | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!ctx || !row || !isDueForSettlement(row, nowMs)) return false;
  const key = `memo:settleKick:${row.id}`;
  if (memoGet(key)) return false;
  memoPut(key, { at: nowMs }, SETTLE_KICK_THROTTLE_SEC);
  ctx.waitUntil(
    resolveMatch(env, row).catch((e) => {
      // The cron retries on its next tick; nothing is lost.
      console.error("[settleDue] early settlement failed (cron will retry)", row.id, e);
    }),
  );
  return true;
}
