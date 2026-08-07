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
import { resolveContests, monthlyHallOfFame } from "./cron";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("*", async (c, next) => {
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
