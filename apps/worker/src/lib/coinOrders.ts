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
import { getRazorpayCredentials } from "./integrations";

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
      .values({
        id: paymentId,
        userId: order.userId,
        // `amount` is the legacy coin column; `coins` and `amountPaise` split the
        // two so revenue reporting can stop treating coins as rupees.
        amount: coins,
        coins,
        amountPaise: Number(order.amountPaise) || 0,
        source: "razorpay",
        status: "success",
        createdAt: ts,
      })
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
  /** Cumulative paise refunded on this payment after this event. */
  refundedPaise?: number;
  /** True once the whole payment has been refunded (or the dispute was lost). */
  fullyRefunded?: boolean;
}

/**
 * Order statuses from which a refund may still claw coins back.
 *
 * `partially_refunded` is here because a payment can be refunded in instalments:
 * Razorpay allows any number of partial refunds up to the captured amount, and
 * each one arrives as its own `refund.created`. The status used to jump straight
 * to `refunded` on the FIRST of them, which then matched the terminal check below
 * and made every subsequent refund a no-op — so a ₹100 payment refunded as 2×₹50
 * clawed back 50 coins and the user kept the other 50 for a payment they had been
 * refunded in full.
 *
 * It is deliberately absent from `CREDITABLE_ORDER_STATUSES`: partially refunded
 * still means "do not credit this order again".
 */
const CLAWBACKABLE_ORDER_STATUSES = ["paid", "partially_refunded"] as const;

/** Statuses that are final — no further clawback is possible or needed. */
const TERMINAL_ORDER_STATUSES = ["refunded", "disputed"] as const;

/**
 * Reverse a credited order after a refund or a chargeback.
 *
 * Previously there was no code path for this at all: the webhook acknowledged
 * `refund.created` / `payment.dispute.created` with a 200 and did nothing, so a
 * user could pay, receive coins, refund the payment, and keep the coins.
 *
 * Design notes:
 *
 *  - The debit may take the balance negative. That is deliberate: it is the
 *    honest accounting outcome, and because every spend path guards with
 *    `dpcoin >= amount`, a negative balance naturally blocks further spending and
 *    withdrawals instead of letting the loss disappear.
 *  - It is NOT unconditional, though. The debit is gated on a `payments` row
 *    existing for this payment id — see `notCreditedGate` below for why.
 *  - `clawback_shortfall` records how much of the clawback the user could not
 *    cover, which is the signal that someone is refund-farming. It is computed
 *    INSIDE the batch, against the same balance the debit reads.
 *  - Refunds ACCUMULATE. A payment may be refunded in instalments; each event
 *    claws back the difference between the proportional total owed so far and what
 *    has already been taken, so the coins reversed always match the money
 *    returned, and rounding (always UP, never favouring the refunder) cannot drift
 *    across several events.
 *  - Idempotency is per REFUND, not per payment: `refundId` is part of the claim
 *    key and the ledger id. Keyed on the payment alone, a second partial refund
 *    was indistinguishable from a duplicate delivery of the first and was dropped.
 *  - The order status becomes terminal (`refunded`/`disputed`) once the whole
 *    amount is back, so a late duplicate `payment.captured` retry can no longer
 *    re-credit it. A partial refund parks it in `partially_refunded`, which is
 *    equally uncreditable but still open to further refunds.
 */
export async function clawbackPaymentOrder(
  env: Env,
  db: Db,
  input: {
    paymentId: string;
    kind: ClawbackKind;
    refundedAmountPaise?: number | null;
    /**
     * The gateway's refund id, when the event carries one.
     *
     * This is what makes the claim per-refund. Without it two different partial
     * refunds of the same payment share a claim key, and the second is silently
     * swallowed as a replay of the first. Omitted (or null) keeps the legacy
     * whole-payment key, so a gateway event with no refund entity — and every
     * already-written claim and ledger row — still behaves exactly as before.
     */
    refundId?: string | null;
  },
): Promise<ClawbackResult> {
  const { paymentId, kind } = input;
  const order = await db
    .select()
    .from(schema.paymentOrders)
    .where(eq(schema.paymentOrders.paymentId, paymentId))
    .get();
  if (!order) return { clawedBack: false, reason: "order_not_found" };
  if ((TERMINAL_ORDER_STATUSES as readonly string[]).includes(order.status)) {
    return { clawedBack: false, reason: "already", uid: order.userId, fullyRefunded: true };
  }
  if (!(CLAWBACKABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) {
    // Never credited, so there is nothing to reverse. Still mark it terminal so
    // it cannot later be credited by a stale retry.
    await db
      .update(schema.paymentOrders)
      .set({ status: kind === "dispute" ? "disputed" : "refunded", refundedAt: now(), updatedAt: now() })
      .where(and(eq(schema.paymentOrders.orderId, order.orderId), eq(schema.paymentOrders.status, order.status)))
      .run();
    return { clawedBack: false, reason: "not_credited", uid: order.userId };
  }

  /**
   * `status = 'paid'` does NOT prove the coins landed.
   *
   * `creditPaymentOrder` claims an order by flipping it to `paid` in a statement
   * separate from the batch that credits the wallet — that separation is what
   * makes the claim exactly-once, and it is the entire reason
   * `recoverStrandedPaidOrders` exists below. So a `paid` order whose credit batch
   * was lost has no coins, no `payments` row and no ledger entry.
   *
   * Debiting such an order took coins the user never received (driving an innocent
   * balance negative), recorded a `clawback_shortfall`, raised an admin alert
   * accusing them of refund farming — and then flipped the status to `refunded`,
   * which removed the row from the recovery sweep's `status = 'paid'` filter so the
   * lost credit could never be found again.
   *
   * `payments` is the reliable marker precisely because it is written INSIDE the
   * credit batch: its absence means no coins were added. Marking the order
   * terminal here is still correct — the customer's money has been returned, so it
   * must never be credited — but nothing is debited and nobody is accused.
   */
  const credited = await db
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(eq(schema.payments.id, paymentId))
    .get();
  if (!credited) {
    await db
      .update(schema.paymentOrders)
      .set({
        status: kind === "dispute" ? "disputed" : "refunded",
        refundedAt: now(),
        refundedAmountPaise: Number(order.amountPaise) || 0,
        clawedBackCoins: 0,
        clawbackShortfall: 0,
        updatedAt: now(),
      })
      .where(and(eq(schema.paymentOrders.orderId, order.orderId), eq(schema.paymentOrders.status, order.status)))
      .run();
    console.warn(
      `[clawback] ${paymentId} was refunded but its coins never landed (no payments row) — ` +
        `marked terminal, nothing debited`,
    );
    return { clawedBack: false, reason: "not_credited", uid: order.userId, coins: 0 };
  }

  const creditedCoins = Number(order.coins) || 0;
  const expectedPaise = Number(order.amountPaise) || 0;
  const alreadyRefundedPaise = Math.max(0, Number(order.refundedAmountPaise) || 0);
  const alreadyClawedCoins = Math.max(0, Number(order.clawedBackCoins) || 0);
  const remainingPaise = Math.max(0, expectedPaise - alreadyRefundedPaise);

  // A dispute is always for the whole payment; a refund is for what the event says,
  // capped at what is left unrefunded. An amount-less refund event means "the rest".
  const thisRefundPaise =
    kind === "dispute"
      ? remainingPaise
      : input.refundedAmountPaise != null && Number.isFinite(input.refundedAmountPaise)
        ? Math.max(0, Math.min(Number(input.refundedAmountPaise), remainingPaise))
        : remainingPaise;
  const cumulativePaise = alreadyRefundedPaise + thisRefundPaise;
  const fullyRefunded = kind === "dispute" || expectedPaise <= 0 || cumulativePaise >= expectedPaise;

  // Proportional on the CUMULATIVE total, then minus what has already been taken.
  // Deriving each event's share independently would let `Math.ceil` compound: three
  // ~33% refunds would claw 34+34+34 = 102 coins out of 100.
  const targetClawTotal = fullyRefunded
    ? creditedCoins
    : Math.min(creditedCoins, Math.ceil((creditedCoins * cumulativePaise) / expectedPaise));
  const coinsToClaw = Math.max(0, targetClawTotal - alreadyClawedCoins);

  const ts = now();
  const newStatus = kind === "dispute" ? "disputed" : fullyRefunded ? "refunded" : "partially_refunded";
  const claimKey = input.refundId ? `clawback:${paymentId}:${input.refundId}` : `clawback:${paymentId}`;
  const nonce = crypto.randomUUID();
  const claimGate = `EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ? AND nonce = ?)`;
  const notCreditedGate = `EXISTS (SELECT 1 FROM payments WHERE id = ?)`;
  /**
   * The order update is a compare-and-swap on the EXACT pre-state we just read
   * (status AND cumulative refunded paise), and the money statements then require
   * the resulting post-state.
   *
   * Both halves are needed. Checking only the status would be ambiguous for a
   * `partially_refunded -> partially_refunded` transition, where the status is
   * unchanged and only the amount moves; checking only the amount would miss a
   * concurrent event that happened to refund the same number of paise. Together
   * they pin the row to the one transition this call performs, so a second event
   * that raced in between makes every statement no-op rather than double-debit.
   */
  const appliedGate =
    `${claimGate} AND ${notCreditedGate}` +
    ` AND (SELECT status FROM payment_orders WHERE order_id = ?) = ?` +
    ` AND COALESCE((SELECT refunded_amount_paise FROM payment_orders WHERE order_id = ?), 0) = ?`;
  const appliedBindings = [
    claimKey,
    nonce,
    paymentId,
    order.orderId,
    newStatus,
    order.orderId,
    cumulativePaise,
  ];
  // `payments` keeps carrying a truthful status: fully reversed rows leave the
  // revenue set entirely, a partial refund is flagged so reporting can net it off
  // against `payment_orders.refunded_amount_paise` rather than writing off the
  // whole payment.
  const paymentStatus = kind === "dispute" ? "disputed" : fullyRefunded ? "refunded" : "partially_refunded";

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (key, nonce, scope, created_at) VALUES (?, ?, ?, ?)`,
    ).bind(claimKey, nonce, "clawback", ts),
    env.DB.prepare(
      `UPDATE payment_orders
          SET status = ?, refunded_at = ?, refunded_amount_paise = ?,
              clawed_back_coins = ?,
              -- Computed HERE, not from a balance read taken before the batch: a
              -- concurrent spend or settlement between that read and this write
              -- made the persisted shortfall (and the refund-abuse alert built on
              -- it) numerically wrong. Inside the batch it sees the same balance
              -- the debit below is about to change.
              clawback_shortfall = COALESCE(clawback_shortfall, 0)
                + MAX(0, ? - MAX(0, COALESCE((SELECT dpcoin FROM users WHERE uid = ?), 0))),
              updated_at = ?
        WHERE order_id = ?
          AND status = ?
          AND COALESCE(refunded_amount_paise, 0) = ?
          AND ${claimGate}
          AND ${notCreditedGate}`,
    ).bind(
      newStatus,
      ts,
      cumulativePaise,
      alreadyClawedCoins + coinsToClaw,
      coinsToClaw,
      order.userId,
      ts,
      order.orderId,
      order.status,
      alreadyRefundedPaise,
      claimKey,
      nonce,
      paymentId,
    ),
  ];

  // A refund that returns money but claws back no further coins (a rounding
  // remainder, or a repeat of an amount already covered) still has to advance the
  // order's bookkeeping — but must not write a 0-coin ledger row or a no-op debit.
  if (coinsToClaw > 0) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO coin_transactions
           (id, uid, amount, type, description, created_at)
         SELECT ?, ?, ?, ?, ?, ?
          WHERE ${appliedGate}`,
      ).bind(
        // Suffixed only when a refund id is present, so ids already written for
        // whole-payment reversals keep matching.
        input.refundId ? `${kind}_clawback:${paymentId}:${input.refundId}` : `${kind}_clawback:${paymentId}`,
        order.userId,
        -coinsToClaw,
        kind === "dispute" ? "chargeback_clawback" : "refund_clawback",
        kind === "dispute"
          ? `Chargeback on payment ${paymentId} — ${coinsToClaw} coins reversed`
          : `Refund of payment ${paymentId} — ${coinsToClaw} coins reversed`,
        ts,
        ...appliedBindings,
      ),
      env.DB.prepare(
        `UPDATE users SET dpcoin = dpcoin - ?, updated_at = ? WHERE uid = ? AND ${appliedGate}`,
      ).bind(coinsToClaw, ts, order.userId, ...appliedBindings),
    );
  }
  statements.push(
    env.DB.prepare(`UPDATE payments SET status = ? WHERE id = ? AND ${appliedGate}`).bind(
      paymentStatus,
      paymentId,
      ...appliedBindings,
    ),
  );

  const results = await env.DB.batch(statements);

  /**
   * The ORDER UPDATE is the claim, so it is the only correct success probe.
   *
   * This used to read the `users` debit instead, which reported "already" whenever
   * that update matched no row — a deleted account being the obvious case — even
   * though the status flip and the ledger row HAD applied. The caller then skipped
   * both the user notification and the shortfall alert for a clawback that really
   * did happen.
   */
  if (Number(results[1]?.meta?.changes || 0) === 0) {
    return { clawedBack: false, reason: "already", uid: order.userId, coins: coinsToClaw };
  }

  // Re-read so the caller's notification and refund-abuse alert quote the shortfall
  // the database actually recorded, rather than a pre-batch estimate.
  const settled = await db
    .select({
      shortfall: schema.paymentOrders.clawbackShortfall,
      refundedPaise: schema.paymentOrders.refundedAmountPaise,
    })
    .from(schema.paymentOrders)
    .where(eq(schema.paymentOrders.orderId, order.orderId))
    .get();
  const totalShortfall = Math.max(0, Number(settled?.shortfall) || 0);

  return {
    clawedBack: coinsToClaw > 0,
    reason: coinsToClaw > 0 ? "clawed_back" : "already",
    uid: order.userId,
    coins: coinsToClaw,
    // This event's own contribution, which is what an alert should quote.
    shortfall: Math.max(0, totalShortfall - Math.max(0, Number(order.clawbackShortfall) || 0)),
    refundedPaise: Math.max(0, Number(settled?.refundedPaise) || cumulativePaise),
    fullyRefunded,
  };
}

export interface ReconcileSummary {
  checked: number;
  credited: number;
  expired: number;
  failed: number;
  coins: number;
  /** Orders that were already marked paid but whose coins never landed. */
  recovered: number;
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
  const summary: ReconcileSummary = { checked: 0, credited: 0, expired: 0, failed: 0, coins: 0, recovered: 0 };
  const rzp = await getRazorpayCredentials(env);
  if (!rzp.keyId || !rzp.keySecret) {
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

  const auth = `Basic ${btoa(`${rzp.keyId}:${rzp.keySecret}`)}`;

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

  await recoverStrandedPaidOrders(env, db, summary, limit);
  return summary;
}

/**
 * Second reconciliation phase: orders marked `paid` whose coins never landed.
 *
 * `creditPaymentOrder` claims an order by flipping its status to `paid` in a
 * statement that is SEPARATE from the batch that actually credits the wallet.
 * That separation is what makes the claim exactly-once, but it leaves a window:
 * if the isolate dies (or D1 rejects the batch) after the claim commits, the
 * order is in a terminal state with no coins, no `payments` row and no ledger
 * entry. The customer has paid and has nothing.
 *
 * Phase one above cannot recover it, because it only looks at `status = 'created'`
 * and `creditPaymentOrder` would return `already` for anything past the claim. So
 * this phase looks for the fingerprint of the failure instead: `paid`, with a
 * payment id, and no `payments` row for that id.
 *
 * `payments` is a reliable marker precisely because it is written INSIDE the
 * credit batch — its absence means the batch did not apply, so no coins were
 * added. It needs no gateway call: the claim already recorded the captured
 * payment id, and the amount was validated before the claim was taken.
 */
async function recoverStrandedPaidOrders(
  env: Env,
  db: Db,
  summary: ReconcileSummary,
  limit: number,
): Promise<void> {
  const ts = now();
  let stranded: any[] = [];
  try {
    stranded = await db
      .select()
      .from(schema.paymentOrders)
      .where(
        and(
          eq(schema.paymentOrders.status, "paid"),
          // Give the normal path time to finish before treating it as stranded.
          lt(schema.paymentOrders.createdAt, ts - RECONCILE_MIN_AGE_MS),
          lt(schema.paymentOrders.reconcileAttempts, RECONCILE_MAX_ATTEMPTS),
          sql`${schema.paymentOrders.paymentId} IS NOT NULL`,
          sql`NOT EXISTS (SELECT 1 FROM payments WHERE payments.id = ${schema.paymentOrders.paymentId})`,
        ),
      )
      .orderBy(asc(schema.paymentOrders.createdAt))
      .limit(limit)
      .all();
  } catch (e) {
    console.error("[reconcile] could not scan for stranded paid orders", e);
    return;
  }

  for (const order of stranded) {
    const paymentId = String(order.paymentId);
    const coins = Number(order.coins);
    if (!Number.isFinite(coins) || coins <= 0 || coins > 1_000_000) {
      summary.failed++;
      console.error(`[reconcile] stranded order ${order.orderId} has an implausible coin amount (${order.coins})`);
      continue;
    }

    // Back off first, so one permanently broken row cannot be retried forever.
    await db
      .update(schema.paymentOrders)
      .set({ reconcileAttempts: (order.reconcileAttempts ?? 0) + 1, reconciledAt: ts, updatedAt: ts })
      .where(eq(schema.paymentOrders.orderId, order.orderId))
      .run();

    const bonus = Number(order.bonusCoins) || 0;
    const base = coins - bonus;
    const description =
      bonus > 0 ? `Purchased ${base} Dpcoins + ${bonus} bonus` : `Purchased ${coins} Dpcoins`;

    try {
      // The ledger row and the balance are gated on the `payments` marker being
      // absent, and the marker is inserted LAST — D1 batches run sequentially, so
      // the two gates read the pre-insert state and either both apply or both
      // no-op. That also makes a concurrent second recovery attempt harmless.
      //
      // The ledger id is deterministic here (unlike the random one on the normal
      // credit path) so a repeated recovery cannot write a second row.
      const notCredited = `NOT EXISTS (SELECT 1 FROM payments WHERE id = ?)`;
      const results = await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO coin_transactions
             (id, uid, amount, type, description, created_at)
           SELECT ?, ?, ?, 'purchase', ?, ?
            WHERE ${notCredited}`,
        ).bind(`purchase:${paymentId}`, order.userId, coins, description, ts, paymentId),
        env.DB.prepare(
          `UPDATE users
              SET dpcoin = dpcoin + ?, updated_at = ?
            WHERE uid = ? AND ${notCredited}`,
        ).bind(coins, ts, order.userId, paymentId),
        env.DB.prepare(
          `INSERT OR IGNORE INTO payments
             (id, user_id, amount, coins, amount_paise, source, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'razorpay', 'success', ?)`,
        ).bind(paymentId, order.userId, coins, coins, Number(order.amountPaise) || 0, ts),
      ]);

      if (Number(results[1]?.meta?.changes || 0) > 0) {
        summary.recovered++;
        summary.coins += coins;
        // Loud on purpose: this means a customer paid and the credit was lost
        // until now, which is worth investigating even though it self-healed.
        console.error(
          `[reconcile] RECOVERED ${coins} coins for order ${order.orderId} (uid ${order.userId}, payment ${paymentId}) — ` +
            `the order was marked paid but the wallet credit never applied`,
        );
      }
    } catch (e) {
      summary.failed++;
      console.error(`[reconcile] failed to recover stranded order ${order.orderId}`, e);
    }
  }
}
