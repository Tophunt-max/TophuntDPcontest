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
  /**
   * Manual deposits marked `approved` whose coins never landed (`credited_at IS
   * NULL`, migration 0053).
   *
   * Structurally impossible since the approval became one gated batch — which is
   * exactly why it is worth probing. If this is ever non-zero, the approval path
   * has regressed to a non-atomic write and a user has paid real INR for nothing.
   */
  strandedApprovedDeposits: number;
  /** Orders still `created` past the reconcile window — the sweeper should be clearing these. */
  stuckCreatedOrders: number;
  /**
   * Escrowed withdrawals whose ledger does not match their status: a held row
   * with no `withdrawal_hold`, or a rejected one with no `withdrawal_refund`. Balance and ledger can still agree while a
   * rejection's refund never ran, so the drift check alone does not see this.
   */
  withdrawalLedgerGaps: { count: number; samples: { id: string; status: string; missing: string }[] };
  /** Refunds where coins were already spent and could not be recovered. */
  clawbackShortfalls: { count: number; coins: number };
  /** Operational queues — informational, not a health failure on their own. */
  pendingDeposits: { count: number; oldestAgeMs: number | null };
  pendingWithdrawals: { count: number; oldestAgeMs: number | null };
}

/** Escrowed (reserved) withdrawals missing the ledger row their status implies. */
const WITHDRAWAL_GAPS = `
  SELECT w.id AS id, w.status AS status,
         CASE w.status WHEN 'rejected' THEN 'withdrawal_refund' ELSE 'withdrawal_hold' END AS missing
    FROM withdrawals w
   WHERE COALESCE(w.reserved, 0) = 1
     -- 'paid' is not checked: payouts marked paid before the settle pair existed
     -- have no withdrawal_settled row by design, and would flag forever.
     AND w.status IN ('pending', 'approved', 'rejected')
     AND NOT EXISTS (
       SELECT 1 FROM coin_transactions t
        WHERE t.id = (CASE w.status WHEN 'rejected' THEN 'withdrawal_refund:' ELSE 'withdrawal_hold:' END) || w.id
     )`;

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
    strandedDeposits,
    stuckCreated,
    clawbackCount,
    clawbackCoins,
    pendDepCount,
    pendDepOldest,
    pendWdCount,
    pendWdOldest,
    wdGapCount,
    wdGapSamples,
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
      `SELECT COUNT(*) AS n FROM deposits WHERE status = 'approved' AND credited_at IS NULL`,
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
    firstNumber(env, `SELECT COUNT(*) AS n FROM (${WITHDRAWAL_GAPS})`),
    rows<{ id: string; status: string; missing: string }>(env, `SELECT id, status, missing FROM (${WITHDRAWAL_GAPS}) LIMIT 20`),
  ]);

  const ageOf = (oldest: number): number | null => (oldest > 0 ? Math.max(0, ts - oldest) : null);

  // "ok" covers only the invariant-violation signals; pending queues are normal
  // operations. A -1 (query failure) is treated as not-ok so a broken probe is
  // visible rather than silently green.
  const bad = (n: number) => n !== 0; // includes -1
  const ok =
    !bad(driftCount) &&
    !bad(negCount) &&
    !bad(stranded) &&
    !bad(strandedDeposits) &&
    !bad(clawbackCount) &&
    !bad(wdGapCount);

  return {
    ok,
    ts,
    ledgerDrift: { count: driftCount, samples: driftSamples },
    negativeBalances: { count: negCount, samples: negSamples },
    strandedPaidOrders: stranded,
    strandedApprovedDeposits: strandedDeposits,
    stuckCreatedOrders: stuckCreated,
    clawbackShortfalls: { count: clawbackCount, coins: clawbackCoins },
    withdrawalLedgerGaps: { count: wdGapCount, samples: wdGapSamples },
    pendingDeposits: { count: pendDepCount, oldestAgeMs: ageOf(pendDepOldest) },
    pendingWithdrawals: { count: pendWdCount, oldestAgeMs: ageOf(pendWdOldest) },
  };
}

/** Title of the alert row; also its dedupe key. */
export const MONEY_HEALTH_ALERT_TITLE = "Money integrity check failed";
const ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000;

/**
 * Scheduled run of `computeMoneyHealth` (every 6 hours, index.ts).
 *
 * It used to run only when an admin opened the Money Health page, so a ledger
 * drift, a negative balance or an unrefunded rejection could sit unnoticed. On a
 * failure this writes ONE admin notification per 24 h (not one per run) naming
 * what failed. Returns the health so the cron heartbeat can record it.
 */
export async function moneyHealthAlert(env: Env): Promise<MoneyHealth> {
  const h = await computeMoneyHealth(env);
  if (h.ok) return h;
  const failed = [
    h.ledgerDrift.count !== 0 && `ledger drift on ${h.ledgerDrift.count} account(s)`,
    h.negativeBalances.count !== 0 && `${h.negativeBalances.count} negative balance(s)`,
    h.strandedPaidOrders !== 0 && `${h.strandedPaidOrders} paid order(s) not credited`,
    h.strandedApprovedDeposits !== 0 && `${h.strandedApprovedDeposits} approved deposit(s) not credited`,
    h.clawbackShortfalls.count !== 0 && `${h.clawbackShortfalls.count} clawback shortfall(s)`,
    h.withdrawalLedgerGaps.count !== 0 && `${h.withdrawalLedgerGaps.count} withdrawal(s) missing a ledger row`,
  ].filter(Boolean);
  // -1 means a probe failed; say so rather than listing nothing.
  const message = failed.length ? failed.join("; ") + "." : "One or more money checks could not run.";
  console.error("[moneyHealth] check failed:", message);
  try {
    const recent = await env.DB.prepare(
      `SELECT 1 AS x FROM admin_notifications WHERE title = ? AND created_at > ? LIMIT 1`,
    )
      .bind(MONEY_HEALTH_ALERT_TITLE, h.ts - ALERT_DEDUPE_MS)
      .first();
    if (!recent) {
      await env.DB.prepare(
        `INSERT INTO admin_notifications (id, title, message, link, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), MONEY_HEALTH_ALERT_TITLE, message, "/system-health", h.ts)
        .run();
    }
  } catch (e) {
    console.error("[moneyHealth] could not write the alert", e);
  }
  return h;
}

