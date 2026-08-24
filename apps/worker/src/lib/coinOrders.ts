/**
 * Shared crediting for Razorpay coin orders.
 *
 * Both the client callback (`/api topup`) and the server-to-server webhook
 * (`/webhook/razorpay`) funnel through `creditPaymentOrder` so an order is
 * credited EXACTLY ONCE regardless of which path arrives first (or if both do).
 *
 * Idempotency is enforced by an atomic status CAS on `payment_orders`
 * (created -> paid): only the first writer flips the row and performs the
 * credit; every later attempt sees status='paid' and no-ops. The `payments`
 * insert (PK = paymentId) is a second, independent guard.
 */
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { newId, now } from "./ids";

type Db = ReturnType<typeof getDb>;

/**
 * Order statuses that may still transition to `paid`.
 *
 * This used to be `status != 'paid'`, which was correct while the only two
 * states were created/paid — but it becomes a double-credit bug the moment a
 * terminal state like `refunded` exists, because a late duplicate
 * `payment.captured` retry would see "not paid" and credit the order a second
 * time. Refunded, disputed and failed orders are terminal.
 */
export const CREDITABLE_ORDER_STATUSES = ["created", "expired"] as const;

export interface CreditOrderInput {
  orderId: string;
  paymentId: string;
  /** Which path is crediting: client callback, gateway webhook, or the sweeper. */
  source: "callback" | "webhook" | "reconciliation";
  /** When set, the order must belong to this uid (client callback path). */
  expectedFromUid?: string;
  /** Captured amount in paise (from the webhook). Verified against the order. */
  capturedAmountPaise?: number | null;
}

export type CreditReason =
  | "order_not_found"
  | "owner_mismatch"
  | "amount_mismatch"
  | "invalid_amount"
  | "already"
  | "credited";

export interface CreditOrderResult {
  credited: boolean;
  reason: CreditReason;
  coins?: number;
  uid?: string;
}

/**
 * Credit a persisted Razorpay order. Returns a structured result rather than
 * throwing, so each caller can map it to the right HTTP behaviour (the client
 * callback throws user-facing errors; the webhook just acknowledges).
 */
export async function creditPaymentOrder(
  env: Env,
  db: Db,
  input: CreditOrderInput,
): Promise<CreditOrderResult> {
  const { orderId, paymentId, source, expectedFromUid, capturedAmountPaise } = input;

  const order = await db
    .select()
    .from(schema.paymentOrders)
    .where(eq(schema.paymentOrders.orderId, orderId))
    .get();
  if (!order) return { credited: false, reason: "order_not_found" };

  if (expectedFromUid && order.userId !== expectedFromUid)
    return { credited: false, reason: "owner_mismatch", uid: order.userId };

  // Defense-in-depth: the captured amount must cover the server-set price. The
  // price is already server-authoritative, but the webhook lets us catch any
  // under-payment / tampering before crediting.
  if (
    capturedAmountPaise != null &&
    Number.isFinite(capturedAmountPaise) &&
    capturedAmountPaise < order.amountPaise
  )
    return { credited: false, reason: "amount_mismatch", uid: order.userId };

  const coins = Number(order.coins);
  if (!Number.isFinite(coins) || coins <= 0 || coins > 1_000_000)
    return { credited: false, reason: "invalid_amount", uid: order.userId };

  // The bonus is already inside `coins` — this is purely so the wallet ledger
  // can show the user that the package's bonus was actually applied.
  const bonus = Number(order.bonusCoins) || 0;
  const base = coins - bonus;
  const description =
    bonus > 0 ? `Purchased ${base} Dpcoins + ${bonus} bonus` : `Purchased ${coins} Dpcoins`;

  const ts = now();

  // Atomic idempotency claim: flip created/expired -> paid. If another path
  // already credited this order — or it reached a terminal state such as
  // `refunded` — `changes` is 0 and we no-op.
  const claim = await db
    .update(schema.paymentOrders)
    .set({ status: "paid", paymentId, source, creditedAt: ts, updatedAt: ts })
    .where(and(
      eq(schema.paymentOrders.orderId, orderId),
      inArray(schema.paymentOrders.status, [...CREDITABLE_ORDER_STATUSES]),
    ))
    .run();
  if (claim.meta.changes === 0)
    return { credited: false, reason: "already", coins, uid: order.userId };

  // Credit the wallet + write the ledger entry atomically. The payments insert
  // is keyed on paymentId (onConflictDoNothing) as a second idempotency guard.
  await db.batch([
    db
      .insert(schema.payments)
      .values({ id: paymentId, userId: order.userId, amount: coins, status: "success", createdAt: ts })
      .onConflictDoNothing(),
    db
      .update(schema.users)
      .set({ dpcoin: sql`${schema.users.dpcoin} + ${coins}`, updatedAt: ts })
      .where(eq(schema.users.uid, order.userId)),
    db.insert(schema.coinTransactions).values({
      id: newId(),
      uid: order.userId,
      amount: coins,
      type: "purchase",
      description,
      createdAt: ts,
    }),
  ]);

  return { credited: true, reason: "credited", coins, uid: order.userId };
}


export type ClawbackKind = "refund" | "dispute";

export interface ClawbackResult {
  clawedBack: boolean;
  reason: "order_not_found" | "not_credited" | "already" | "clawed_back";
  uid?: string;
  coins?: number;
  shortfall?: number;
}

/**
 * Reverse a credited order after a refund or a chargeback.
 *
 * Previously there was no code path for this at all: the webhook acknowledged
 * `refund.created` / `payment.dispute.created` with a 200 and did nothing, so a
 * user could pay, receive coins, refund the payment, and keep the coins.
 *
 * Design notes:
 *
 *  - The debit is UNCONDITIONAL and may take the balance negative. That is
 *    deliberate: it is the honest accounting outcome, and because every spend
 *    path guards with `dpcoin >= amount`, a negative balance naturally blocks
 *    further spending and withdrawals instead of letting the loss disappear.
 *  - `clawback_shortfall` records how much of the clawback the user could not
 *    cover, which is the signal that someone is refund-farming.
 *  - A partial refund claws back a proportional number of coins, rounded UP so
 *    rounding never favours the refunder.
 *  - The order status becomes terminal (`refunded`/`disputed`) so a late
 *    duplicate `payment.captured` retry can no longer re-credit it.
 */
export async function clawbackPaymentOrder(
  env: Env,
  db: Db,
  input: {
    paymentId: string;
    kind: ClawbackKind;
    refundedAmountPaise?: number | null;
  },
): Promise<ClawbackResult> {
  const { paymentId, kind } = input;
  const order = await db
    .select()
    .from(schema.paymentOrders)
    .where(eq(schema.paymentOrders.paymentId, paymentId))
    .get();
  if (!order) return { clawedBack: false, reason: "order_not_found" };
  if (order.status === "refunded" || order.status === "disputed") {
    return { clawedBack: false, reason: "already", uid: order.userId };
  }
  if (order.status !== "paid") {
    // Never credited, so there is nothing to reverse. Still mark it terminal so
    // it cannot later be credited by a stale retry.
    await db
      .update(schema.paymentOrders)
      .set({ status: kind === "dispute" ? "disputed" : "refunded", refundedAt: now(), updatedAt: now() })
      .where(and(eq(schema.paymentOrders.orderId, order.orderId), eq(schema.paymentOrders.status, order.status)))
      .run();
    return { clawedBack: false, reason: "not_credited", uid: order.userId };
  }

  const creditedCoins = Number(order.coins) || 0;
  const expectedPaise = Number(order.amountPaise) || 0;
  const refundedPaise =
    input.refundedAmountPaise != null && Number.isFinite(input.refundedAmountPaise)
      ? Math.max(0, Math.min(Number(input.refundedAmountPaise), expectedPaise))
      : expectedPaise;
  const coinsToClaw =
    expectedPaise > 0 && refundedPaise < expectedPaise
      ? Math.min(creditedCoins, Math.ceil((creditedCoins * refundedPaise) / expectedPaise))
      : creditedCoins;

  if (coinsToClaw <= 0) return { clawedBack: false, reason: "not_credited", uid: order.userId };

  const balanceBefore = Number(
    (
      await db
        .select({ dpcoin: schema.users.dpcoin })
        .from(schema.users)
        .where(eq(schema.users.uid, order.userId))
        .get()
    )?.dpcoin ?? 0,
  );
  const shortfall = Math.max(0, coinsToClaw - Math.max(0, balanceBefore));

  const ts = now();
  const newStatus = kind === "dispute" ? "disputed" : "refunded";
  const claimKey = `clawback:${paymentId}`;
  const nonce = crypto.randomUUID();
  const claimGate = `EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ? AND nonce = ?)`;
  // Only one request can hold the claim for this payment, so "claim held AND the
  // order status is now terminal" is an exact gate for the money statements.
  const appliedGate = `${claimGate} AND (SELECT status FROM payment_orders WHERE order_id = ?) = ?`;

  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (key, nonce, scope, created_at) VALUES (?, ?, ?, ?)`,
    ).bind(claimKey, nonce, "clawback", ts),
    env.DB.prepare(
      `UPDATE payment_orders
          SET status = ?, refunded_at = ?, refunded_amount_paise = ?,
              clawed_back_coins = ?, clawback_shortfall = ?, updated_at = ?
        WHERE order_id = ? AND status = 'paid' AND ${claimGate}`,
    ).bind(
      newStatus,
      ts,
      refundedPaise,
      coinsToClaw,
      shortfall,
      ts,
      order.orderId,
      claimKey,
      nonce,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO coin_transactions
         (id, uid, amount, type, description, created_at)
       SELECT ?, ?, ?, ?, ?, ?
        WHERE ${appliedGate}`,
    ).bind(
      `${kind}_clawback:${paymentId}`,
      order.userId,
      -coinsToClaw,
      kind === "dispute" ? "chargeback_clawback" : "refund_clawback",
      kind === "dispute"
        ? `Chargeback on payment ${paymentId} — ${coinsToClaw} coins reversed`
        : `Refund of payment ${paymentId} — ${coinsToClaw} coins reversed`,
      ts,
      claimKey,
      nonce,
      order.orderId,
      newStatus,
    ),
    env.DB.prepare(
      `UPDATE users SET dpcoin = dpcoin - ?, updated_at = ? WHERE uid = ? AND ${appliedGate}`,
    ).bind(coinsToClaw, ts, order.userId, claimKey, nonce, order.orderId, newStatus),
    // Mark the payment row so revenue reporting stops counting it.
    env.DB.prepare(
      `UPDATE payments SET status = ? WHERE id = ? AND ${appliedGate}`,
    ).bind(newStatus, paymentId, claimKey, nonce, order.orderId, newStatus),
  ]);

  if (Number(results[3]?.meta?.changes || 0) === 0) {
    return { clawedBack: false, reason: "already", uid: order.userId, coins: coinsToClaw };
  }
  return {
    clawedBack: true,
    reason: "clawed_back",
    uid: order.userId,
    coins: coinsToClaw,
    shortfall,
  };
}

export interface ReconcileSummary {
  checked: number;
  credited: number;
  expired: number;
  failed: number;
  coins: number;
}

/** How long an order may sit uncredited before the sweeper checks the gateway. */
const RECONCILE_MIN_AGE_MS = 10 * 60 * 1000;
/** After this, an order with no captured payment is written off as abandoned. */
const RECONCILE_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** Give up asking the gateway about one order after this many attempts. */
const RECONCILE_MAX_ATTEMPTS = 8;

/**
 * Sweep orders that were paid at Razorpay but never credited here.
 *
 * This closes the one hole the CAS-based crediting could not: if the client
 * never called `topup` (app killed, network drop) AND the webhook never arrived
 * (misconfigured secret — the endpoint 503s without one — or a delivery
 * failure), the money was captured and nothing in the system would ever notice.
 * The `idx_payment_orders_status` index existed for exactly this sweep and had
 * no reader.
 *
 * The gateway is the source of truth: for each stale `created` order we ask
 * Razorpay for its payments and credit through the same `creditPaymentOrder`
 * path, so all the usual idempotency and amount checks still apply.
 */
export async function reconcilePaymentOrders(
  env: Env,
  limit = 25,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, credited: 0, expired: 0, failed: 0, coins: 0 };
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    // Fail closed and loudly: without credentials we cannot reconcile, and
    // silently doing nothing is how the original gap stayed invisible.
    console.error("[reconcile] Razorpay credentials missing — cannot reconcile paid-but-uncredited orders");
    return summary;
  }

  const db = getDb(env);
  const ts = now();
  const stale = await db
    .select()
    .from(schema.paymentOrders)
    .where(and(
      eq(schema.paymentOrders.status, "created"),
      lt(schema.paymentOrders.createdAt, ts - RECONCILE_MIN_AGE_MS),
      lt(schema.paymentOrders.reconcileAttempts, RECONCILE_MAX_ATTEMPTS),
    ))
    .orderBy(asc(schema.paymentOrders.createdAt))
    .limit(limit)
    .all();

  const auth = `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`;

  for (const order of stale) {
    summary.checked++;
    // Record the attempt FIRST so a persistently failing order backs off instead
    // of being retried every ten minutes forever.
    await db
      .update(schema.paymentOrders)
      .set({ reconcileAttempts: (order.reconcileAttempts ?? 0) + 1, reconciledAt: ts, updatedAt: ts })
      .where(eq(schema.paymentOrders.orderId, order.orderId))
      .run();

    try {
      const res = await fetch(
        `https://api.razorpay.com/v1/orders/${encodeURIComponent(order.orderId)}/payments`,
        { headers: { Authorization: auth } },
      );
      if (!res.ok) {
        summary.failed++;
        console.error(`[reconcile] gateway lookup failed for ${order.orderId}: ${res.status}`);
        continue;
      }
      const payload = await res.json<{ items?: any[] }>();
      const captured = (payload.items ?? []).find((p) => p?.status === "captured");

      if (captured?.id) {
        const credit = await creditPaymentOrder(env, db, {
          orderId: order.orderId,
          paymentId: String(captured.id),
          source: "reconciliation",
          capturedAmountPaise: Number(captured.amount) || null,
        });
        if (credit.credited) {
          summary.credited++;
          summary.coins += credit.coins ?? 0;
          console.warn(
            `[reconcile] credited ${credit.coins} coins for ${order.orderId} (uid ${credit.uid}) — payment was captured but never credited`,
          );
        } else if (credit.reason !== "already") {
          summary.failed++;
          console.error(`[reconcile] could not credit ${order.orderId}: ${credit.reason}`);
        }
        continue;
      }

      // No captured payment and old enough to be abandoned checkout.
      if (Number(order.createdAt) < ts - RECONCILE_EXPIRY_MS) {
        await db
          .update(schema.paymentOrders)
          .set({ status: "expired", updatedAt: now() })
          .where(and(
            eq(schema.paymentOrders.orderId, order.orderId),
            eq(schema.paymentOrders.status, "created"),
          ))
          .run();
        summary.expired++;
      }
    } catch (e) {
      summary.failed++;
      console.error(`[reconcile] error while reconciling ${order.orderId}`, e);
    }
  }

  return summary;
}
