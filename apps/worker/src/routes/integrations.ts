import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { httpsError } from "../lib/http";
import { writeAdminAudit } from "../lib/adminAuthz";
import {
  DEFAULT_INTEGRATIONS,
  deleteSecret,
  getIntegrations,
  getRazorpayCredentials,
  integrationSecretStatus,
  invalidateIntegrationCache,
  putSecret,
  saveIntegrations,
  secretDefinition,
  resolveSecret,
} from "../lib/integrations";
import { secretStorageAvailable } from "../lib/secretBox";
import { sendSmsDetailed, smsConfigured } from "../lib/sms";
import { emailConfigured, sendEmailDetailed } from "../lib/email";
import { bunnyConfig } from "../lib/bunny";

/**
 * /admin/integrations — one place to configure every third-party service.
 *
 * Design rules:
 *
 *  - Credential VALUES are write-only. Reads return a masked hint, a fingerprint
 *    and which source is in effect, never the secret itself, so a compromised
 *    admin session cannot exfiltrate keys by simply loading a page.
 *  - Every change is audited, and the audit detail never contains a secret.
 *  - Each provider has a "test" action that exercises the real credential
 *    server-side, because a settings page that cannot prove the key works just
 *    moves the debugging problem somewhere less convenient.
 *
 * Mounted under the /admin router, so it inherits that gate. Every handler
 * additionally requires a FULL admin — these settings control money and identity.
 */
export function registerIntegrationRoutes(
  adminRoute: Hono<{ Bindings: Env; Variables: Variables }>,
  requireFullAdmin: (c: any) => void,
) {
  /** Current configuration + credential status. Never returns a secret value. */
  adminRoute.get("/integrations", async (c) => {
    requireFullAdmin(c);
    const [config, secrets] = await Promise.all([
      getIntegrations(c.env),
      integrationSecretStatus(c.env),
    ]);
    return c.json({
      config,
      defaults: DEFAULT_INTEGRATIONS,
      secrets,
      /**
       * When false, panel-managed credentials cannot be stored at all (the server
       * has no SETTINGS_ENCRYPTION_KEY) and the panel explains how to add one
       * rather than silently failing to save.
       */
      secretStorage: secretStorageAvailable(c.env),
    });
  });

  /** Update the non-secret configuration (provider choice, sender IDs, ids). */
  adminRoute.put("/integrations", async (c) => {
    requireFullAdmin(c);
    const body = await c.req.json<any>();
    if (!body || typeof body !== "object") throw httpsError("invalid-argument", "A configuration object is required.");
    const saved = await saveIntegrations(c.env, {
      sms: body.sms,
      email: body.email,
      payments: body.payments,
      video: body.video,
      push: body.push,
    });
    await writeAdminAudit(c.env, c.get("user"), "integrations.update", "settings", "integrations", {
      smsProvider: saved.sms.provider,
      emailProvider: saved.email.provider,
      videoProvider: saved.video.provider,
    });
    return c.json({ success: true, config: saved });
  });

  /** Store or rotate a credential. The value is encrypted before it is written. */
  adminRoute.put("/integrations/secrets/:name", async (c) => {
    requireFullAdmin(c);
    const name = c.req.param("name");
    const def = secretDefinition(name);
    if (!secretStorageAvailable(c.env)) {
      throw httpsError(
        "failed-precondition",
        "This server cannot store credentials securely yet. Generate a key with `openssl rand -base64 32` and set it with `wrangler secret put SETTINGS_ENCRYPTION_KEY`.",
      );
    }
    const { value } = await c.req.json<any>();
    if (typeof value !== "string") throw httpsError("invalid-argument", "A string value is required.");

    const stored = await putSecret(c.env, name, value, c.get("user")?.uid ?? "server");
    // The fingerprint is a one-way hash, safe to record; the value never is.
    await writeAdminAudit(c.env, c.get("user"), "integrations.secret.set", "credential", name, {
      label: def.label,
      fingerprint: stored.fingerprint,
    });
    return c.json({ success: true, ...stored });
  });

  /**
   * Remove a panel-managed credential.
   *
   * This does NOT necessarily disable the integration: if the same credential is
   * present in the environment, that value takes over. The response says which,
   * so "delete" never leaves the admin guessing what is live.
   */
  adminRoute.delete("/integrations/secrets/:name", async (c) => {
    requireFullAdmin(c);
    const name = c.req.param("name");
    const def = secretDefinition(name);
    await deleteSecret(c.env, name);
    const fallback = (c.env as any)[def.envKey];
    const hasEnvFallback = typeof fallback === "string" && fallback.trim().length > 0;
    await writeAdminAudit(c.env, c.get("user"), "integrations.secret.delete", "credential", name, {
      label: def.label,
      fellBackToEnvironment: hasEnvFallback,
    });
    return c.json({
      success: true,
      fellBackToEnvironment: hasEnvFallback,
      message: hasEnvFallback
        ? `Removed. The value configured in the server environment is now in effect for ${def.label}.`
        : `Removed. ${def.label} is now unset.`,
    });
  });

  /**
   * Exercise a provider with its real credential.
   *
   * Nothing here echoes a secret back; the result is a pass/fail plus the
   * provider's own error message, which is what actually helps diagnose a
   * rejected key or an unapproved DLT template.
   */
  adminRoute.post("/integrations/test/:provider", async (c) => {
    requireFullAdmin(c);
    const provider = c.req.param("provider");
    const body = await c.req.json<any>().catch(() => ({}));

    switch (provider) {
      case "sms": {
        const to = String(body?.to ?? "").trim();
        if (!to) throw httpsError("invalid-argument", "A destination phone number is required for the test.");
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const result = await sendSmsDetailed(
          c.env,
          to,
          `${code} is your TopHunt test code. Ignore it if you did not request a test.`,
          code,
        );
        await writeAdminAudit(c.env, c.get("user"), "integrations.test", "sms", result.provider, {
          ok: result.ok,
        });
        return c.json({
          ok: result.ok,
          provider: result.provider,
          id: result.id,
          error: result.error,
          message: result.ok
            ? `Test SMS accepted by ${result.provider}. Check the handset — acceptance is not delivery.`
            : result.error,
        });
      }

      case "email": {
        const to = String(body?.to ?? "").trim();
        if (!to) throw httpsError("invalid-argument", "A destination email address is required for the test.");
        const result = await sendEmailDetailed(c.env, {
          to,
          subject: "TopHunt email test",
          html: "<p>This is a test from the TopHunt admin panel. If you received it, transactional email is working.</p>",
          text: "This is a test from the TopHunt admin panel.",
        });
        await writeAdminAudit(c.env, c.get("user"), "integrations.test", "email", result.provider, {
          ok: result.ok,
        });
        return c.json({
          ok: result.ok,
          provider: result.provider,
          id: result.id,
          error: result.error,
          message: result.ok ? `Test email accepted by ${result.provider}.` : result.error,
        });
      }

      case "razorpay": {
        const creds = await getRazorpayCredentials(c.env);
        if (!creds.keyId || !creds.keySecret) {
          return c.json({ ok: false, message: "Razorpay key ID and key secret are both required." });
        }
        // Authenticated read-only call: proves the credential pair is valid
        // without creating anything.
        const res = await fetch("https://api.razorpay.com/v1/payments?count=1", {
          headers: { Authorization: `Basic ${btoa(`${creds.keyId}:${creds.keySecret}`)}` },
        });
        const text = await res.text();
        await writeAdminAudit(c.env, c.get("user"), "integrations.test", "razorpay", null, { ok: res.ok });
        return c.json({
          ok: res.ok,
          message: res.ok
            ? "Razorpay credentials are valid."
            : `Razorpay rejected the credentials (${res.status}): ${text.slice(0, 200)}`,
          webhookSecretConfigured: !!creds.webhookSecret,
        });
      }

      case "bunny": {
        const cfg = await bunnyConfig(c.env);
        if (!cfg) {
          return c.json({
            ok: false,
            message: "Bunny needs an API key, a numeric Library ID and the pull-zone hostname.",
          });
        }
        const res = await fetch(`https://video.bunnycdn.com/library/${cfg.libraryId}/videos?itemsPerPage=1`, {
          headers: { AccessKey: cfg.apiKey, Accept: "application/json" },
        });
        const text = await res.text();
        await writeAdminAudit(c.env, c.get("user"), "integrations.test", "bunny", cfg.libraryId, { ok: res.ok });
        return c.json({
          ok: res.ok,
          message: res.ok
            ? `Connected to Bunny library ${cfg.libraryId}.`
            : `Bunny rejected the request (${res.status}): ${text.slice(0, 200)}`,
        });
      }

      case "firebase": {
        // Minting an access token is the operation every admin auth call depends
        // on, so it is the honest test of the service account.
        try {
          const { getAccessToken } = await import("../lib/firebaseAdmin");
          await getAccessToken(c.env);
          return c.json({ ok: true, message: "Firebase service account is valid." });
        } catch (e: any) {
          return c.json({ ok: false, message: e?.message || "Could not authenticate with Firebase." });
        }
      }

      case "sentry": {
        const dsn = await resolveSecret(c.env, "SENTRY_DSN");
        return c.json({
          ok: !!dsn,
          message: dsn
            ? "A Sentry DSN is configured. Errors will be forwarded."
            : "No Sentry DSN configured — server errors are only persisted to the error log.",
        });
      }

      default:
        throw httpsError("invalid-argument", `Unknown integration "${provider}".`);
    }
  });

  /** Drop the per-isolate caches (after an out-of-band change). */
  adminRoute.post("/integrations/refresh", async (c) => {
    requireFullAdmin(c);
    invalidateIntegrationCache();
    return c.json({ success: true });
  });
}

/** Readiness of each integration, for the deep health check. */
export async function integrationHealth(env: Env): Promise<Record<string, boolean>> {
  const [sms, email, razorpay, bunny] = await Promise.all([
    smsConfigured(env),
    emailConfigured(env),
    getRazorpayCredentials(env).then((c) => !!c.keyId && !!c.keySecret),
    bunnyConfig(env).then((c) => !!c),
  ]);
  return { sms, email, razorpay, bunnyVideo: bunny };
}
