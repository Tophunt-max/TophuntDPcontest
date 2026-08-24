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
import { and, eq, ne, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { newId, now } from "./ids";

type Db = ReturnType<typeof getDb>;

export interface CreditOrderInput {
  orderId: string;
  paymentId: string;
  /** "callback" (client) or "webhook" (server-to-server). */
  source: "callback" | "webhook";
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

  // Atomic idempotency claim: flip created -> paid. If another path already
  // credited this order, `changes` is 0 and we no-op.
  const claim = await db
    .update(schema.paymentOrders)
    .set({ status: "paid", paymentId, source, creditedAt: ts, updatedAt: ts })
    .where(and(eq(schema.paymentOrders.orderId, orderId), ne(schema.paymentOrders.status, "paid")))
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
