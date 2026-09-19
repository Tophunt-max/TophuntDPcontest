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
import { assertSessionUsable } from "./middleware/auth";
import { isChatMember } from "./lib/chatAuth";
import { publishPresence } from "./lib/publish";
import { resolveContests, expireContests, monthlyHallOfFame, seoAuditJob } from "./cron";
import { purgeScheduledDeletions } from "./lib/accountDeletion";
import { ensureMigrated } from "./db/autoMigrate";
import { processBroadcastJob } from "./lib/broadcast";
import { captureError, logErrorToDb, pruneErrorLogs } from "./lib/observability";
import { pruneOpsTables, runCronJob } from "./lib/ops";
import { reconcilePaymentOrders } from "./lib/coinOrders";
import { reconcileVideos } from "./lib/videoReconcile";
import { computeDeepHealth } from "./lib/health";
import { pruneNotifications } from "./lib/notify";
import {
  contentRangeHeader,
  isRangedRequest,
  resolveRange,
  unsatisfiedRangeHeader,
} from "./lib/httpRange";
import { applyPublicMediaCors, preflightMediaCorsHeaders } from "./lib/mediaCors";
import { cachePolicyForKey } from "./lib/mediaCategories";
import { clientIp, rateLimit } from "./lib/rateLimit";

// Durable Object for real-time WebSocket push.
export { RealtimeHub } from "./realtime";
// Durable Object for production-safe vote aggregation (one per match).
export { VoteCounter } from "./voteCounter";
// Durable Object for per-chat message storage (one per chatId) — keeps the
// unbounded message write path off D1's single writer.
export { ChatArchive } from "./chatArchive";
// Durable Object for rate-limit counters (one per throttled subject).
export { RateLimiter } from "./rateLimiter";

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

/** Requests whose responses must not carry the API's CORS policy. */
const skipsApiCors = (c: { req: { header: (n: string) => string | undefined; url: string } }): boolean =>
  // WebSocket upgrades must not be wrapped by CORS (immutable 101 response).
  c.req.header("Upgrade") === "websocket" ||
  // Public media is a different CORS surface from the credentialed API: it serves
  // itself `Access-Control-Allow-Origin: *` from within the /media handler (see
  // lib/mediaCors.ts). Running the API's origin-restricted policy here too would
  // override that `*` with an ALLOWED_ORIGINS-based value and re-break
  // cross-origin canvas reads from the app/blog origins. So media opts out.
  new URL(c.req.url).pathname.startsWith("/media/");

/** The configured allow-list, or `["*"]` when nothing is set. */
function allowedOrigins(env: Env): string[] {
  const raw = (env.ALLOWED_ORIGINS || "").trim();
  if (!raw) {
    // Loud, because an unset allow-list means any site can make credentialed
    // calls to this API. Production and staging both set it in wrangler.toml
    // [vars]; this is here so a new environment that forgets cannot do so
    // silently. Not hard-failed: refusing every cross-origin request would take
    // a working deployment down over a config omission.
    console.error(
      "[cors] ALLOWED_ORIGINS is not set — defaulting to '*'. Set it to the app and admin origins.",
    );
    return ["*"];
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Resolve the `Access-Control-Allow-Origin` value for this request, or null when
 * the origin is not allowed (or there is no `Origin` header at all).
 *
 * Mirrors what `hono/cors` decides, so the error path below cannot drift from the
 * happy path.
 */
function corsOriginFor(c: { req: { header: (n: string) => string | undefined }; env: Env }): string | null {
  const origins = allowedOrigins(c.env);
  if (origins.length === 1 && origins[0] === "*") return "*";
  const requestOrigin = c.req.header("Origin");
  return requestOrigin && origins.includes(requestOrigin) ? requestOrigin : null;
}

app.use("*", async (c, next) => {
  if (skipsApiCors(c)) return next();
  const origins = allowedOrigins(c.env);
  const mw = cors({
    origin: origins.length === 1 && origins[0] === "*" ? "*" : origins,
    // PUT belongs here: the admin panel saves integration config and rotates
    // credentials with PUT (`saveIntegrations`, `setIntegrationSecret`). Omitting
    // it made those calls fail preflight with a bare `TypeError: Failed to fetch`,
    // which reads like a network outage rather than a policy rejection.
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
  // Shared with the admin panel's System Health console (GET /admin/health) so
  // the two never disagree — see lib/health.ts. Public + 503-on-unhealthy here
  // for uptime monitors.
  //
  // ---------------------------------------------------------------------------
  // Throttled, NOT cached — and the difference matters
  // ---------------------------------------------------------------------------
  // Each call probes FIVE dependencies (D1, both KV namespaces, R2 and the RateLimiter
  // Durable Object), so an unauthenticated caller can amplify one cheap HTTP request
  // into five backend operations. That wants a brake.
  //
  // Caching the result was the wrong brake. `.github/workflows/deploy-worker.yml`
  // gates every deploy on this endpoint returning 200, and Cache API entries SURVIVE a
  // deploy — so a healthy response written moments before `wrangler deploy` would
  // satisfy the gate without `computeDeepHealth` ever running against the new code.
  // The workflow's whole premise is that "the test matters more than the deploy"; a
  // cache hit exercises none of the dependencies it claims to check.
  //
  // A per-IP limit brakes the amplification without ever answering from a stale
  // result. Fails OPEN deliberately: an unreachable limiter must not make a healthy
  // deployment look unhealthy, which would be the monitoring equivalent of the bug
  // above. Distributed abuse across many IPs is out of scope here and belongs in
  // Cloudflare WAF rate-limiting rules, which is where lib/rateLimit.ts already says
  // the second tier belongs.
  await rateLimit(c.env, `healthdeep:${clientIp(c.req.raw.headers)}`, 60, 60);

  const health = await computeDeepHealth(c.env);
  const res = c.json(health, health.ok ? 200 : 503) as Response;
  // Never storable by an intermediary: a health check answered from anyone's cache is
  // not a health check.
  res.headers.set("Cache-Control", "no-store");
  return res;
});

/**
 * Public media — serves R2 objects (blog images imported from the archive, user
 * uploads) directly from the Worker. Keys are content-hash addressed, so
 * responses are immutable and cached for a year.
 *
 * This route is a LEGACY PATH, and it must stay. New media is served from the
 * bucket's own custom domain (`R2_PUBLIC_BASE_URL = https://media.tophunt.in`),
 * which is cheaper (no Worker invocation per image), lets the CDN serve the
 * ranged requests video players make, and is a zone root so Transformations can
 * resolve. But every media url written before that cutover is stored ABSOLUTE in
 * D1 on `<worker>/media` — and is baked into already-shipped mobile builds — so
 * removing this route would 404 all of it. `R2_LEGACY_BASE_URLS` is the matching
 * half of the same compatibility promise on the delete side.
 */
// Preflight for cross-origin media reads. Rarely hit — a plain <img crossorigin>
// or simple GET does not preflight — but a ranged cross-origin fetch can, and the
// global CORS middleware skips /media, so media answers its own.
app.options("/media/*", () => new Response(null, { status: 204, headers: preflightMediaCorsHeaders() }));

app.on(["GET", "HEAD"], "/media/*", async (c) => {
  const url = new URL(c.req.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/media\//, "")).replace(/^\/+/, "");
  if (!key) return c.text("Not found", 404);
  // Contest banners have an explicit deletion lifecycle. Never place them in
  // the distributed Cache API or immutable browser caches, otherwise a removed
  // banner can remain public in another colo for up to a year.
  //
  // Resolved from the category registry rather than a literal prefix. The literal
  // was `"contest-banners/images/"`, which stopped matching the moment the key
  // layout gained a date shard — and the symptom would have been exactly the
  // year-long stale banner this line exists to prevent.
  const hasDeletionLifecycle = cachePolicyForKey(key) === "no-store";

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
    // Public, cross-origin-readable. Baked in HERE (not via middleware) so the
    // header is stored in the edge cache with the object and a cache hit carries
    // it too. This is what lets a web canvas / html-to-image capture read an
    // entry image without tainting — the VS card on web depends on it.
    applyPublicMediaCors(headers);
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
    // The global middleware skips auto-migration for upgrades, so this path has to ask for
    // it itself: `assertSessionUsable` reads `users.tokens_valid_after`, and on an isolate
    // whose first ever request is a WebSocket upgrade that column may not exist yet — in
    // which case every upgrade would answer 401 until some HTTP request happened to run
    // the migration.
    await ensureMigrated(c.env).catch((e) =>
      console.error("[migrate] auto-migration failed on /ws (continuing)", e),
    );
    user = await verifyIdToken(token, c.env);
    await assertSessionUsable(c.env, user);
  } catch {
    return c.text("Unauthorized.", 401);
  }

  const [kind, ref] = channel.split(":");
  if (kind === "user") {
    if (ref !== user.uid) return c.text("Forbidden.", 403);
  } else if (kind === "chat") {
    // Single source of truth with the REST handlers — an indexed chat_members
    // seek, not a json_each scan of `chats`.
    if (!(await isChatMember(c.env, ref, user.uid))) return c.text("Forbidden.", 403);
  } else if (kind !== "match") {
    return c.text("Unknown channel.", 400);
  }

  const id = c.env.REALTIME.idFromName(channel);
  const stub = c.env.REALTIME.get(id);
  const forwardedHeaders = new Headers(c.req.raw.headers);
  // The channel DO stores this verified identity as a hibernation tag so an
  // admin block can close already-established private sockets immediately.
  forwardedHeaders.set("X-Authenticated-Uid", user.uid);

  // Presence: the `user:<uid>` channel is where a user is "present". Stamp
  // last-seen and announce them online now (bounded to session start — never per
  // message), and tell the hub to announce the OFFLINE transition when this
  // socket closes (X-Presence-Uid marks the socket for that in the DO).
  if (kind === "user") {
    const ts = Date.now();
    forwardedHeaders.set("X-Presence-Uid", user.uid);
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await c.env.DB.prepare("UPDATE users SET last_seen_at = ? WHERE uid = ?")
            .bind(ts, user.uid)
            .run();
        } catch (e) {
          console.error("[ws] last_seen stamp failed (continuing)", e);
        }
        await publishPresence(c.env, user.uid, true, ts);
      })(),
    );
  }
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
  const errPath = new URL(c.req.url).pathname;
  /**
   * Re-apply the CORS headers before returning an error.
   *
   * `hono/cors` sets `Access-Control-Allow-Origin` AFTER `await next()`, so when a
   * handler throws, the middleware chain unwinds past that line and never sets it.
   * Every thrown response — 401 from `requireAuth`, 403 from the `/admin` gate,
   * 429 from the rate limiter, and any 500 — therefore reached the browser with no
   * ACAO header, and the browser refuses to expose a cross-origin response without
   * one. The admin panel and the web build showed a bare
   * `TypeError: Failed to fetch` instead of the real status, which reads as a
   * network outage rather than "your session expired" or "slow down".
   *
   * This runs on the response `onError` builds, which is the only place the header
   * can still be attached.
   */
  if (!skipsApiCors(c)) {
    const origin = corsOriginFor(c);
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin);
      // Required whenever the value is origin-dependent, or a shared cache can
      // serve one origin's response to another.
      if (origin !== "*") c.header("Vary", "Origin");
      c.header("Access-Control-Expose-Headers", "X-Next-Cursor, X-Request-Id");
    }
  }
  if (err instanceof ApiError) {
    // A 5xx ApiError is OUR fault and used to return from here completely
    // unrecorded — no error_logs row, no Sentry event, only an ephemeral
    // console line. That is how a failing Bunny library stayed invisible: the
    // upload broke for every user, `/health/deep` still reported Bunny as
    // "configured" (it only checks that the credentials EXIST), and the admin
    // panel's Error Logs page was empty, so there was nothing to diagnose from.
    //
    // 4xx stays unlogged on purpose — those are the client's problem and are
    // ordinary traffic, so recording them would bury exactly this kind of fault.
    if (err.status >= 500) {
      const apiErrCtx = { requestId, path: errPath, method: c.req.method, status: err.status };
      c.executionCtx.waitUntil(logErrorToDb(c.env, err, apiErrCtx));
      c.executionCtx.waitUntil(captureError(c.env, err, apiErrCtx));
    }
    return c.json({ ...errorBody(err), requestId }, err.status);
  }
  const path = errPath;
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

  /**
   * Queue consumer — admin broadcast fan-out (wrangler.toml [[queues.consumers]]).
   *
   * Each message names one broadcast job. We advance it by exactly ONE page
   * (bounded work, well inside the CPU/time budget) and, if more recipients
   * remain, re-enqueue the same job to continue immediately — so the whole
   * broadcast drains in seconds rather than one page per 10-minute cron tick.
   *
   * `ack()` on success (including "nothing more to do"), `retry()` on failure so
   * the platform redelivers. Delivery is at-least-once; a duplicated page just
   * re-sends a broadcast notification, which is harmless (no money, no state that
   * can be double-charged). The cron safety net in cron.ts still resumes any job
   * whose queue chain breaks entirely.
   */
  async queue(
    batch: MessageBatch<import("./lib/broadcast").BroadcastQueueMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await ensureMigrated(env).catch((e) => console.error("[migrate] queue auto-migration failed", e));
    for (const msg of batch.messages) {
      try {
        const jobId = msg.body?.jobId;
        if (!jobId) {
          msg.ack();
          continue;
        }
        const { done } = await processBroadcastJob(env, jobId);
        if (!done) await env.BROADCAST_QUEUE?.send({ jobId });
        msg.ack();
      } catch (e) {
        console.error("[queue] broadcast page failed", e);
        msg.retry();
      }
    }
  },

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
      // SEO audit — its own invocation, for its own subrequest budget.
      //
      // It probes ~16 of our own public URLs plus D1 and the settings store, and
      // sharing the 10-minute sweep's budget meant it exceeded the ceiling every
      // time and could not even record the failure (writing that row needs a
      // subrequest too), so it showed as "never ran". See wrangler.toml [triggers].
      case "0 */6 * * *":
        ctx.waitUntil(runCronJob(env, "seoAudit", () => seoAuditJob(env)).then(() => undefined));
        break;
      case "0 0 1 * *":
        ctx.waitUntil(runCronJob(env, "monthlyHallOfFame", () => monthlyHallOfFame(env)).then(() => undefined));
        break;
      // Retention housekeeping — its OWN hourly trigger, split off the 10-minute
      // operational tick. None of this is time-critical: it only bounds table
      // growth, so running it 24×/day instead of 144×/day is plenty and keeps the
      // frequent tick focused on money/settlement. All three deletes are indexed
      // (error_logs.created_at, notifications, cron_runs.created_at — migration
      // 0048), so each run is a cheap index range, not a scan.
      case "0 * * * *":
        ctx.waitUntil(
          (async () => {
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
            // Retention: heartbeat rows, expired replay claims and stale admin
            // notifications.
            await runCronJob(env, "pruneIdempotencyKeys", () => pruneOpsTables(env));
          })(),
        );
        break;
      case "*/10 * * * *":
      default:
        ctx.waitUntil(
          (async () => {
            await runCronJob(env, "resolveContests", () => resolveContests(env));
            // Keep `contests.status` honest once a validity window lapses. The
            // public list already hides an expired template; this is what stops
            // the admin panel showing it as Live forever.
            await runCronJob(env, "expireContests", () => expireContests(env));
            // Money that was captured at the gateway but never credited here
            // (client died AND webhook lost) is invisible without this sweep.
            await runCronJob(env, "reconcilePayments", () => reconcilePaymentOrders(env));
            // NOTE: retention sweeps (pruneErrorLogs / pruneNotifications /
            // pruneOpsTables) moved to the hourly "0 * * * *" trigger above —
            // they are not time-critical and do not need to run every 10 min.
            // Safety net for the Bunny encode webhook: promote videos stuck in
            // `processing` (a lost webhook) and close abandoned uploads (cost).
            await runCronJob(env, "reconcileVideos", () => reconcileVideos(env));
            // Erasure. Deletion requests whose grace period has lapsed are purged
            // here, a few per tick — a purge spans D1, R2, Bunny, KV and Firebase,
            // so an unbounded drain would blow the subrequest budget and fail the
            // whole batch rather than the one account that did not fit.
            //
            // This is also what makes deletion resumable: `deletion_requests.phase`
            // records how far the last attempt got, and each tick continues from
            // there instead of starting over.
            await runCronJob(env, "purgeScheduledDeletions", () =>
              purgeScheduledDeletions(env),
            );
          })(),
        );
        break;
    }
  },
};
