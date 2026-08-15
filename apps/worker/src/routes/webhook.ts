/**
 * /webhook — public, server-to-server callbacks from payment gateways.
 *
 * These endpoints are NOT behind Firebase auth (the gateway can't present a
 * user token). Trust comes entirely from verifying the gateway's signature over
 * the RAW request body, so the body must be read as text before any parsing.
 *
 * Razorpay webhook (payment.captured / order.paid) is the reliable fallback for
 * the case where the user paid but the client never called `/api topup` (app
 * closed, network drop). It reconciles against the persisted `payment_orders`
 * row and credits exactly once (shared idempotency with the client callback).
 */
import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { getDb } from "../db";
import { verifyRazorpayWebhookSignature } from "../lib/payments";
import { creditPaymentOrder } from "../lib/coinOrders";
import { createNotification } from "../lib/notify";

export const webhookRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

webhookRoute.post("/razorpay", async (c) => {
  // Read the raw body FIRST — the signature is computed over these exact bytes.
  const raw = await c.req.text();
  const signature = c.req.header("X-Razorpay-Signature");

  if (!c.env.RAZORPAY_WEBHOOK_SECRET) {
    console.error("[webhook/razorpay] RAZORPAY_WEBHOOK_SECRET not configured — rejecting");
    return c.json({ ok: false, error: "not_configured" }, 503);
  }

  const valid = await verifyRazorpayWebhookSignature(c.env, raw, signature);
  if (!valid) {
    console.warn("[webhook/razorpay] invalid signature");
    return c.json({ ok: false, error: "invalid_signature" }, 400);
  }

  let evt: any;
  try {
    evt = JSON.parse(raw);
  } catch {
    return c.json({ ok: false, error: "bad_json" }, 400);
  }

  const type: string = evt?.event || "";
  const payment = evt?.payload?.payment?.entity;

  // We only act on successful-capture events. Everything else is acknowledged
  // (200) so Razorpay stops retrying — the signature is already verified.
  if ((type === "payment.captured" || type === "order.paid") && payment) {
    const orderId = payment.order_id;
    const paymentId = payment.id;
    const amount = Number(payment.amount); // paise

    if (orderId && paymentId) {
      const db = getDb(c.env);
      try {
        const res = await creditPaymentOrder(c.env, db, {
          orderId: String(orderId),
          paymentId: String(paymentId),
          source: "webhook",
          capturedAmountPaise: Number.isFinite(amount) ? amount : null,
        });
        if (res.credited && res.uid) {
          // Notify the user their coins landed (best-effort; don't block the ack).
          c.executionCtx.waitUntil(
            createNotification(c.env, res.uid, {
              title: "Coins Added 🎉",
              body: `${res.coins} Dpcoins have been added to your wallet.`,
              type: "purchase",
              targetId: "wallet",
            }).catch(() => {}),
          );
        } else if (!res.credited && res.reason !== "already") {
          console.warn(`[webhook/razorpay] order ${orderId} not credited: ${res.reason}`);
        }
      } catch (e) {
        // Log but still ack — Razorpay will retry, and the client callback is a
        // second chance. Returning 500 here just triggers noisy retries.
        console.error("[webhook/razorpay] credit failed", e);
      }
    }
  }

  return c.json({ ok: true });
});
