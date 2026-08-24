/**
 * TopHunt Cloudflare Worker — backend entrypoint.
 *
 * Replaces the Firebase Cloud Functions backend:
 *   - `api` callable      -> POST /api      (routes/api.ts)
 *   - `authHandler`       -> POST /auth     (routes/auth.ts)
 *   - onSchedule funcs    -> scheduled()    (cron.ts)
 *   - Firestore           -> D1  (env.DB)
 *   - AWS S3              -> R2  (env.MEDIA + presigned uploads)
 *   - OTP docs / caches   -> KV  (env.OTP_KV / env.CACHE_KV)
 *
 * Firebase Authentication stays the source of truth; the Worker verifies ID
 * tokens on the edge (lib/firebaseAuth.ts) and uses the Identity Toolkit REST
 * API for admin user operations (lib/firebaseAdmin.ts).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Variables } from "./types";
import { ApiError, errorBody } from "./lib/http";
import { authRoute } from "./routes/auth";
import { apiRoute } from "./routes/api";
import { readRoute } from "./routes/read";
import { adminRoute } from "./routes/admin";
import { webhookRoute } from "./routes/webhook";
import { uploadRoute } from "./routes/upload";
import { verifyIdToken } from "./lib/firebaseAuth";
import { assertAccountNotBlocked } from "./middleware/auth";
import { resolveContests, monthlyHallOfFame } from "./cron";
import { ensureMigrated } from "./db/autoMigrate";
import { captureError, logErrorToDb, pruneErrorLogs } from "./lib/observability";
import { cronHealth, pruneOpsTables, runCronJob } from "./lib/ops";
import { reconcilePaymentOrders } from "./lib/coinOrders";
import { pruneNotifications } from "./lib/notify";
import {
  contentRangeHeader,
  isRangedRequest,
  resolveRange,
  unsatisfiedRangeHeader,
} from "./lib/httpRange";

// Durable Object for real-time WebSocket push.
export { RealtimeHub } from "./realtime";
// Durable Object for production-safe vote aggregation (one per match).
export { VoteCounter } from "./voteCounter";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Observability + security headers. Runs first; skips WebSocket upgrades whose
// 101 response is immutable. Emits one structured JSON log line per request and
// tags every response (and error) with a correlation request-id.
app.use("*", async (c, next) => {
  if (c.req.header("Upgrade") === "websocket") return next();
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  // Security headers (helmet-style).
  c.header("X-Request-Id", requestId);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  // Force HTTPS for a year, including subdomains. Cloudflare terminates TLS, but
  // without HSTS a first request over http:// is still downgradeable, and this
  // API carries bearer tokens for wallets and payouts.
  c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // This is a JSON API: it should never execute scripts, embed plugins, be
  // framed, or be the base for relative URLs. A restrictive CSP costs nothing
  // here and blunts any reflected-content mistake.
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; img-src 'self' data:; media-src 'self'",
  );
  // Deny access to device APIs no API response has any reason to request.
  c.header(
    "Permissions-Policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
  );
  const path = new URL(c.req.url).pathname;
  // Public media must be embeddable cross-origin (blog/app live on other hosts).
  c.header("Cross-Origin-Resource-Policy", path.startsWith("/media/") ? "cross-origin" : "same-site");
  console.log(
    JSON.stringify({
      level: "info",
      requestId,
      method: c.req.method,
      path,
      status: c.res.status,
      ms,
    }),
  );
});

app.use("*", async (c, next) => {
  // WebSocket upgrades must not be wrapped by CORS (immutable 101 response).
  if (c.req.header("Upgrade") === "websocket") return next();
  const origins = (c.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const mw = cors({
    origin: origins.length === 1 && origins[0] === "*" ? "*" : origins,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["X-Next-Cursor", "X-Request-Id"],
    maxAge: 86400,
  });
  return mw(c, next);
});

// Auto-apply pending D1 migrations on first request per isolate. Best-effort:
// a failure is logged but never blocks traffic (it retries on the next request).
// WebSocket upgrades are skipped — their 101 response can't be delayed here.
app.use("*", async (c, next) => {
  if (c.req.header("Upgrade") === "websocket") return next();
  try {
    await ensureMigrated(c.env);
  } catch (e) {
    console.error("[migrate] auto-migration failed (continuing)", e);
  }
  return next();
});

app.get("/", (c) => c.json({ service: "tophunt-api", status: "ok" }));

/**
 * Liveness. Cheap, no I/O — "this isolate is running and serving".
 * For "can this deployment actually do its job", use /health/deep.
 */
app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

/**
 * Readiness / deep health check.
 *
 * `/health` returning `{ok:true}` was previously the ONLY health signal, and it
 * checked nothing: a Worker with a dead D1 binding or a missing
 * RAZORPAY_KEY_SECRET (which makes every top-up fail closed) still answered 200.
 * This endpoint actually exercises each dependency and reports which required
 * secrets are absent, so an uptime monitor can alert on a broken deploy instead
 * of a broken process.
 *
 * Returns 503 when anything required is unhealthy, so a monitor only needs to
 * watch the status code. Never leaks secret VALUES — only whether they are set.
 */
app.get("/health/deep", async (c) => {
  const checks: Record<string, { ok: boolean; detail?: string; ms?: number }> = {};

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
    const row = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (!row || row.ok !== 1) throw new Error("unexpected D1 response");
  });
  await timed("kv_cache", async () => {
    await c.env.CACHE_KV.get("health:probe");
  });
  await timed("kv_otp", async () => {
    await c.env.OTP_KV.get("health:probe");
  });
  await timed("r2", async () => {
    // `head` on a key that need not exist still proves the binding works.
    await c.env.MEDIA.head("health/probe");
  });

  // Secrets whose absence silently breaks a user-visible flow. The code is
  // correctly fail-closed on each, which is exactly why they must be surfaced:
  // without them the app looks healthy and simply refuses to work.
  const requiredSecrets: Record<string, unknown> = {
    FIREBASE_SERVICE_ACCOUNT: c.env.FIREBASE_SERVICE_ACCOUNT,
    FIREBASE_PROJECT_ID: c.env.FIREBASE_PROJECT_ID,
    RAZORPAY_KEY_ID: c.env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: c.env.RAZORPAY_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: c.env.RAZORPAY_WEBHOOK_SECRET,
    R2_PUBLIC_BASE_URL: c.env.R2_PUBLIC_BASE_URL,
    ALLOWED_ORIGINS: c.env.ALLOWED_ORIGINS,
  };
  const missingSecrets = Object.entries(requiredSecrets)
    .filter(([, v]) => v == null || String(v).trim() === "")
    .map(([k]) => k);
  checks.secrets = {
    ok: missingSecrets.length === 0,
    detail: missingSecrets.length ? `missing: ${missingSecrets.join(", ")}` : undefined,
  };

  // Is the cron actually running? A stalled cron means settlement, refunds and
  // payment reconciliation have stopped, which no request-path check would show.
  let crons: Awaited<ReturnType<typeof cronHealth>> = [];
  try {
    crons = await cronHealth(c.env);
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
  return c.json({ ok, ts: Date.now(), checks, crons }, ok ? 200 : 503);
});

/**
 * Public media — serves R2 objects (blog images imported from the archive,
 * user uploads) directly from the Worker. This avoids needing a custom R2
 * domain: R2_PUBLIC_BASE_URL points at "<worker>/media". Keys are content-hash
 * addressed, so responses are immutable and cached for a year.
 */
app.on(["GET", "HEAD"], "/media/*", async (c) => {
  const url = new URL(c.req.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/media\//, "")).replace(/^\/+/, "");
  if (!key) return c.text("Not found", 404);
  // Contest banners have an explicit deletion lifecycle. Never place them in
  // the distributed Cache API or immutable browser caches, otherwise a removed
  // banner can remain public in another colo for up to a year.
  const hasDeletionLifecycle = key.startsWith("contest-banners/images/");

  const isHead = c.req.method === "HEAD";
  const rangeHeader = c.req.header("range");
  const ranged = isRangedRequest(rangeHeader);

  /** Headers common to every response shape below. */
  const baseHeaders = (obj: R2Object): Headers => {
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    headers.set(
      "Cache-Control",
      hasDeletionLifecycle ? "no-store" : "public, max-age=31536000, immutable",
    );
    // Advertised unconditionally so players know they may seek. Without this,
    // AVPlayer/ExoPlayer fall back to downloading the whole file.
    headers.set("Accept-Ranges", "bytes");
    return headers;
  };

  // HEAD is how some players discover length and range support before playing.
  if (isHead) {
    const head = await c.env.MEDIA.head(key);
    if (!head) return c.text("Not found", 404);
    const headers = baseHeaders(head);
    headers.set("Content-Length", String(head.size));
    return new Response(null, { status: 200, headers });
  }

  // Edge-cache immutable media at the Cloudflare colo. Ranged requests bypass
  // the cache entirely: storing a 206 under the full-URL key would poison it
  // with a partial body for every later full request.
  const useEdgeCache = !hasDeletionLifecycle && !ranged;
  const cache = (caches as any).default as Cache;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (useEdgeCache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      /* cache unavailable — fall through to R2 */
    }
  }

  // Hand R2 the request headers and let it parse Range itself — it applies the
  // RFC clamping rules and echoes the resolved window back on `obj.range`.
  let obj: R2ObjectBody | null;
  try {
    obj = await c.env.MEDIA.get(key, ranged ? { range: c.req.raw.headers } : undefined);
  } catch {
    // R2 throws when the range falls entirely outside the object. Answering 416
    // with the true size lets the player correct itself and retry.
    const head = await c.env.MEDIA.head(key);
    if (!head) return c.text("Not found", 404);
    const headers = baseHeaders(head);
    headers.set("Content-Range", unsatisfiedRangeHeader(head.size));
    return new Response(null, { status: 416, headers });
  }
  if (!obj) return c.text("Not found", 404);

  const headers = baseHeaders(obj);
  const part = ranged ? resolveRange(obj.range, obj.size) : null;
  if (part) {
    headers.set("Content-Range", contentRangeHeader(part, obj.size));
    headers.set("Content-Length", String(part.length));
  } else {
    headers.set("Content-Length", String(obj.size));
  }

  const res = new Response(obj.body, { status: part ? 206 : 200, headers });
  // Populate the edge cache only for full responses to cacheable media.
  if (useEdgeCache) {
    try {
      c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    } catch {
      /* best-effort */
    }
  }
  return res;
});

/**
 * Real-time WebSocket endpoint.
 *   /ws?channel=user:<uid>|chat:<id>|match:<id>&token=<firebaseIdToken>
 * Browsers/React Native can't set WS headers, so the ID token comes as a query
 * param. We verify it + authorize the channel, then forward the upgrade to the
 * channel's RealtimeHub Durable Object.
 */
app.get("/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected a WebSocket upgrade.", 426);
  }
  const channel = c.req.query("channel");
  const token = c.req.query("token");
  if (!channel || !token) return c.text("Missing channel or token.", 400);

  let user;
  try {
    user = await verifyIdToken(token, c.env);
    await assertAccountNotBlocked(c.env, user.uid);
  } catch {
    return c.text("Unauthorized.", 401);
  }

  const [kind, ref] = channel.split(":");
  if (kind === "user") {
    if (ref !== user.uid) return c.text("Forbidden.", 403);
  } else if (kind === "chat") {
    const member = await c.env.DB.prepare(
      `SELECT 1 FROM chats WHERE id = ?
         AND EXISTS (SELECT 1 FROM json_each(chats.users) WHERE json_each.value = ?)`,
    )
      .bind(ref, user.uid)
      .first();
    if (!member) return c.text("Forbidden.", 403);
  } else if (kind !== "match") {
    return c.text("Unknown channel.", 400);
  }

  const id = c.env.REALTIME.idFromName(channel);
  const stub = c.env.REALTIME.get(id);
  const forwardedHeaders = new Headers(c.req.raw.headers);
  // The channel DO stores this verified identity as a hibernation tag so an
  // admin block can close already-established private sockets immediately.
  forwardedHeaders.set("X-Authenticated-Uid", user.uid);
  return stub.fetch(new Request(c.req.raw, { headers: forwardedHeaders }));
});

app.route("/auth", authRoute);
app.route("/api", apiRoute);
app.route("/upload", uploadRoute);
app.route("/read", readRoute);
app.route("/admin", adminRoute);
// Public payment-gateway webhooks (no Firebase auth — trust = signature check).
app.route("/webhook", webhookRoute);

// Central error handler — preserves HttpsError-style codes for the client and
// attaches the request-id so support can correlate a user report to a log line.
app.onError((err, c) => {
  const requestId = c.get("requestId");
  if (err instanceof ApiError) {
    return c.json({ ...errorBody(err), requestId }, err.status);
  }
  const path = new URL(c.req.url).pathname;
  console.error(
    JSON.stringify({
      level: "error",
      requestId,
      path,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  // Persist to D1 (admin panel Error Logs) + forward to Sentry if configured.
  // Both fire after the response via waitUntil so they never delay the user.
  const errCtx = { requestId, path, method: c.req.method, status: 500 };
  c.executionCtx.waitUntil(logErrorToDb(c.env, err, errCtx));
  c.executionCtx.waitUntil(captureError(c.env, err, errCtx));
  return c.json({ ...errorBody(new ApiError("internal", "Internal server error.")), requestId }, 500);
});

app.notFound((c) => c.json(errorBody(new ApiError("not-found", "Route not found.")), 404));

export default {
  fetch: app.fetch,

  // Cron Triggers (wrangler.toml [triggers].crons)
  //
  // Every job runs through `runCronJob`, which records a heartbeat row, a
  // duration, and — on failure — an error log, a Sentry event and an admin
  // notification. `ctx.waitUntil` is deliberately given ONE promise for the
  // whole tick so the runtime keeps the isolate alive until the batch is done
  // and the heartbeats are actually written.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await ensureMigrated(env).catch((e) => console.error("[migrate] cron auto-migration failed", e));
    switch (event.cron) {
      case "0 0 1 * *":
        ctx.waitUntil(runCronJob(env, "monthlyHallOfFame", () => monthlyHallOfFame(env)).then(() => undefined));
        break;
      case "*/10 * * * *":
      default:
        ctx.waitUntil(
          (async () => {
            await runCronJob(env, "resolveContests", () => resolveContests(env));
            // Money that was captured at the gateway but never credited here
            // (client died AND webhook lost) is invisible without this sweep.
            await runCronJob(env, "reconcilePayments", () => reconcilePaymentOrders(env));
            // Retention: drop error logs past the retention window.
            await runCronJob(env, "pruneErrorLogs", async () => {
              await pruneErrorLogs(env);
            });
            // Retention: the notifications table previously grew forever, which
            // made heavy users' own list and badge-count queries progressively
            // slower.
            await runCronJob(env, "pruneNotifications", async () => {
              await pruneNotifications(env);
            });
            // Retention: heartbeat rows and expired replay claims.
            await runCronJob(env, "pruneIdempotencyKeys", () => pruneOpsTables(env));
          })(),
        );
        break;
    }
  },
};
