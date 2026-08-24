import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";
import { now } from "./ids";
import { openSecret, sealSecret, secretStorageAvailable } from "./secretBox";

/**
 * Every third-party integration, configurable from the admin panel.
 *
 * Two halves, deliberately stored differently:
 *
 *  1. CONFIG (this file's `IntegrationsConfig`) — provider choice, sender IDs,
 *     template ids, library ids, hostnames. Not secret, stored as plain JSON in
 *     `settings` under id `integrations`.
 *
 *  2. SECRETS (`integration_secrets`) — API keys and tokens, encrypted at rest
 *     (lib/secretBox.ts) and never readable through the API.
 *
 * Resolution order for every credential is: panel-managed secret first, then the
 * Cloudflare Worker environment. That ordering is what makes this safe to ship
 * to a running deployment: nothing breaks on deploy, and each credential can be
 * migrated into the panel one at a time. `integrationStatus()` reports which
 * source is actually in effect so there is no ambiguity about what is live.
 */

// ---------------------------------------------------------------------------
// Secret registry
// ---------------------------------------------------------------------------

export type SecretGroup = "sms" | "email" | "payments" | "video" | "storage" | "auth" | "observability";

export interface SecretDefinition {
  name: string;
  label: string;
  group: SecretGroup;
  /** Which env var holds the fallback value. */
  envKey: keyof Env & string;
  help?: string;
  /**
   * Platform-level credentials with a very large blast radius. Still manageable
   * (rotation without CLI access is a legitimate need) but the panel warns before
   * touching them.
   */
  sensitive?: boolean;
  multiline?: boolean;
}

/**
 * Allow-list of credentials that may be stored in the database.
 *
 * An allow-list, not an open key/value store: an admin API that could write ANY
 * named secret would be an arbitrary-configuration primitive, and a typo'd name
 * would silently do nothing rather than fail.
 */
export const SECRET_DEFINITIONS: SecretDefinition[] = [
  // ---- SMS gateways -------------------------------------------------------
  { name: "TWILIO_ACCOUNT_SID", label: "Twilio Account SID", group: "sms", envKey: "TWILIO_ACCOUNT_SID" },
  { name: "TWILIO_AUTH_TOKEN", label: "Twilio Auth Token", group: "sms", envKey: "TWILIO_AUTH_TOKEN" },
  { name: "MSG91_AUTH_KEY", label: "MSG91 Auth Key", group: "sms", envKey: "MSG91_AUTH_KEY", help: "MSG91 → Settings → API keys" },
  { name: "FAST2SMS_API_KEY", label: "Fast2SMS API Key", group: "sms", envKey: "FAST2SMS_API_KEY" },
  { name: "SMS_CUSTOM_TOKEN", label: "Custom gateway token", group: "sms", envKey: "SMS_CUSTOM_TOKEN", help: "Substituted into the custom gateway URL/body as {token}" },

  // ---- Email --------------------------------------------------------------
  { name: "RESEND_API_KEY", label: "Resend API Key", group: "email", envKey: "RESEND_API_KEY" },
  { name: "BREVO_API_KEY", label: "Brevo API Key", group: "email", envKey: "BREVO_API_KEY" },

  // ---- Payments -----------------------------------------------------------
  { name: "RAZORPAY_KEY_SECRET", label: "Razorpay Key Secret", group: "payments", envKey: "RAZORPAY_KEY_SECRET", help: "Signature verification AND payment reconciliation use this." },
  { name: "RAZORPAY_WEBHOOK_SECRET", label: "Razorpay Webhook Secret", group: "payments", envKey: "RAZORPAY_WEBHOOK_SECRET", help: "Without this the webhook returns 503 and paid orders are only credited by the reconciliation sweep." },

  // ---- Video (Bunny Stream) ----------------------------------------------
  { name: "BUNNY_STREAM_API_KEY", label: "Bunny Stream API Key", group: "video", envKey: "BUNNY_STREAM_API_KEY" },
  { name: "BUNNY_WEBHOOK_SECRET", label: "Bunny Webhook Secret", group: "video", envKey: "BUNNY_WEBHOOK_SECRET" },

  // ---- Storage (R2 S3 API, used for presigned uploads) -------------------
  { name: "R2_ACCESS_KEY_ID", label: "R2 Access Key ID", group: "storage", envKey: "R2_ACCESS_KEY_ID", sensitive: true },
  { name: "R2_SECRET_ACCESS_KEY", label: "R2 Secret Access Key", group: "storage", envKey: "R2_SECRET_ACCESS_KEY", sensitive: true },

  // ---- Auth / platform ---------------------------------------------------
  {
    name: "FIREBASE_SERVICE_ACCOUNT",
    label: "Firebase Service Account (JSON)",
    group: "auth",
    envKey: "FIREBASE_SERVICE_ACCOUNT",
    sensitive: true,
    multiline: true,
    help: "Full admin authority over the Firebase project. Rotate here only if you cannot use the CLI.",
  },

  // ---- Observability -----------------------------------------------------
  { name: "SENTRY_DSN", label: "Sentry DSN", group: "observability", envKey: "SENTRY_DSN" },
];

const SECRET_BY_NAME = new Map(SECRET_DEFINITIONS.map((d) => [d.name, d]));

export function secretDefinition(name: string): SecretDefinition {
  const def = SECRET_BY_NAME.get(name);
  if (!def) throw httpsError("invalid-argument", `Unknown credential "${name}".`);
  return def;
}

// ---------------------------------------------------------------------------
// Non-secret configuration
// ---------------------------------------------------------------------------

export type SmsProvider = "twilio" | "msg91" | "fast2sms" | "custom" | "none";
export type EmailProvider = "resend" | "brevo" | "none";
export type VideoProvider = "bunny" | "r2";

export interface IntegrationsConfig {
  sms: {
    provider: SmsProvider;
    /** Twilio: the purchased number. MSG91/Fast2SMS: the approved sender id. */
    from: string;
    /** DLT template id (MSG91 `template_id`, Fast2SMS `template_id`). */
    templateId: string;
    /** MSG91 flow variable name that carries the code. */
    otpVariable: string;
    /** Fast2SMS route: `dlt`, `otp` or `q`. */
    route: string;
    /** Custom gateway: URL with {to}, {message}, {token} placeholders. */
    customUrl: string;
    customMethod: "GET" | "POST";
    /** Custom gateway POST body template (JSON) with the same placeholders. */
    customBody: string;
  };
  email: {
    provider: EmailProvider;
    from: string;
    replyTo: string;
  };
  payments: {
    /** Public key id — safe to expose to the client. */
    razorpayKeyId: string;
  };
  video: {
    provider: VideoProvider;
    libraryId: string;
    cdnHostname: string;
  };
  push: {
    /** Web push public key. Public by design. */
    vapidPublicKey: string;
  };
}

export const DEFAULT_INTEGRATIONS: IntegrationsConfig = {
  sms: {
    provider: "none",
    from: "",
    templateId: "",
    otpVariable: "otp",
    route: "dlt",
    customUrl: "",
    customMethod: "GET",
    customBody: "",
  },
  email: { provider: "none", from: "", replyTo: "" },
  payments: { razorpayKeyId: "" },
  video: { provider: "r2", libraryId: "", cdnHostname: "" },
  push: { vapidPublicKey: "" },
};

const CONFIG_ID = "integrations";
const CONFIG_TTL_MS = 30_000;

/** Per-isolate cache. Config is read on hot paths (every OTP, every upload). */
let configCache: { at: number; value: IntegrationsConfig } | null = null;

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function mergeConfig(raw: any): IntegrationsConfig {
  const sms = raw?.sms ?? {};
  const email = raw?.email ?? {};
  const payments = raw?.payments ?? {};
  const video = raw?.video ?? {};
  const push = raw?.push ?? {};
  const smsProvider = ["twilio", "msg91", "fast2sms", "custom", "none"].includes(sms.provider)
    ? (sms.provider as SmsProvider)
    : DEFAULT_INTEGRATIONS.sms.provider;
  const emailProvider = ["resend", "brevo", "none"].includes(email.provider)
    ? (email.provider as EmailProvider)
    : DEFAULT_INTEGRATIONS.email.provider;
  const videoProvider = ["bunny", "r2"].includes(video.provider)
    ? (video.provider as VideoProvider)
    : DEFAULT_INTEGRATIONS.video.provider;
  return {
    sms: {
      provider: smsProvider,
      from: str(sms.from),
      templateId: str(sms.templateId),
      otpVariable: str(sms.otpVariable, DEFAULT_INTEGRATIONS.sms.otpVariable) || "otp",
      route: str(sms.route, DEFAULT_INTEGRATIONS.sms.route) || "dlt",
      customUrl: str(sms.customUrl),
      customMethod: sms.customMethod === "POST" ? "POST" : "GET",
      customBody: typeof sms.customBody === "string" ? sms.customBody : "",
    },
    email: {
      provider: emailProvider,
      from: str(email.from),
      replyTo: str(email.replyTo),
    },
    payments: { razorpayKeyId: str(payments.razorpayKeyId) },
    video: {
      provider: videoProvider,
      libraryId: str(video.libraryId),
      cdnHostname: str(video.cdnHostname).replace(/^https?:\/\//, "").replace(/\/$/, ""),
    },
    push: { vapidPublicKey: str(push.vapidPublicKey) },
  };
}

export async function getIntegrations(env: Env): Promise<IntegrationsConfig> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value;
  let raw: any = {};
  try {
    const row = await getDb(env)
      .select({ data: schema.settings.data })
      .from(schema.settings)
      .where(eq(schema.settings.id, CONFIG_ID))
      .get();
    raw = row?.data ?? {};
  } catch (e) {
    // Never let a settings read failure break a request path; the env fallbacks
    // below still apply.
    console.error("[integrations] config read failed (using defaults)", e);
  }
  const value = mergeConfig(raw);
  configCache = { at: Date.now(), value };
  return value;
}

export async function saveIntegrations(
  env: Env,
  patch: Partial<IntegrationsConfig>,
): Promise<IntegrationsConfig> {
  const current = await getIntegrations(env);
  const merged = mergeConfig({
    sms: { ...current.sms, ...(patch.sms ?? {}) },
    email: { ...current.email, ...(patch.email ?? {}) },
    payments: { ...current.payments, ...(patch.payments ?? {}) },
    video: { ...current.video, ...(patch.video ?? {}) },
    push: { ...current.push, ...(patch.push ?? {}) },
  });
  validateIntegrations(merged);
  const ts = now();
  await getDb(env)
    .insert(schema.settings)
    .values({ id: CONFIG_ID, data: merged as any, updatedAt: ts })
    .onConflictDoUpdate({ target: schema.settings.id, set: { data: merged as any, updatedAt: ts } });
  configCache = { at: Date.now(), value: merged };
  return merged;
}

/**
 * Reject configurations that would fail at send time.
 *
 * Each provider has required fields; catching them here means an admin finds out
 * while saving, not when a user's OTP silently never arrives.
 */
export function validateIntegrations(cfg: IntegrationsConfig): void {
  const { sms, email, video } = cfg;
  if (sms.provider === "twilio" && !sms.from) {
    throw httpsError("invalid-argument", "Twilio needs the sending phone number in E.164 form (e.g. +14155552671).");
  }
  if (sms.provider === "twilio" && sms.from && !/^\+\d{7,15}$/.test(sms.from)) {
    throw httpsError("invalid-argument", "Twilio sender must be an E.164 number, e.g. +14155552671.");
  }
  if ((sms.provider === "msg91" || sms.provider === "fast2sms") && !sms.from) {
    throw httpsError("invalid-argument", "An approved DLT sender ID is required for Indian SMS gateways.");
  }
  if (sms.provider === "msg91" && !sms.templateId) {
    throw httpsError("invalid-argument", "MSG91 requires the DLT-approved flow/template ID.");
  }
  if (sms.provider === "custom") {
    if (!/^https:\/\//.test(sms.customUrl)) {
      throw httpsError("invalid-argument", "The custom SMS gateway URL must be an https:// URL.");
    }
    if (!sms.customUrl.includes("{to}") || !sms.customUrl.includes("{message}")) {
      if (sms.customMethod === "GET") {
        throw httpsError(
          "invalid-argument",
          "A GET gateway URL must contain the {to} and {message} placeholders.",
        );
      }
    }
    if (sms.customMethod === "POST" && sms.customBody) {
      try {
        JSON.parse(sms.customBody.replace(/\{(to|message|token)\}/g, "x"));
      } catch {
        throw httpsError("invalid-argument", "The custom gateway body must be valid JSON.");
      }
    }
  }
  if (email.provider !== "none" && !email.from) {
    throw httpsError("invalid-argument", "A From address is required to send email.");
  }
  if (email.from && !/^[^<>@\s]+@[^<>@\s.]+\.[^<>@\s]+$|^.+<[^<>@\s]+@[^<>@\s.]+\.[^<>@\s]+>$/.test(email.from)) {
    throw httpsError("invalid-argument", 'From must be an email address, optionally as "Name <a@b.com>".');
  }
  if (video.provider === "bunny" && (!video.libraryId || !video.cdnHostname)) {
    throw httpsError("invalid-argument", "Bunny Stream needs both the Library ID and the pull-zone hostname.");
  }
  if (video.libraryId && !/^\d+$/.test(video.libraryId)) {
    throw httpsError("invalid-argument", "The Bunny Library ID is numeric.");
  }
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

interface SecretCacheEntry {
  at: number;
  value: string | null;
}
const SECRET_TTL_MS = 30_000;
const secretCache = new Map<string, SecretCacheEntry>();

/**
 * Resolve a credential: panel-managed value first, Worker environment second.
 *
 * Decrypted values are cached in ISOLATE MEMORY only, never in KV — a cache that
 * outlives the isolate would put plaintext credentials back into shared storage,
 * which is the exact thing the encryption is protecting against.
 */
export async function resolveSecret(env: Env, name: string): Promise<string | null> {
  const def = secretDefinition(name);
  const cached = secretCache.get(name);
  if (cached && Date.now() - cached.at < SECRET_TTL_MS) return cached.value;

  let value: string | null = null;
  if (secretStorageAvailable(env)) {
    try {
      const row = await getDb(env)
        .select({ ciphertext: schema.integrationSecrets.ciphertext, iv: schema.integrationSecrets.iv })
        .from(schema.integrationSecrets)
        .where(eq(schema.integrationSecrets.name, name))
        .get();
      if (row?.ciphertext && row.iv) value = await openSecret(env, row);
    } catch (e) {
      // A decryption or read failure must not silently downgrade to the env
      // value without a trace — that would hide a rotated encryption key.
      console.error(`[integrations] could not read stored credential ${name}`, e);
    }
  }
  if (!value) {
    const fromEnv = (env as any)[def.envKey];
    value = typeof fromEnv === "string" && fromEnv.trim() ? fromEnv : null;
  }
  secretCache.set(name, { at: Date.now(), value });
  return value;
}

/** Store or rotate a credential. Returns its fingerprint for display. */
export async function putSecret(
  env: Env,
  name: string,
  value: string,
  updatedBy: string | null,
): Promise<{ fingerprint: string; hint: string }> {
  const def = secretDefinition(name);
  const trimmed = def.multiline ? value.trim() : value.trim().replace(/\s+/g, "");
  if (!trimmed) throw httpsError("invalid-argument", `${def.label} cannot be empty.`);
  if (def.name === "FIREBASE_SERVICE_ACCOUNT") {
    // A malformed service account breaks every admin auth operation, and the
    // failure surfaces far from here.
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed.client_email || !parsed.private_key) throw new Error("missing fields");
    } catch {
      throw httpsError("invalid-argument", "The service account must be the full JSON key file (with client_email and private_key).");
    }
  }
  const sealed = await sealSecret(env, trimmed);
  const ts = now();
  await getDb(env)
    .insert(schema.integrationSecrets)
    .values({
      name,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      fingerprint: sealed.fingerprint,
      hint: sealed.hint,
      updatedBy,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: schema.integrationSecrets.name,
      set: {
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        fingerprint: sealed.fingerprint,
        hint: sealed.hint,
        updatedBy,
        updatedAt: ts,
      },
    });
  secretCache.delete(name);
  return { fingerprint: sealed.fingerprint, hint: sealed.hint };
}

/** Remove a panel-managed credential, falling back to the environment value. */
export async function deleteSecret(env: Env, name: string): Promise<void> {
  secretDefinition(name);
  await getDb(env)
    .delete(schema.integrationSecrets)
    .where(eq(schema.integrationSecrets.name, name))
    .run();
  secretCache.delete(name);
}

export interface SecretStatus {
  name: string;
  label: string;
  group: SecretGroup;
  help?: string;
  sensitive: boolean;
  multiline: boolean;
  configured: boolean;
  /** Which value is actually in effect. */
  source: "panel" | "environment" | "unset";
  hint?: string | null;
  fingerprint?: string | null;
  updatedAt?: number | null;
  updatedBy?: string | null;
}

/**
 * Report every credential's state WITHOUT revealing any value.
 *
 * `source` is the important field: it answers "is the key I typed into the panel
 * the one being used, or is a leftover environment value still winning?".
 */
export async function integrationSecretStatus(env: Env): Promise<SecretStatus[]> {
  const stored = new Map<string, any>();
  try {
    const rows = await getDb(env).select().from(schema.integrationSecrets).all();
    for (const row of rows) stored.set(row.name, row);
  } catch (e) {
    console.error("[integrations] secret status read failed", e);
  }
  return SECRET_DEFINITIONS.map((def) => {
    const row = stored.get(def.name);
    const envValue = (env as any)[def.envKey];
    const hasEnv = typeof envValue === "string" && envValue.trim().length > 0;
    const source: SecretStatus["source"] = row ? "panel" : hasEnv ? "environment" : "unset";
    return {
      name: def.name,
      label: def.label,
      group: def.group,
      help: def.help,
      sensitive: !!def.sensitive,
      multiline: !!def.multiline,
      configured: source !== "unset",
      source,
      hint: row?.hint ?? (hasEnv ? "•••• (from environment)" : null),
      fingerprint: row?.fingerprint ?? null,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  });
}

/** Clear the per-isolate caches (used after a settings write). */
export function invalidateIntegrationCache(): void {
  configCache = null;
  secretCache.clear();
}


// ---------------------------------------------------------------------------
// Convenience accessors for specific providers
// ---------------------------------------------------------------------------

export interface RazorpayCredentials {
  keyId: string | null;
  keySecret: string | null;
  webhookSecret: string | null;
}

/**
 * Razorpay credentials, panel-managed with environment fallback.
 *
 * The key ID is public (it is handed to the checkout SDK) so it lives in plain
 * config; the secret and webhook secret are encrypted. Everything stays
 * fail-closed: a missing secret means top-ups are refused, never free-minted.
 */
export async function getRazorpayCredentials(env: Env): Promise<RazorpayCredentials> {
  const [cfg, keySecret, webhookSecret] = await Promise.all([
    getIntegrations(env),
    resolveSecret(env, "RAZORPAY_KEY_SECRET"),
    resolveSecret(env, "RAZORPAY_WEBHOOK_SECRET"),
  ]);
  const keyId = cfg.payments.razorpayKeyId || (env.RAZORPAY_KEY_ID || "").trim() || null;
  return { keyId, keySecret, webhookSecret };
}

/** R2 S3-API credentials for presigned uploads, panel-managed with env fallback. */
export async function getR2Credentials(env: Env): Promise<{
  accountId: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  bucket: string | null;
}> {
  const [accessKeyId, secretAccessKey] = await Promise.all([
    resolveSecret(env, "R2_ACCESS_KEY_ID"),
    resolveSecret(env, "R2_SECRET_ACCESS_KEY"),
  ]);
  return {
    accountId: (env.R2_ACCOUNT_ID || "").trim() || null,
    accessKeyId,
    secretAccessKey,
    bucket: (env.R2_BUCKET || "").trim() || null,
  };
}

/** Firebase service account JSON, panel-managed with env fallback. */
export async function getFirebaseServiceAccount(env: Env): Promise<string | null> {
  return resolveSecret(env, "FIREBASE_SERVICE_ACCOUNT");
}

/** Sentry DSN, panel-managed with env fallback. */
export async function getSentryDsn(env: Env): Promise<string | null> {
  return resolveSecret(env, "SENTRY_DSN");
}
