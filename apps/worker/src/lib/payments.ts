/**
 * Server-side payment verification for coin top-ups.
 *
 * Uses Razorpay's standard signature scheme: the client returns
 * `razorpay_order_id`, `razorpay_payment_id` and `razorpay_signature` from the
 * checkout, and the server recomputes HMAC_SHA256(order_id | payment_id) with
 * the secret key and compares. This is what proves a real payment happened —
 * without it, a client could mint unlimited coins by calling topup directly.
 *
 * Fail-closed: if no Razorpay key secret is configured — in the admin panel or in
 * the environment — top-ups are rejected (see the topup handler), never credited
 * for free.
 */
import type { Env } from "../types";
import { getRazorpayCredentials } from "./integrations";
import { timingSafeEqualHex } from "./timingSafe";

export interface RazorpayProof {
  orderId: string;
  paymentId: string;
  signature: string;
}

/**
 * Verify a Razorpay checkout signature. Returns false when the payment secret
 * is not configured or any field is missing (caller must fail-closed).
 */
export async function verifyRazorpaySignature(env: Env, proof: RazorpayProof): Promise<boolean> {
  // Panel-managed credential with environment fallback — see lib/integrations.ts.
  const { keySecret: secret } = await getRazorpayCredentials(env);
  if (!secret || !proof.orderId || !proof.paymentId || !proof.signature) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${proof.orderId}|${proof.paymentId}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualHex(expected, String(proof.signature).toLowerCase());
}

/**
 * Verify a Razorpay WEBHOOK signature. Razorpay signs the RAW request body with
 * the webhook secret (configured in the dashboard) and sends the hex HMAC in the
 * `X-Razorpay-Signature` header. This is a different secret and scheme from the
 * checkout signature above — the whole body is the message here.
 *
 * Fail-closed: returns false when the webhook secret is not configured or the
 * signature header is missing, so an unverified event is never credited.
 */
export async function verifyRazorpayWebhookSignature(
  env: Env,
  rawBody: string,
  signature: string | null | undefined,
): Promise<boolean> {
  const { webhookSecret: secret } = await getRazorpayCredentials(env);
  if (!secret || !signature) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualHex(expected, String(signature).toLowerCase());
}
