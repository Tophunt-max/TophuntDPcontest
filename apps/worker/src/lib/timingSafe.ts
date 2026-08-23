/**
 * Constant-time comparison helpers for secrets and signatures.
 *
 * A plain `===` on a secret short-circuits at the first differing byte, which
 * leaks a byte-at-a-time oracle to an attacker who can measure response time.
 */

/**
 * Constant-time compare for values whose length is already public — hex digests
 * of a fixed size, for example. The length check itself is not constant-time,
 * which is fine when both sides are the same known width.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Constant-time compare for an arbitrary secret of unknown length.
 *
 * Both sides are hashed first, so the comparison always runs over 32 bytes and
 * reveals nothing about the real secret's length. Use this for shared secrets
 * (e.g. `ADMIN_PROXY_SECRET`) rather than `timingSafeEqualHex`.
 */
export async function timingSafeEqualSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const viewA = new Uint8Array(digestA);
  const viewB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < viewA.length; i++) diff |= viewA[i] ^ viewB[i];
  return diff === 0;
}
