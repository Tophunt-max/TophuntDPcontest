/**
 * Deep health of the deployment, computed once and served two ways.
 *
 * `/health/deep` (public, returns 503 when unhealthy) is what an uptime monitor
 * hits. The admin panel's System Health console needs the SAME picture, but
 * behind the admin gate and always as 200 (so the panel's Bearer-auth +
 * throw-on-non-2xx client keeps working). Rather than let those two drift, both
 * call this one function.
 *
 * Every check is fail-soft and timed: a probe that throws becomes `{ ok:false,
 * detail }` instead of taking the whole endpoint down, because a health check
 * that itself 500s tells an operator nothing.
 */
import type { Env } from "../types";
import { cronHealth } from "./ops";
import { resolveSecret, getRazorpayCredentials } from "./integrations";
import { integrationHealth } from "../routes/integrations";
import { mediaRouting } from "./mediaRouting";

export interface HealthCheck {
  ok: boolean;
  detail?: string;
  ms?: number;
}

export interface DeepHealth {
  ok: boolean;
  ts: number;
  checks: Record<string, HealthCheck>;
  crons: Awaited<ReturnType<typeof cronHealth>>;
}

export async function computeDeepHealth(env: Env): Promise<DeepHealth> {
  const checks: Record<string, HealthCheck> = {};

  const timed = async (name: string, fn: () => Promise<void>) => {
    const start = Date.now();
    try {
      await fn();
      checks[name] = { ok: true, ms: Date.now() - start };
    } catch (e: any) {
      checks[name] = { ok: false, ms: Date.now() - start, detail: e?.message || "failed" };
    }
  };

  await timed("d1", async () => {
    const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (!row || row.ok !== 1) throw new Error("unexpected D1 response");
  });
  await timed("kv_cache", async () => {
    await env.CACHE_KV.get("health:probe");
  });
  await timed("kv_otp", async () => {
    await env.OTP_KV.get("health:probe");
  });
  await timed("r2", async () => {
    // `head` on a key that need not exist still proves the binding works.
    await env.MEDIA.head("health/probe");
  });

  // Secrets whose absence silently breaks a user-visible flow. Panel-managed
  // credentials are resolved through the credential store (panel value first,
  // env fallback), NOT read from env directly — otherwise a key configured in
  // the admin panel is reported "missing" here even though it is live.
  const [faSvc, rzp] = await Promise.all([
    resolveSecret(env, "FIREBASE_SERVICE_ACCOUNT"),
    getRazorpayCredentials(env),
  ]);
  const requiredSecrets: Record<string, unknown> = {
    FIREBASE_SERVICE_ACCOUNT: faSvc,
    FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID,
    RAZORPAY_KEY_ID: rzp.keyId,
    RAZORPAY_KEY_SECRET: rzp.keySecret,
    RAZORPAY_WEBHOOK_SECRET: rzp.webhookSecret,
    R2_PUBLIC_BASE_URL: env.R2_PUBLIC_BASE_URL,
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
  };
  const missingSecrets = Object.entries(requiredSecrets)
    .filter(([, v]) => v == null || String(v).trim() === "")
    .map(([k]) => k);
  checks.secrets = {
    ok: missingSecrets.length === 0,
    detail: missingSecrets.length ? `missing: ${missingSecrets.join(", ")}` : undefined,
  };

  // Third-party integrations. Video is optional (see the `media_routing` check
  // below, which is where the video provider is actually judged), so an
  // unconfigured Bunny does not fail this on its own.
  try {
    const providers = await integrationHealth(env);
    const missing = Object.entries(providers)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    checks.integrations = {
      ok: missing.filter((m) => m !== "bunnyVideo").length === 0,
      detail: missing.length ? `not configured: ${missing.join(", ")}` : undefined,
    };
  } catch (e: any) {
    checks.integrations = { ok: false, detail: e?.message || "integration check failed" };
  }

  // Which store new video is going to, and whether that was a decision.
  //
  // Worth its own line because the two ways of running on R2 are indistinguishable
  // from outside and mean opposite things. An operator who deliberately selected
  // R2 is fine. An operator who selected Bunny and did not finish wiring it is
  // ALSO silently serving the R2 path — same behaviour, but a half-finished
  // cutover nobody is being told about, and the video library they think they are
  // filling is empty. Only the second fails the check.
  try {
    const routing = await mediaRouting(env);
    const ok = routing.reason !== "not-configured";
    checks.media_routing = {
      ok,
      detail:
        routing.reason === "bunny-live"
          ? "video: bunny (R2 refuses video)"
          : routing.reason === "provider-setting"
            ? "video: r2 (legacy path, selected in the admin panel)"
            : "video provider is set to bunny but its config is incomplete — video is silently falling back to R2",
    };
  } catch (e: any) {
    checks.media_routing = { ok: false, detail: e?.message || "media routing check failed" };
  }

  // Is the cron actually running? A stalled cron means settlement, refunds and
  // payment reconciliation have stopped, which no request-path check would show.
  let crons: DeepHealth["crons"] = [];
  try {
    crons = await cronHealth(env);
    const stale = crons.filter((j) => j.stale).map((j) => j.job);
    const failing = crons.filter((j) => j.lastOk === false).map((j) => j.job);
    checks.cron = {
      ok: stale.length === 0 && failing.length === 0,
      detail:
        [stale.length ? `stale: ${stale.join(", ")}` : "", failing.length ? `failing: ${failing.join(", ")}` : ""]
          .filter(Boolean)
          .join("; ") || undefined,
    };
  } catch (e: any) {
    checks.cron = { ok: false, detail: e?.message || "cron health query failed" };
  }

  const ok = Object.values(checks).every((check) => check.ok);
  return { ok, ts: Date.now(), checks, crons };
}
