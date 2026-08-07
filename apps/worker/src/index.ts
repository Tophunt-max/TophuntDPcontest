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
import { verifyIdToken } from "./lib/firebaseAuth";
import { resolveContests, monthlyHallOfFame } from "./cron";

// Durable Object for real-time WebSocket push.
export { RealtimeHub } from "./realtime";
// Durable Object for production-safe vote aggregation (one per match).
export { VoteCounter } from "./voteCounter";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
  // WebSocket upgrades must not be wrapped by CORS (immutable 101 response).
  if (c.req.header("Upgrade") === "websocket") return next();
  const origins = (c.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const mw = cors({
    origin: origins.length === 1 && origins[0] === "*" ? "*" : origins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  });
  return mw(c, next);
});

app.get("/", (c) => c.json({ service: "tophunt-api", status: "ok" }));
app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

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

// Central error handler — preserves HttpsError-style codes for the client.
app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(errorBody(err), err.status);
  }
  console.error("[unhandled]", err);
  return c.json(errorBody(new ApiError("internal", "Internal server error.")), 500);
});

app.notFound((c) => c.json(errorBody(new ApiError("not-found", "Route not found.")), 404));

export default {
  fetch: app.fetch,

  // Cron Triggers (wrangler.toml [triggers].crons)
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
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
