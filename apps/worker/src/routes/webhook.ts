/**
 * /webhook — public, server-to-server callbacks (payment gateway, video encoder).
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
import { eq } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { verifyRazorpayWebhookSignature } from "../lib/payments";
import { clawbackPaymentOrder, creditPaymentOrder } from "../lib/coinOrders";
import { getRazorpayCredentials } from "../lib/integrations";
import { createNotification } from "../lib/notify";
import { sendUserEmail } from "../lib/email";
import { coinsAddedEmail, coinsReversedEmail } from "../lib/emailTemplates";
import { timingSafeEqualSecret } from "../lib/timingSafe";
import { newId, now } from "../lib/ids";
import { callbackSignature, isVideoId, qencodeConfig, qencodeConfigured } from "../lib/qencode";
import { applyEncodeResult } from "../lib/videoReconcile";

export const webhookRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Tell the user their coins were reversed, so a negative balance isn't a mystery. */
async function notifyClawback(env: Env, uid: string, coins: number, what: string): Promise<void> {
  await createNotification(env, uid, {
    title: "Purchase Reversed",
    body: `A payment was ${what}, so ${coins} (Diamond first, then DP coin) have been removed from your wallet.`,
    type: "purchase",
    targetId: "wallet",
  });
  // A clawback can push a balance negative and block withdrawals — the user is
  // owed a durable record of why, not just an in-app toast they may miss.
  await sendUserEmail(env, uid, coinsReversedEmail(coins, what));
}

/**
 * Raise an admin notification when a clawback could not be fully recovered
 * (the coins were already spent) or when a chargeback is opened at all.
 * Refund-farming is invisible without this.
 */
async function flagClawbackShortfall(
  env: Env,
  paymentId: string,
  uid: string | undefined,
  shortfall: number,
  isDispute = false,
): Promise<void> {
  const db = getDb(env);
  await db.insert(schema.adminNotifications).values({
    id: newId(),
    title: isDispute ? "Chargeback opened" : "Refund clawback shortfall",
    message:
      `Payment ${paymentId}` +
      (uid ? ` (user ${uid})` : "") +
      (shortfall > 0
        ? ` — ${shortfall} coins could not be recovered; the balance is now negative. Review for refund abuse.`
        : " — coins were fully recovered."),
    link: uid ? `/users/${uid}` : null,
    createdAt: now(),
  });
}

webhookRoute.post("/razorpay", async (c) => {
  // Read the raw body FIRST — the signature is computed over these exact bytes.
  const raw = await c.req.text();
  const signature = c.req.header("X-Razorpay-Signature");

  if (!(await getRazorpayCredentials(c.env)).webhookSecret) {
    console.error("[webhook/razorpay] no Razorpay webhook secret configured (panel or env) — rejecting");
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

  // ---- Refunds and chargebacks: reverse the credit -----------------------
  //
  // Every event other than a successful capture used to be silently 200'd, so a
  // refunded or disputed payment left the coins credited and spendable. These
  // are the events that must claw them back.
  const refund = evt?.payload?.refund?.entity;
  const dispute = evt?.payload?.dispute?.entity;

  if (type === "refund.created" || type === "refund.processed") {
    const paymentId = refund?.payment_id ?? payment?.id;
    if (paymentId) {
      try {
        const res = await clawbackPaymentOrder(c.env, getDb(c.env), {
          paymentId: String(paymentId),
          kind: "refund",
          refundedAmountPaise: Number(refund?.amount) || null,
          // Razorpay allows several partial refunds against one payment, each
          // arriving as its own event. Passing the refund id is what lets the
          // second one be recognised as a NEW refund rather than a duplicate
          // delivery of the first — without it, a payment refunded as 2x50%
          // clawed back only the first half and the user kept the rest.
          refundId: refund?.id ? String(refund.id) : null,
          orderId: payment?.order_id ? String(payment.order_id) : null,
        });
        if (res.clawedBack) {
          console.warn(
            `[webhook/razorpay] refund clawed back ${res.coins} coins from ${res.uid}` +
              ` (${res.refundedPaise} paise refunded in total, ${res.fullyRefunded ? "fully" : "partially"} refunded)` +
              (res.shortfall ? ` (shortfall ${res.shortfall} — balance went negative)` : ""),
          );
          if (res.uid) {
            c.executionCtx.waitUntil(
              notifyClawback(c.env, res.uid, res.coins ?? 0, "refunded").catch(() => {}),
            );
          }
          if (res.shortfall && res.shortfall > 0) {
            // The user had already spent the refunded coins. Surface it for review
            // rather than absorbing the loss silently.
            c.executionCtx.waitUntil(
              flagClawbackShortfall(c.env, String(paymentId), res.uid, res.shortfall).catch(() => {}),
            );
          }
        } else if (res.reason !== "already") {
          console.warn(`[webhook/razorpay] refund not applied for ${paymentId}: ${res.reason}`);
        }
      } catch (e) {
        // Must NOT be acknowledged: nothing else sweeps refunds, so a 200 here
        // after a transient D1 error left refunded coins spendable forever.
        // A non-2xx makes Razorpay redeliver; the clawback is idempotent per
        // refund id, so the retry cannot double-debit.
        console.error("[webhook/razorpay] clawback failed", paymentId, e);
        return c.json({ ok: false, error: "processing_failed" }, 500);
      }
    }
    return c.json({ ok: true });
  }

  if (type === "payment.dispute.created" || type === "payment.dispute.lost") {
    const paymentId = dispute?.payment_id ?? payment?.id;
    if (paymentId) {
      try {
        const res = await clawbackPaymentOrder(c.env, getDb(c.env), {
          paymentId: String(paymentId),
          kind: "dispute",
          refundedAmountPaise: Number(dispute?.amount) || null,
          refundId: dispute?.id ? String(dispute.id) : null,
          orderId: payment?.order_id ? String(payment.order_id) : null,
        });
        if (res.clawedBack) {
          console.warn(`[webhook/razorpay] chargeback clawed back ${res.coins} coins from ${res.uid}`);
          if (res.uid) {
            c.executionCtx.waitUntil(
              notifyClawback(c.env, res.uid, res.coins ?? 0, "charged back").catch(() => {}),
            );
          }
          c.executionCtx.waitUntil(
            flagClawbackShortfall(c.env, String(paymentId), res.uid, res.shortfall ?? 0, true).catch(() => {}),
          );
        }
      } catch (e) {
        // Same as refunds: a non-2xx so Razorpay redelivers (idempotent per dispute id).
        console.error("[webhook/razorpay] dispute clawback failed", paymentId, e);
        return c.json({ ok: false, error: "processing_failed" }, 500);
      }
    }
    return c.json({ ok: true });
  }

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
          capturedCurrency: typeof payment.currency === "string" ? payment.currency : null,
        });
        if (res.credited && res.uid) {
          // Notify the user their coins landed (best-effort; don't block the ack).
          const creditedUid = res.uid;
          const creditedCoins = res.coins;
          c.executionCtx.waitUntil(
            createNotification(c.env, creditedUid, {
              title: "Diamond Added 💎",
              body: `${creditedCoins} Diamond have been added to your wallet.`,
              type: "purchase",
              targetId: "wallet",
            }).catch(() => {}),
          );
          // A top-up is a purchase — send a receipt the user can keep.
          c.executionCtx.waitUntil(sendUserEmail(c.env, creditedUid, coinsAddedEmail(creditedCoins)));
        } else if (!res.credited && res.reason !== "already") {
          console.warn(`[webhook/razorpay] order ${orderId} not credited: ${res.reason}`);
          // The customer paid and got nothing: tell finance instead of leaving it
          // in the logs (the order stays `created` and only shows as "stuck").
          if (res.reason === "amount_mismatch") {
            c.executionCtx.waitUntil(
              getDb(c.env)
                .insert(schema.adminNotifications)
                .values({
                  id: newId(),
                  title: "Payment amount mismatch",
                  message: `Order ${orderId} / payment ${paymentId}: captured ${amount} paise does not match the order. No Diamonds were credited; refund or credit it manually.`,
                  link: res.uid ? `/users/${res.uid}` : null,
                  createdAt: now(),
                })
                .run()
                .catch((e) => console.error("[webhook/razorpay] mismatch alert failed", e)),
            );
          }
        }
      } catch (e) {
        // Razorpay only redelivers a webhook that did NOT get a 2xx, so the old
        // "log but ack 200" here meant it never retried. Crediting is idempotent
        // (status CAS + gated wallet batch), so a retry is always safe.
        console.error("[webhook/razorpay] credit failed", e);
        return c.json({ ok: false, error: "processing_failed" }, 500);
      }
    }
  }

  return c.json({ ok: true });
});


/**
 * Qencode job callback (`callback_url` set by `startEncode`).
 *
 * Qencode POSTs form-encoded `task_token`, `event` (queued | saved | error) and a
 * `status` JSON on each job event. It does not sign them, and it cannot send a
 * custom header, so authentication is the per-video HMAC that `startEncode` put
 * in the callback URL (`?v=<videoId>&sig=<hmac>`). See `callbackSignature` for
 * why that is a per-video value and not a shared secret.
 *
 * The body is never trusted for STATE. Like the Razorpay hook re-reading the
 * order, this re-reads the job from Qencode's /v1/status (using the job handle
 * stored on OUR row) and the playlist from R2, through the same
 * `applyEncodeResult` the reconcile cron uses. A forged or replayed callback can
 * therefore only cause a re-check.
 *
 *  - 503 when Qencode is not configured, so nothing is processed half-wired;
 *  - 400 on a bad signature;
 *  - 200 otherwise, including internal failures — the cron reconciles them, and
 *    a retry storm would only repeat the same failure.
 */
webhookRoute.post("/qencode", async (c) => {
  if (!(await qencodeConfigured(c.env))) {
    console.error("[webhook/qencode] Qencode is not configured — rejecting");
    return c.json({ ok: false, error: "not_configured" }, 503);
  }
  const cfg = await qencodeConfig(c.env);
  if (!cfg) return c.json({ ok: false, error: "not_configured" }, 503);

  const videoId = c.req.query("v") || "";
  const presented = c.req.query("sig") || "";
  if (!isVideoId(videoId) || !presented) return c.json({ ok: false, error: "invalid_signature" }, 400);
  if (!(await timingSafeEqualSecret(presented, await callbackSignature(cfg, videoId)))) {
    console.warn("[webhook/qencode] invalid signature", videoId);
    return c.json({ ok: false, error: "invalid_signature" }, 400);
  }

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await c.req.text());
  } catch {
    return c.json({ ok: false, error: "bad_body" }, 400);
  }
  const taskToken = form.get("task_token") || "";
  const event = form.get("event") || "";

  try {
    const db = getDb(c.env);
    const existing = await db
      .select({ id: schema.videos.id, status: schema.videos.status, jobId: schema.videos.jobId })
      .from(schema.videos)
      .where(eq(schema.videos.id, videoId))
      .get();
    // Deleted since (story removed mid-encode) — ack and move on.
    if (!existing) return c.json({ ok: true, ignored: "unknown_video" });
    // A callback for a job that is not this row's current one (an old job, or a
    // signature reused with someone else's token) changes nothing.
    if (taskToken && existing.jobId && taskToken !== existing.jobId) {
      return c.json({ ok: true, ignored: "stale_job" });
    }
    if (existing.status === "ready" || existing.status === "failed") {
      return c.json({ ok: true, ignored: `already_${existing.status}` });
    }
    // `queued` arrives right after start; there is nothing new to learn yet.
    if (event === "queued") return c.json({ ok: true, ignored: "queued" });

    const status = await applyEncodeResult(c.env, videoId, {
      scheduleNotify: (p) => c.executionCtx.waitUntil(p),
    });
    return c.json({ ok: true, status });
  } catch (e) {
    console.error("[webhook/qencode] processing failed", videoId, e);
    return c.json({ ok: true, error: "internal" });
  }
});
