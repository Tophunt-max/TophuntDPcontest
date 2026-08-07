/**
 * OTP storage in KV with native TTL — replaces the Firestore *Otps collections
 * (passwordResetOtps, emailUpdateOtps, phoneUpdateOtps).
 */
import type { Env } from "../types";

const TEN_MIN = 10 * 60;

export interface OtpRecord {
  otp: string;
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

export function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
