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

  // --- Plain vars ---
  FIREBASE_PROJECT_ID: string;
  R2_PUBLIC_BASE_URL: string;
  ALLOWED_ORIGINS: string;

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
};
