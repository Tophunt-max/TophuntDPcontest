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
import { creditPaymentOrder } from "../lib/coinOrders";
import { createNotification } from "../lib/notify";
import { timingSafeEqualSecret } from "../lib/timingSafe";
import { now } from "../lib/ids";
import {
  bunnyConfigured,
  bunnyMp4Url,
  bunnyPlaybackUrl,
  bunnyThumbnailUrl,
  getVideo,
  mapBunnyStatus,
} from "../lib/bunny";
import { promoteBackfilledVideo } from "../lib/videoBackfill";

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

  if (!bunnyConfigured(c.env)) {
    console.error("[webhook/bunny] Bunny is not configured — rejecting");
    return c.json({ ok: false, error: "not_configured" }, 503);
  }

  // Bunny's webhook does not sign its payload by default. When a secret IS
  // configured we require it, so the endpoint can be locked down; otherwise the
  // handler is safe because it only ever trusts data re-fetched from Bunny's API
  // below, never the values in the request body.
  const configuredSecret = (c.env.BUNNY_WEBHOOK_SECRET || "").trim();
  if (configuredSecret) {
    const presented =
      c.req.header("X-Bunny-Signature") ||
      c.req.header("Authorization")?.replace(/^Bearer\s+/i, "") ||
      new URL(c.req.url).searchParams.get("secret") ||
      "";
    if (!(await timingSafeEqualSecret(presented, configuredSecret))) {
      console.warn("[webhook/bunny] invalid signature");
      return c.json({ ok: false, error: "invalid_signature" }, 400);
    }
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

    // Re-fetch from Bunny rather than trusting the body: this endpoint may be
    // unauthenticated, so the request payload is not a source of truth.
    const meta = await getVideo(c.env, guid);
    const status = mapBunnyStatus(
      typeof meta?.status === "number" ? meta.status : Number(evt?.Status),
    );

    const ts = now();
    if (status === "processing") {
      await db
        .update(schema.videos)
        .set({ status, updatedAt: ts })
        .where(eq(schema.videos.id, guid))
        .run();
      return c.json({ ok: true, status });
    }

    if (status === "failed") {
      await db
        .update(schema.videos)
        .set({ status, errorMessage: "Bunny reported encoding failure", updatedAt: ts })
        .where(eq(schema.videos.id, guid))
        .run();
      return c.json({ ok: true, status });
    }

    // ready
    const durationSec =
      typeof meta?.length === "number" && Number.isFinite(meta.length)
        ? Math.round(meta.length)
        : null;
    await db
      .update(schema.videos)
      .set({
        status: "ready",
        thumbnailUrl: bunnyThumbnailUrl(c.env, guid),
        playbackUrl: bunnyPlaybackUrl(c.env, guid),
        mp4Url: bunnyMp4Url(c.env, guid),
        durationSec: durationSec ?? undefined,
        updatedAt: ts,
      })
      .where(eq(schema.videos.id, guid))
      .run();

    const owner = await db
      .select({
        ownerUid: schema.videos.ownerUid,
        targetType: schema.videos.targetType,
        targetId: schema.videos.targetId,
        targetSide: schema.videos.targetSide,
        r2SourceUrl: schema.videos.r2SourceUrl,
      })
      .from(schema.videos)
      .where(eq(schema.videos.id, guid))
      .get();

    // Backfilled videos cut over HERE, not at enqueue time: only now does the
    // Bunny playlist actually exist, so only now is it safe to repoint the
    // story / contest entry away from its R2 original.
    if (owner?.r2SourceUrl) {
      try {
        await promoteBackfilledVideo(c.env, { id: guid, ...owner });
      } catch (e) {
        console.error("[webhook/bunny] promote failed", guid, e);
      }
    }

    // Let the uploader know their video went live (best-effort, never blocks ack).
    if (owner?.ownerUid) {
      c.executionCtx.waitUntil(
        createNotification(c.env, owner.ownerUid, {
          title: "Video ready 🎬",
          body:
            owner.targetType === "story"
              ? "Your story video has finished processing."
              : "Your contest video has finished processing.",
          type: "video_ready",
          targetId: guid,
        }).catch(() => {}),
      );
    }

    return c.json({ ok: true, status: "ready" });
  } catch (e) {
    // Ack anyway — retries would just repeat the same internal failure, and the
    // status is reconcilable by polling Bunny.
    console.error("[webhook/bunny] processing failed", e);
    return c.json({ ok: true, error: "internal" });
  }
});
