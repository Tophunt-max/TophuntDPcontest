/**
 * Money-flow integrity, in one query set.
 *
 * The wallet is a single number per user (`users.dpcoin`) and every change is
 * supposed to be written in the same D1 batch as a matching `coin_transactions`
 * ledger row — so the load-bearing invariant is:
 *
 *     users.dpcoin  ==  SUM(coin_transactions.amount)   for every user.
 *
 * If that ever drifts, coins were minted or burned without a ledger entry, which
 * is the one bug class in a coin economy you cannot afford to discover late. The
 * money tests assert this invariant in-process; this surfaces it in production,
 * continuously, to the admin.
 *
 * It also reports the other places real money silently goes wrong:
 *  - orders captured at the gateway but never credited here (`paid` with no
 *    `payments` row — the same signal the reconcile sweeper acts on),
 *  - orders stuck unconfirmed past the reconcile window,
 *  - refunds we could not fully claw back (`clawback_shortfall > 0`),
 *  - negative balances (a debit that should have been refused),
 *  - the pending deposit/withdrawal queues and how old the oldest item is.
 *
 * Read-only and defensive: every query is wrapped so one failure degrades that
 * one metric to `null`/`-1` rather than failing the whole console.
 */
import type { Env } from "../types";

/** Coins are whole numbers; a real-sum drift below this is float noise, not a bug. */
const DRIFT_EPSILON = 0.5;
/** Mirrors RECONCILE_MIN_AGE_MS in lib/coinOrders.ts: below this an order is just new. */
const STUCK_ORDER_MIN_AGE_MS = 10 * 60 * 1000;

export interface LedgerDriftSample {
  uid: string;
  balance: number;
  ledger: number;
  diff: number;
}

export interface MoneyHealth {
  ok: boolean;
  ts: number;
  /** users.dpcoin != SUM(ledger) — the core invariant. Any non-zero is serious. */
  ledgerDrift: { count: number; samples: LedgerDriftSample[] };
  /** Balances below zero — a debit that should have been refused. */
  negativeBalances: { count: number; samples: { uid: string; balance: number }[] };
  /** Captured at Razorpay, coins never landed (paid order with no payments row). */
  strandedPaidOrders: number;
  /** Orders still `created` past the reconcile window — the sweeper should be clearing these. */
  stuckCreatedOrders: number;
  /** Refunds where coins were already spent and could not be recovered. */
  clawbackShortfalls: { count: number; coins: number };
  /** Operational queues — informational, not a health failure on their own. */
  pendingDeposits: { count: number; oldestAgeMs: number | null };
  pendingWithdrawals: { count: number; oldestAgeMs: number | null };
}

/** COALESCE(SUM(amount)) of a user's ledger, as a correlated subquery. */
const LEDGER_SUM = "COALESCE((SELECT SUM(amount) FROM coin_transactions t WHERE t.uid = u.uid), 0)";

async function firstNumber(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  try {
    const row = await env.DB.prepare(sql).bind(...binds).first<Record<string, number>>();
    if (!row) return 0;
    const v = Object.values(row)[0];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  } catch (e) {
    console.error("[moneyHealth] query failed", sql, e);
    return -1; // -1 marks "could not compute", distinct from a real 0
  }
}

async function rows<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const res = await env.DB.prepare(sql).bind(...binds).all<T>();
    return (res.results ?? []) as T[];
  } catch (e) {
    console.error("[moneyHealth] query failed", sql, e);
    return [];
  }
}

export async function computeMoneyHealth(env: Env): Promise<MoneyHealth> {
  const ts = Date.now();

  const [
    driftCount,
    driftSamples,
    negCount,
    negSamples,
    stranded,
    stuckCreated,
    clawbackCount,
    clawbackCoins,
    pendDepCount,
    pendDepOldest,
    pendWdCount,
    pendWdOldest,
  ] = await Promise.all([
    firstNumber(
      env,
      `SELECT COUNT(*) AS n FROM users u WHERE ABS(u.dpcoin - ${LEDGER_SUM}) > ?`,
      DRIFT_EPSILON,
    ),
    rows<LedgerDriftSample>(
      env,
      `SELECT u.uid AS uid, u.dpcoin AS balance, ${LEDGER_SUM} AS ledger,
              (u.dpcoin - ${LEDGER_SUM}) AS diff
         FROM users u
        WHERE ABS(u.dpcoin - ${LEDGER_SUM}) > ?
        ORDER BY ABS(u.dpcoin - ${LEDGER_SUM}) DESC
        LIMIT 20`,
      DRIFT_EPSILON,
    ),
    firstNumber(env, `SELECT COUNT(*) AS n FROM users WHERE dpcoin < 0`),
    rows<{ uid: string; balance: number }>(
      env,
      `SELECT uid, dpcoin AS balance FROM users WHERE dpcoin < 0 ORDER BY dpcoin ASC LIMIT 20`,
    ),
    firstNumber(
      env,
      `SELECT COUNT(*) AS n FROM payment_orders o
        WHERE o.status = 'paid' AND o.payment_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = o.payment_id)`,
    ),
    firstNumber(
      env,
      `SELECT COUNT(*) AS n FROM payment_orders WHERE status = 'created' AND created_at < ?`,
      ts - STUCK_ORDER_MIN_AGE_MS,
    ),
    firstNumber(env, `SELECT COUNT(*) AS n FROM payment_orders WHERE clawback_shortfall > 0`),
    firstNumber(env, `SELECT COALESCE(SUM(clawback_shortfall), 0) AS n FROM payment_orders WHERE clawback_shortfall > 0`),
    firstNumber(env, `SELECT COUNT(*) AS n FROM deposits WHERE status = 'pending'`),
    firstNumber(env, `SELECT COALESCE(MIN(created_at), 0) AS n FROM deposits WHERE status = 'pending'`),
    firstNumber(env, `SELECT COUNT(*) AS n FROM withdrawals WHERE status = 'pending'`),
    firstNumber(env, `SELECT COALESCE(MIN(created_at), 0) AS n FROM withdrawals WHERE status = 'pending'`),
  ]);

  const ageOf = (oldest: number): number | null => (oldest > 0 ? Math.max(0, ts - oldest) : null);

  // "ok" covers only the invariant-violation signals; pending queues are normal
  // operations. A -1 (query failure) is treated as not-ok so a broken probe is
  // visible rather than silently green.
  const bad = (n: number) => n !== 0; // includes -1
  const ok =
    !bad(driftCount) && !bad(negCount) && !bad(stranded) && !bad(clawbackCount);

  return {
    ok,
    ts,
    ledgerDrift: { count: driftCount, samples: driftSamples },
    negativeBalances: { count: negCount, samples: negSamples },
    strandedPaidOrders: stranded,
    stuckCreatedOrders: stuckCreated,
    clawbackShortfalls: { count: clawbackCount, coins: clawbackCoins },
    pendingDeposits: { count: pendDepCount, oldestAgeMs: ageOf(pendDepOldest) },
    pendingWithdrawals: { count: pendWdCount, oldestAgeMs: ageOf(pendWdOldest) },
  };
}
