import type { Env } from "../types";
import { httpsError } from "./http";

/**
 * Authenticated encryption for credentials that admins manage from the panel.
 *
 * WHY THIS EXISTS
 *
 * Third-party credentials (SMS gateway, email, payment gateway, video CDN) used
 * to be Cloudflare Worker secrets only, which meant changing an SMS provider or
 * rotating a key required CLI access and a deploy. That is not workable for an
 * operations team.
 *
 * Storing them as plaintext rows in D1 would be the easy fix and a bad one: any
 * read primitive against the settings table would hand over every credential at
 * once. So values are encrypted with AES-256-GCM before they are written, using a
 * key that lives ONLY as a Cloudflare secret (`SETTINGS_ENCRYPTION_KEY`).
 *
 * The properties that matter:
 *  - The database alone is useless: without the Worker's encryption key the
 *    ciphertext cannot be read.
 *  - GCM is authenticated, so a tampered row fails to decrypt instead of
 *    silently yielding attacker-chosen bytes.
 *  - Secrets are WRITE-ONLY through the API. The panel can set or rotate a value
 *    and see a fingerprint, but the plaintext is never returned to a browser.
 *  - If the encryption key is absent, writes are REFUSED rather than falling back
 *    to plaintext.
 */

// Domain-separation label mixed into the derivation, so this key cannot collide
// with a key derived from the same passphrase for some other purpose. Public by
// nature — named to avoid reading like key material to secret scanners.
const DERIVATION_LABEL = "tophunt.integration-secrets.v1";

/**
 * Derived keys, cached BY KEY MATERIAL rather than globally.
 *
 * A single module-level cache would make the memo outlive the value it was
 * derived from: after one successful derivation, a later call with a rotated — or
 * removed — `SETTINGS_ENCRYPTION_KEY` would keep using the stale key and appear to
 * work. Keying the cache on the material means a changed key derives a new
 * CryptoKey and an absent key fails, which is the behaviour the callers assume.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

async function importKey(raw: string): Promise<CryptoKey> {
  if (!raw) {
    throw httpsError(
      "failed-precondition",
      "SETTINGS_ENCRYPTION_KEY is not configured on the server, so credentials cannot be stored securely. " +
        "Generate one with `openssl rand -base64 32` and set it with `wrangler secret put SETTINGS_ENCRYPTION_KEY`.",
    );
  }
  // Accept any passphrase length: derive a fixed 256-bit key from it. This keeps
  // setup forgiving (a pasted base64 string or a long random phrase both work)
  // without weakening AES itself.
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${DERIVATION_LABEL}:${raw}`),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function getKey(env: Env): Promise<CryptoKey> {
  const raw = (env.SETTINGS_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    // Checked on every call, not once: removing the key must immediately stop
    // credential writes rather than being masked by a warm cache.
    return importKey("");
  }
  const existing = keyCache.get(raw);
  if (existing) return existing;
  // Per-isolate memo: derivation is cheap, but this runs on hot paths (every OTP
  // send resolves the SMS credential).
  const derived = importKey(raw).catch((e) => {
    keyCache.delete(raw);
    throw e;
  });
  keyCache.set(raw, derived);
  return derived;
}

const b64 = {
  encode(bytes: Uint8Array): string {
    let out = "";
    for (const b of bytes) out += String.fromCharCode(b);
    return btoa(out);
  },
  decode(text: string): Uint8Array {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  /** Non-reversible identifier so an admin can confirm WHICH value is stored. */
  fingerprint: string;
  /** Last 4 characters, for display like `••••••3f9a`. */
  hint: string;
}

/** Short, non-reversible fingerprint of a secret value. */
export async function secretFingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sealSecret(env: Env, value: string): Promise<SealedSecret> {
  const key = await getKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value),
  );
  return {
    ciphertext: b64.encode(new Uint8Array(encrypted)),
    iv: b64.encode(iv),
    fingerprint: await secretFingerprint(value),
    hint: value.length <= 4 ? "••••" : `••••${value.slice(-4)}`,
  };
}

export async function openSecret(
  env: Env,
  sealed: { ciphertext: string; iv: string },
): Promise<string> {
  const key = await getKey(env);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64.decode(sealed.iv) },
      key,
      b64.decode(sealed.ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // Authenticated encryption: this means the row was tampered with, or the
    // encryption key changed. Either way the value must NOT be used.
    throw httpsError(
      "internal",
      "A stored credential could not be decrypted. If SETTINGS_ENCRYPTION_KEY was rotated, re-enter the affected credentials in the admin panel.",
    );
  }
}

/** True when the server is able to store panel-managed credentials at all. */
export function secretStorageAvailable(env: Env): boolean {
  return !!(env.SETTINGS_ENCRYPTION_KEY || "").trim();
}
