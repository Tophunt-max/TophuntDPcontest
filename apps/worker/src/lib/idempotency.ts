/**
 * Idempotency keys for critical writes.
 *
 * When a client includes `idempotencyKey` on a mutating /api action (e.g. a
 * coin purchase, join, or reward claim), the same key can't be processed twice
 * — protecting against double-submits, retries, and flaky networks charging a
 * user twice.
 *
 * Backed by CACHE_KV (fail-open on transport errors). Enforcement only kicks in
 * when the client sends a key, so it is fully non-breaking.
 */
import type { Env } from "../types";
import { httpsError } from "./http";

const idemKey = (uid: string, key: string) => `idem:${uid}:${key}`;

/**
 * Claim an idempotency key for `uid`. Throws `already-exists` if the key was
 * already used within the TTL window (default 24h).
 *
 * NOTE: KV has no compare-and-swap, so this is best-effort against truly
 * simultaneous retries. The authoritative money-safety guarantees live in the
 * handlers themselves (conditional `WHERE` + affected-row checks); this layer
 * is a cheap first line of defence against double-submits/retries.
 */
export async function enforceIdempotency(
  env: Env,
  uid: string,
  idempotencyKey: string,
  ttlSec = 86_400,
): Promise<void> {
  const key = idemKey(uid, idempotencyKey);
  try {
    const seen = await env.CACHE_KV.get(key);
    if (seen) {
      throw httpsError("already-exists", "Duplicate request (idempotency key already used).");
    }
    await env.CACHE_KV.put(key, "1", { expirationTtl: ttlSec });
  } catch (e: any) {
    if (e?.code === "already-exists") throw e;
    console.error("[idempotency] KV error (failing open)", e);
  }
}

/**
 * Release a previously-claimed key. Called when the guarded action FAILED, so a
 * legitimate retry isn't locked out for the full TTL after a genuine failure
 * (nothing was committed, so the key should not persist).
 */
export async function releaseIdempotency(
  env: Env,
  uid: string,
  idempotencyKey: string,
): Promise<void> {
  try {
    await env.CACHE_KV.delete(idemKey(uid, idempotencyKey));
  } catch (e) {
    console.error("[idempotency] release failed", e);
  }
}
