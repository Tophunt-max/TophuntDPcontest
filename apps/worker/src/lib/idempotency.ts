/**
 * Idempotency keys for critical writes.
 *
 * When a caller includes an idempotency key on a mutating action (a coin
 * purchase, a match join, a wallet adjustment, a broadcast), the same key cannot
 * be processed twice — protecting against double-submits, retries, and flaky
 * networks charging a user twice or paying an admin adjustment out twice.
 *
 * Backed by D1 (`idempotency_keys`), NOT KV.
 *
 * The previous KV implementation was a read-then-write with no compare-and-swap
 * on an eventually-consistent store, and it explicitly failed OPEN on any KV
 * error. Two genuinely simultaneous retries therefore both observed "unused" and
 * both proceeded, which is precisely the case the layer exists to stop. A
 * PRIMARY KEY insert in a transactional store is atomic by construction: exactly
 * one writer can win, always.
 */
import { and, eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";

const scopedKey = (uid: string, key: string) => `api:${uid}:${key}`;

/**
 * Claim an idempotency key. Throws `already-exists` if it was already used.
 *
 * Returns the nonce that won the claim, which callers can use to gate SQL
 * statements inside a transaction (see lib/money.ts `adjustUserWallet`).
 */
export async function claimIdempotencyKey(
  env: Env,
  key: string,
  scope: string,
): Promise<string> {
  const nonce = crypto.randomUUID();
  const claim = await getDb(env)
    .insert(schema.idempotencyKeys)
    .values({ key, nonce, scope, createdAt: Date.now() })
    .onConflictDoNothing()
    .run();
  if (Number(claim.meta?.changes || 0) === 0) {
    throw httpsError("already-exists", "Duplicate request (idempotency key already used).");
  }
  return nonce;
}

/**
 * Claim an idempotency key for `uid`. Throws `already-exists` if the key was
 * already used.
 *
 * Unlike the old KV version this does NOT fail open: if the claim cannot be
 * established we refuse the request rather than risk executing it twice. A
 * duplicate charge is worse than a retryable error.
 */
export async function enforceIdempotency(
  env: Env,
  uid: string,
  idempotencyKey: string,
  _ttlSec = 86_400,
): Promise<void> {
  await claimIdempotencyKey(env, scopedKey(uid, idempotencyKey), "api");
}

/**
 * Release a previously-claimed key. Called when the guarded action FAILED, so a
 * legitimate retry isn't locked out after a genuine failure (nothing was
 * committed, so the key should not persist).
 */
export async function releaseIdempotency(
  env: Env,
  uid: string,
  idempotencyKey: string,
): Promise<void> {
  try {
    await getDb(env)
      .delete(schema.idempotencyKeys)
      .where(and(
        eq(schema.idempotencyKeys.key, scopedKey(uid, idempotencyKey)),
        eq(schema.idempotencyKeys.scope, "api"),
      ))
      .run();
  } catch (e) {
    console.error("[idempotency] release failed", e);
  }
}

/**
 * Idempotency for admin actions, keyed off the standard `Idempotency-Key`
 * request header.
 *
 * `/admin` had no idempotency layer at all: a double-clicked "+1000 coins", a
 * repeated grant, or a re-submitted broadcast simply happened twice. Money
 * routes that already have a compare-and-swap (withdrawals, deposits, match
 * settlement) are safe without this; the ones that mutate on every call are not.
 *
 * Returns a `finish` callback: call it with `false` when the action threw, so the
 * claim is released and the admin can legitimately retry.
 */
export async function enforceAdminIdempotency(
  c: { req: { header: (name: string) => string | undefined }; env: Env },
  scope: string,
  targetId?: string,
): Promise<{ replayed: false; finish: (ok: boolean) => Promise<void> } | null> {
  const header = c.req.header("Idempotency-Key");
  if (!header) return null;
  const key = `admin:${scope}:${targetId ?? "-"}:${header}`;
  await claimIdempotencyKey(c.env, key, "admin");
  return {
    replayed: false,
    finish: async (ok: boolean) => {
      if (ok) return;
      try {
        await getDb(c.env).delete(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, key)).run();
      } catch (e) {
        console.error("[idempotency] admin release failed", key, e);
      }
    },
  };
}
