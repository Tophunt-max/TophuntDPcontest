/**
 * Approval password — a second secret for actions that make the platform pay.
 *
 * The admin sign-in (Firebase + "sudo mode" re-auth) proves WHO is at the panel.
 * This proves the action is intended: creating or changing a promo budget,
 * linking a coin package or a contest to one, i.e. anything that lets coins be
 * paid out that nobody paid for. A stolen or left-open panel session is not
 * enough on its own to start giving coins away.
 *
 * Stored as a salted PBKDF2-SHA-256 hash in the `settings` table (row
 * `approvalSecret`). It is never stored or returned in a recoverable form, and
 * that row is only ever read by id here, never by any listing.
 *
 * The password travels in the JSON body as `approvalPassword` (not a header:
 * the API's CORS policy allows only Content-Type and Authorization). A missing
 * or wrong password answers 412 with reason `approval_required` /
 * `approval_invalid`, which the admin panel turns into its approval prompt.
 * Wrong guesses are rate limited per admin.
 */
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";
import { consumeRateLimit } from "./rateLimit";
import { now } from "./ids";

const SETTINGS_ID = "approvalSecret";
/** Cloudflare Workers cap PBKDF2 at 100,000 iterations. */
const ITERATIONS = 100_000;
const MIN_LENGTH = 6;
const MAX_LENGTH = 128;

export const APPROVAL_REQUIRED = "approval_required";
export const APPROVAL_INVALID = "approval_invalid";
export const APPROVAL_NOT_SET = "approval_not_set";

interface StoredSecret {
  salt: string;
  hash: string;
  iterations: number;
  updatedAt: number;
  updatedBy: string | null;
}

const toB64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return toB64(bits);
}

/** Constant-time compare of two base64 strings. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readSecret(env: Env): Promise<StoredSecret | null> {
  const row = await getDb(env).select({ data: schema.settings.data }).from(schema.settings).where(eq(schema.settings.id, SETTINGS_ID)).get();
  const data = row?.data as any;
  if (!data || typeof data.hash !== "string" || typeof data.salt !== "string") return null;
  return data as StoredSecret;
}

export async function approvalPasswordStatus(env: Env): Promise<{ configured: boolean; updatedAt: number | null }> {
  const s = await readSecret(env);
  return { configured: !!s, updatedAt: s?.updatedAt ?? null };
}

async function matches(secret: StoredSecret, password: string): Promise<boolean> {
  const hash = await derive(password, fromB64(secret.salt), secret.iterations || ITERATIONS);
  return sameSecret(hash, secret.hash);
}

const LOCK_SEC = 15 * 60;
const lockKey = (adminKey: string) => `approval:lock:${adminKey}`;
const LOCKED_MESSAGE = "Approval password bahut baar galat dala gaya. 15 minute baad try karo.";

/**
 * Refuse while an admin is locked out — checked BEFORE the password, so a
 * correct guess after the limit does not get through. Fail-closed on a KV error,
 * like the re-auth grant: "could not check" must not mean "allowed".
 */
async function assertNotLocked(env: Env, adminKey: string): Promise<void> {
  let locked = true;
  try {
    locked = (await env.OTP_KV.get(lockKey(adminKey))) !== null;
  } catch (e) {
    console.error("[approval] lock lookup failed (treating as locked)", e);
  }
  if (locked) throw httpsError("resource-exhausted", LOCKED_MESSAGE);
}

/** Count a wrong guess: the 5th within 15 minutes locks the admin out for 15 minutes. */
async function recordFailure(env: Env, adminKey: string): Promise<void> {
  const ok = await consumeRateLimit(env, `approval:${adminKey}`, 4, LOCK_SEC, { failClosed: true });
  if (!ok) {
    await env.OTP_KV.put(lockKey(adminKey), String(now()), { expirationTtl: LOCK_SEC }).catch((e) =>
      console.error("[approval] could not write lock", e),
    );
    throw httpsError("resource-exhausted", LOCKED_MESSAGE);
  }
}

/**
 * Require the approval password from `body.approvalPassword`.
 *
 * Server-to-server calls (shared admin secret, no user) are exempt, like the
 * re-auth gate: they have no person to prompt and already hold full access.
 */
export async function assertApproval(c: any, body: Record<string, any> | null | undefined): Promise<void> {
  const user = c.get("user");
  if (!user) return;
  const secret = await readSecret(c.env);
  if (!secret) {
    throw httpsError(
      "failed-precondition",
      "Pehle approval password set karo (Coin Economy → Approval password). Uske bina promo coins nahi diye ja sakte.",
      APPROVAL_NOT_SET,
    );
  }
  const given = typeof body?.approvalPassword === "string" ? body.approvalPassword : "";
  if (!given) {
    throw httpsError("failed-precondition", "Is action ke liye approval password chahiye.", APPROVAL_REQUIRED);
  }
  await assertNotLocked(c.env, user.uid);
  if (!(await matches(secret, given))) {
    await recordFailure(c.env, user.uid);
    throw httpsError("failed-precondition", "Approval password galat hai.", APPROVAL_INVALID);
  }
}

/** Remove the password from a body before it is logged or stored anywhere. */
export function withoutApproval<T extends Record<string, any>>(body: T): Omit<T, "approvalPassword"> {
  if (!body || typeof body !== "object") return body;
  const { approvalPassword: _omit, ...rest } = body;
  return rest;
}

/**
 * Set or change the approval password. Changing it needs the current one, so
 * an admin session alone cannot replace it and then use it.
 */
export async function setApprovalPassword(
  c: any,
  input: { current?: unknown; next?: unknown },
): Promise<void> {
  const next = typeof input.next === "string" ? input.next : "";
  if (next.length < MIN_LENGTH || next.length > MAX_LENGTH) {
    throw httpsError("invalid-argument", `Approval password ${MIN_LENGTH}–${MAX_LENGTH} characters ka hona chahiye.`);
  }
  const existing = await readSecret(c.env);
  const user = c.get("user");
  if (existing) {
    const current = typeof input.current === "string" ? input.current : "";
    if (user) await assertNotLocked(c.env, user.uid);
    if (!current || !(await matches(existing, current))) {
      if (user) await recordFailure(c.env, user.uid);
      throw httpsError("failed-precondition", "Purana approval password galat hai.", APPROVAL_INVALID);
    }
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ts = now();
  const data: StoredSecret = {
    salt: toB64(salt),
    hash: await derive(next, salt, ITERATIONS),
    iterations: ITERATIONS,
    updatedAt: ts,
    updatedBy: user?.uid ?? null,
  };
  await getDb(c.env)
    .insert(schema.settings)
    .values({ id: SETTINGS_ID, data: data as any, updatedAt: ts })
    .onConflictDoUpdate({ target: schema.settings.id, set: { data: data as any, updatedAt: ts } });
}
