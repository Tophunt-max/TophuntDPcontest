/**
 * Cloudflare bindings + secrets available to the Worker.
 * Bindings come from wrangler.toml; secrets from `wrangler secret put`.
 */
export interface Env {
  // --- Bindings (wrangler.toml) ---
  DB: D1Database;
  MEDIA: R2Bucket;
  OTP_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  REALTIME: DurableObjectNamespace;
  // Per-match vote aggregator (SQLite-backed DO) — keeps the high-frequency
  // vote write path off D1's single writer. Typed for native RPC calls.
  VOTE_COUNTER: DurableObjectNamespace<import("./voteCounter").VoteCounter>;

  // --- Plain vars ---
  FIREBASE_PROJECT_ID: string;
  R2_PUBLIC_BASE_URL: string;
  ALLOWED_ORIGINS: string;
  // "true" once Cloudflare Transformations is enabled on the media zone. While
  // this is off, lib/media.ts returns original URLs for every *Thumb /
  // *Optimized field. See transformationsAvailable().
  MEDIA_TRANSFORMATIONS?: string;

  // --- Secrets (wrangler secret put) ---
  // Firebase Admin service account (JSON string) used for Identity Toolkit + FCM.
  FIREBASE_SERVICE_ACCOUNT: string;

  // R2 S3-compatible credentials for presigned uploads.
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;

  // Twilio (SMS OTP).
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_PHONE_NUMBER: string;

  // Email provider (Gmail SMTP cannot run on Workers — use an HTTP provider such
  // as Resend). RESEND_API_KEY + EMAIL_FROM are used by lib/email.ts.
  RESEND_API_KEY: string;
  EMAIL_FROM: string;

  // Shared secret for server-to-server admin calls (the admin Next.js API
  // routes proxy to /admin/* with this in the X-Admin-Secret header).
  ADMIN_PROXY_SECRET: string;

  // Bunny Stream (video hosting/transcoding). Fail-closed: without the API key
  // and library id, `createVideoUpload` is rejected and /webhook/bunny returns
  // 503, so video uploads fall back to the existing R2 path rather than
  // silently breaking. The API key must NEVER reach the client — the Worker
  // mints short-lived TUS signatures instead.
  BUNNY_STREAM_API_KEY?: string;
  BUNNY_LIBRARY_ID?: string;
  /** Pull-zone hostname, e.g. "vz-xxxx.b-cdn.net". Not a secret. */
  BUNNY_CDN_HOSTNAME?: string;
  /** Webhook signing secret, if configured in the Bunny dashboard. */
  BUNNY_WEBHOOK_SECRET?: string;

  // Razorpay payment gateway — used to verify coin top-ups server-side.
  // If RAZORPAY_KEY_SECRET is unset, top-ups are rejected (never free-minted).
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  // Razorpay webhook signing secret (set in the Razorpay dashboard when you
  // configure the webhook). Used to verify /webhook/razorpay payloads. If unset,
  // webhook events are rejected (never credited) — the client callback still works.
  RAZORPAY_WEBHOOK_SECRET?: string;

  // Observability — optional. When SENTRY_DSN is set, unhandled server errors
  // are forwarded to Sentry (in addition to structured console logs). If unset,
  // error tracking is a no-op and nothing else changes.
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;

  // -------------------------------------------------------------------------
  // Panel-managed integrations.
  //
  // Every credential below can also be set from the admin panel, where it is
  // stored encrypted in D1 (lib/secretBox.ts). Resolution order is ALWAYS
  // panel-managed value first, then these environment variables — so an existing
  // deployment keeps working untouched and credentials can be migrated into the
  // panel one at a time. `GET /admin/integrations` reports which source is live.
  // -------------------------------------------------------------------------

  /**
   * Master key for encrypting panel-managed credentials. Stays a Cloudflare
   * secret and is NEVER stored in the database — it is what makes the encrypted
   * rows useless on their own.
   *
   * Generate: `openssl rand -base64 32`
   * Set:      `wrangler secret put SETTINGS_ENCRYPTION_KEY`
   *
   * Without it, panel-managed credential WRITES are refused (there is no
   * plaintext fallback) and the environment variables above are used as before.
   */
  SETTINGS_ENCRYPTION_KEY?: string;

  // Alternative SMS gateways (Indian DLT gateways are usually cheaper than
  // Twilio for OTP traffic). The active provider is an admin-panel setting.
  MSG91_AUTH_KEY?: string;
  FAST2SMS_API_KEY?: string;
  /** Token substituted into a custom gateway's URL/body as {token}. */
  SMS_CUSTOM_TOKEN?: string;

  // Alternative transactional email provider.
  BREVO_API_KEY?: string;
}

/** Authenticated user context attached by the auth middleware. */
export interface AuthUser {
  uid: string;
  email?: string;
  role?: string;
}

/** Hono context variables. */
export type Variables = {
  user: AuthUser;
  requestId: string;
  // Effective admin role for the current /admin request: "superadmin" | "admin"
  // | "moderator". Server-to-server (shared secret) calls are "superadmin".
  adminRole: string;
};
