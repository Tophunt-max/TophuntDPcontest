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
import { verifyIdToken } from "./lib/firebaseAuth";
import { resolveContests, monthlyHallOfFame } from "./cron";
import { ensureMigrated } from "./db/autoMigrate";

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
    allowMethods: ["GET", "POST", "OPTIONS"],
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
app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

/**
 * Public media — serves R2 objects (blog images imported from the archive,
 * user uploads) directly from the Worker. This avoids needing a custom R2
 * domain: R2_PUBLIC_BASE_URL points at "<worker>/media". Keys are content-hash
 * addressed, so responses are immutable and cached for a year.
 */
app.get("/media/*", async (c) => {
  const url = new URL(c.req.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/media\//, "")).replace(/^\/+/, "");
  if (!key) return c.text("Not found", 404);

  // Edge-cache media at the Cloudflare colo. Media keys are content-hash / uuid
  // addressed and immutable, so once cached a repeat view is served from the
  // edge WITHOUT an R2 GET (no R2 Class-B op) and with near-zero Worker CPU.
  // This is the single biggest R2 read-cost saver for a media-heavy app.
  const cache = (caches as any).default as Cache;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  try {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch {
    /* cache unavailable — fall through to R2 */
  }

  const obj = await c.env.MEDIA.get(key);
  if (!obj) return c.text("Not found", 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  const res = new Response(obj.body, { headers });
  // Populate the edge cache so future views skip R2 entirely.
  try {
    c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  } catch {
    /* best-effort */
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
  return stub.fetch(c.req.raw);
});

app.route("/auth", authRoute);
app.route("/api", apiRoute);
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
  console.error(
    JSON.stringify({
      level: "error",
      requestId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  return c.json({ ...errorBody(new ApiError("internal", "Internal server error.")), requestId }, 500);
});

app.notFound((c) => c.json(errorBody(new ApiError("not-found", "Route not found.")), 404));

export default {
  fetch: app.fetch,

  // Cron Triggers (wrangler.toml [triggers].crons)
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await ensureMigrated(env).catch((e) => console.error("[migrate] cron auto-migration failed", e));
    switch (event.cron) {
      case "0 0 1 * *":
        ctx.waitUntil(monthlyHallOfFame(env));
        break;
      case "*/10 * * * *":
      default:
        ctx.waitUntil(resolveContests(env));
        break;
    }
  },
};
