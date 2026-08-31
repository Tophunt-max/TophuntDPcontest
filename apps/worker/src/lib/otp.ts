/**
 * OTP storage in KV with native TTL — replaces the Firestore *Otps collections
 * (passwordResetOtps, emailUpdateOtps, phoneUpdateOtps).
 */
import type { Env } from "../types";
import { httpsError } from "./http";

const TEN_MIN = 10 * 60;
/** Max wrong guesses before the OTP is burned (anti brute-force). */
export const MAX_OTP_ATTEMPTS = 5;

export interface OtpRecord {
  otp: string;
  /** Number of failed verification attempts so far. */
  attempts?: number;
  /**
   * Absolute expiry (ms since epoch).
   *
   * Recording this is what makes the lifetime fixed. The attempt counter is
   * stored in the same KV value as the code, so incrementing it means re-writing
   * the value — and a re-write with a fresh TTL silently EXTENDED the code's
   * validity every time an attacker guessed wrong. With an absolute expiry the
   * re-write can restore the remaining TTL instead.
   */
  expiresAt?: number;
  // extra payload carried through verification (newEmail / newPhone)
  [k: string]: unknown;
}

function key(scope: string, id: string): string {
  return `otp:${scope}:${id}`;
}

/**
 * OTP purposes. Scopes are separate namespaces on purpose: a code issued to prove
 * ownership of a NEW phone number must not be accepted as proof of identity for a
 * deletion, and vice versa. Reusing one scope for two meanings is how a
 * confirmation code becomes an authorisation token.
 */
export type OtpScope = "pwreset" | "email" | "phone" | "reauth";

export async function setOtp(
  env: Env,
  scope: OtpScope,
  id: string,
  record: OtpRecord,
  ttlSeconds = TEN_MIN,
): Promise<void> {
  const expiresAt = record.expiresAt ?? Date.now() + ttlSeconds * 1000;
  await env.OTP_KV.put(
    key(scope, id),
    JSON.stringify({ ...record, expiresAt }),
    // KV requires a TTL of at least 60s; never extend beyond the original expiry.
    { expirationTtl: Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000)) },
  );
}

export async function getOtp(
  env: Env,
  scope: OtpScope,
  id: string,
): Promise<OtpRecord | null> {
  return env.OTP_KV.get<OtpRecord>(key(scope, id), "json");
}

export async function deleteOtp(
  env: Env,
  scope: OtpScope,
  id: string,
): Promise<void> {
  await env.OTP_KV.delete(key(scope, id));
}

/** Cryptographically-secure 6-digit OTP (not Math.random, which is predictable). */
export function generateOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Uniform-ish mapping into [100000, 999999].
  return (100000 + (buf[0] % 900000)).toString();
}

/** Constant-time-ish string compare to avoid timing side-channels on the OTP. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a submitted OTP with brute-force protection:
 *   - throws `not-found` if there is no active OTP,
 *   - throws `resource-exhausted` once MAX_OTP_ATTEMPTS wrong guesses are made
 *     (and burns the code),
 *   - throws `invalid-argument` on a wrong code (incrementing the counter),
 *   - on success DELETES the code (single-use) and returns the record.
 */
export async function verifyOtp(
  env: Env,
  scope: OtpScope,
  id: string,
  code: string | undefined,
): Promise<OtpRecord> {
  const rec = await getOtp(env, scope, id);
  if (!rec) throw httpsError("not-found", "No OTP found or it has expired. Please request a new one.");

  // KV's own TTL is the primary expiry, but a record written before `expiresAt`
  // existed (or one whose TTL was floored to KV's 60s minimum) is rejected here.
  if (rec.expiresAt != null && Number(rec.expiresAt) <= Date.now()) {
    await deleteOtp(env, scope, id);
    throw httpsError("not-found", "No OTP found or it has expired. Please request a new one.");
  }

  const attempts = Number(rec.attempts || 0);
  if (attempts >= MAX_OTP_ATTEMPTS) {
    await deleteOtp(env, scope, id);
    throw httpsError("resource-exhausted", "Too many incorrect attempts. Please request a new OTP.");
  }

  if (!code || !safeEqual(String(rec.otp), String(code))) {
    // Carrying `expiresAt` through keeps the original deadline: guessing wrong
    // must not buy the attacker more time.
    await setOtp(env, scope, id, { ...rec, attempts: attempts + 1 });
    throw httpsError("invalid-argument", "Invalid OTP.");
  }

  // Correct — burn it so it can't be replayed.
  await deleteOtp(env, scope, id);
  return rec;
}
