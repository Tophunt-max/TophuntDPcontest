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
  // extra payload carried through verification (newEmail / newPhone)
  [k: string]: unknown;
}

function key(scope: string, id: string): string {
  return `otp:${scope}:${id}`;
}

export async function setOtp(
  env: Env,
  scope: "pwreset" | "email" | "phone",
  id: string,
  record: OtpRecord,
  ttlSeconds = TEN_MIN,
): Promise<void> {
  await env.OTP_KV.put(key(scope, id), JSON.stringify(record), { expirationTtl: ttlSeconds });
}

export async function getOtp(
  env: Env,
  scope: "pwreset" | "email" | "phone",
  id: string,
): Promise<OtpRecord | null> {
  return env.OTP_KV.get<OtpRecord>(key(scope, id), "json");
}

export async function deleteOtp(
  env: Env,
  scope: "pwreset" | "email" | "phone",
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
  scope: "pwreset" | "email" | "phone",
  id: string,
  code: string | undefined,
): Promise<OtpRecord> {
  const rec = await getOtp(env, scope, id);
  if (!rec) throw httpsError("not-found", "No OTP found or it has expired. Please request a new one.");

  const attempts = Number(rec.attempts || 0);
  if (attempts >= MAX_OTP_ATTEMPTS) {
    await deleteOtp(env, scope, id);
    throw httpsError("resource-exhausted", "Too many incorrect attempts. Please request a new OTP.");
  }

  if (!code || !safeEqual(String(rec.otp), String(code))) {
    await setOtp(env, scope, id, { ...rec, attempts: attempts + 1 });
    throw httpsError("invalid-argument", "Invalid OTP.");
  }

  // Correct — burn it so it can't be replayed.
  await deleteOtp(env, scope, id);
  return rec;
}
