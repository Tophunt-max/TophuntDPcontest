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
import { bunnyConfigured, getBunnyWebhookSecret } from "../lib/bunny";
import { applyBunnyEncodeResult } from "../lib/videoReconcile";

export const webhookRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Tell the user their coins were reversed, so a negative balance isn't a mystery. */
async function notifyClawback(env: Env, uid: string, coins: number, what: string): Promise<void> {
  await createNotification(env, uid, {
    title: "Coins Reversed",
    body: `A payment was ${what}, so ${coins} Dpcoins have been removed from your wallet.`,
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
        console.error("[webhook/razorpay] clawback failed", paymentId, e);
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
        console.error("[webhook/razorpay] dispute clawback failed", paymentId, e);
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
        });
        if (res.credited && res.uid) {
          // Notify the user their coins landed (best-effort; don't block the ack).
          const creditedUid = res.uid;
          const creditedCoins = res.coins;
          c.executionCtx.waitUntil(
            createNotification(c.env, creditedUid, {
              title: "Coins Added 🎉",
              body: `${creditedCoins} Dpcoins have been added to your wallet.`,
              type: "purchase",
              targetId: "wallet",
            }).catch(() => {}),
          );
          // A top-up is a purchase — send a receipt the user can keep.
          c.executionCtx.waitUntil(sendUserEmail(c.env, creditedUid, coinsAddedEmail(creditedCoins)));
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


/**
 * Bunny Stream encoding callback (MEDIA_MIGRATION_PLAN.md Phase 2d).
 *
 * Bunny POSTs `{ VideoLibraryId, VideoGuid, Status }` when an encode changes
 * state. We flip the `videos` row to ready/failed and record the poster frame
 * and duration so clients can drop their "Processing…" overlay.
 *
 * Follows the same discipline as the Razorpay hook above:
 *  - read the RAW body first, so a signature can be verified over exact bytes;
 *  - acknowledge with 200 even on internal failure, so Bunny stops retrying;
 *  - fail closed on configuration (503) rather than trusting an unverified call.
 */
webhookRoute.post("/bunny", async (c) => {
  const raw = await c.req.text();

  if (!(await bunnyConfigured(c.env))) {
    console.error("[webhook/bunny] Bunny is not configured — rejecting");
    return c.json({ ok: false, error: "not_configured" }, 503);
  }

  /**
   * Bunny's webhook does not sign its payload, so a shared secret is the only
   * authentication available — and it is now REQUIRED.
   *
   * It used to be enforced only `if (configuredSecret)`, which meant the default
   * deployment left this endpoint completely open: anyone could POST a `VideoGuid`
   * and force an encode-state transition. The blast radius was genuinely limited
   * (the handler re-fetches the truth from Bunny's API rather than trusting the
   * body, so it is forced work rather than forged state), but "limited" is not the
   * same as "authenticated", and every other webhook here already fails closed —
   * `/webhook/razorpay` returns 503 when its secret is missing.
   *
   * Failing closed is also the safe direction operationally: Bunny's webhook is
   * OPTIONAL, and the encode-state cron plus the live recheck in `videoStatus`
   * both already cover the case where it never fires. So a deployment without the
   * secret configured loses nothing but the latency improvement, and gets a loud
   * log line telling it what to set.
   *
   * Panel-managed with env fallback — a secret saved in the admin panel must
   * actually take effect, which reading env directly did not honour.
   */
  const configuredSecret = ((await getBunnyWebhookSecret(c.env)) || "").trim();
  if (!configuredSecret) {
    console.error(
      "[webhook/bunny] no Bunny webhook secret configured (panel or env) — rejecting. " +
        "Encode state still resolves via the reconcileVideos cron and the videoStatus recheck.",
    );
    return c.json({ ok: false, error: "not_configured" }, 503);
  }
  // Header only. The secret used to be accepted from `?secret=` as well, which put
  // a long-lived shared credential into every proxy, CDN and access log that
  // records query strings — and unlike a header it is trivially leaked by a
  // referrer or a copied URL.
  const presented =
    c.req.header("X-Bunny-Signature") ||
    c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  if (!(await timingSafeEqualSecret(presented, configuredSecret))) {
    console.warn("[webhook/bunny] invalid signature");
    return c.json({ ok: false, error: "invalid_signature" }, 400);
  }

  let evt: any;
  try {
    evt = JSON.parse(raw);
  } catch {
    return c.json({ ok: false, error: "bad_json" }, 400);
  }

  const guid: string = String(evt?.VideoGuid || evt?.videoGuid || "");
  if (!guid) return c.json({ ok: true, ignored: "no_guid" });

  try {
    const db = getDb(c.env);
    const existing = await db
      .select({ id: schema.videos.id, status: schema.videos.status })
      .from(schema.videos)
      .where(eq(schema.videos.id, guid))
      .get();
    // A guid we never issued (or already deleted) — ack and move on.
    if (!existing) return c.json({ ok: true, ignored: "unknown_video" });
    if (existing.status === "ready") return c.json({ ok: true, ignored: "already_ready" });

    // Apply the transition through the SAME code the reconcile cron uses, so the
    // webhook and the safety-net poll can never disagree about what a status
    // means. It re-fetches from Bunny rather than trusting this (possibly
    // unauthenticated) request body, and fires the owner notification in the
    // background so this handler still acks fast.
    const status = await applyBunnyEncodeResult(c.env, guid, {
      statusHint: Number(evt?.Status),
      scheduleNotify: (p) => c.executionCtx.waitUntil(p),
    });
    return c.json({ ok: true, status });
  } catch (e) {
    // Ack anyway — retries would just repeat the same internal failure, and the
    // status is reconcilable by polling Bunny (the reconcile cron does exactly
    // that).
    console.error("[webhook/bunny] processing failed", e);
    return c.json({ ok: true, error: "internal" });
  }
});
