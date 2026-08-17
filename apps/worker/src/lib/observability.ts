/**
 * Minimal, dependency-free error forwarding to Sentry.
 *
 * The Worker already emits a structured JSON log line per request + error (see
 * index.ts), which Cloudflare Logpush/Tail can ship anywhere. This adds *active*
 * error tracking: when `SENTRY_DSN` is configured, unhandled server errors are
 * POSTed to Sentry's envelope HTTP endpoint using plain `fetch` — no SDK, no
 * extra dependency, works on the Workers runtime.
 *
 * Design rules:
 *  - No-op unless SENTRY_DSN is set (safe to ship with it unset).
 *  - Fail-open: observability must NEVER throw or slow a response. Callers wrap
 *    it in `ctx.waitUntil(...)` so delivery happens after the response is sent.
 */
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { newId, now } from "./ids";

export interface CaptureContext {
  requestId?: string;
  path?: string;
  method?: string;
  status?: number;
  tags?: Record<string, string | undefined>;
}

/** How long persisted error logs are kept before the cron prunes them. */
const ERROR_LOG_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Persist a server error to D1 so admins can triage it in the admin panel
 * (Error Logs page) without opening the Cloudflare dashboard. Fail-open: a
 * logging failure must never mask the original error.
 */
export async function logErrorToDb(env: Env, err: unknown, ctx: CaptureContext = {}): Promise<void> {
  try {
    const error = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Unknown error");
    const db = getDb(env);
    await db.insert(schema.errorLogs).values({
      id: newId(),
      level: "error",
      message: (error.message || String(err)).slice(0, 2000),
      stack: error.stack ? error.stack.slice(0, 8000) : null,
      requestId: ctx.requestId ?? null,
      path: ctx.path ?? null,
      method: ctx.method ?? null,
      status: ctx.status ?? null,
      createdAt: now(),
    });
  } catch (e) {
    console.error("[observability] logErrorToDb failed (continuing)", e);
  }
}

/** Delete error logs older than the retention window. Called from the cron. */
export async function pruneErrorLogs(env: Env): Promise<void> {
  try {
    const cutoff = Date.now() - ERROR_LOG_RETENTION_MS;
    await env.DB.prepare("DELETE FROM error_logs WHERE created_at < ?").bind(cutoff).run();
  } catch (e) {
    console.error("[observability] pruneErrorLogs failed (continuing)", e);
  }
}

/** Parse a Sentry DSN into its envelope endpoint + public key. */
function parseDsn(dsn: string): { endpoint: string; publicKey: string } | null {
  // https://<publicKey>@<host>/<path?>/<projectId>
  const m = /^https:\/\/([^@]+)@([^/]+)\/(.+)$/.exec(dsn.trim());
  if (!m) return null;
  const [, publicKey, host, projectPath] = m;
  const projectId = projectPath.split("/").filter(Boolean).pop();
  if (!projectId) return null;
  return {
    endpoint: `https://${host}/api/${projectId}/envelope/?sentry_key=${publicKey}&sentry_version=7`,
    publicKey,
  };
}

/**
 * Forward an error to Sentry. Returns a promise the caller should hand to
 * `ctx.waitUntil` so it isn't cancelled when the response is returned. Always
 * resolves (never rejects).
 */
export async function captureError(env: Env, err: unknown, ctx: CaptureContext = {}): Promise<void> {
  try {
    if (!env.SENTRY_DSN) return;
    const parsed = parseDsn(env.SENTRY_DSN);
    if (!parsed) return;

    const error = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Unknown error");
    const eventId = crypto.randomUUID().replace(/-/g, "");
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.tags || {})) if (v != null) tags[k] = v;
    if (ctx.requestId) tags.requestId = ctx.requestId;
    if (ctx.method) tags.method = ctx.method;

    const event = {
      event_id: eventId,
      timestamp: Date.now() / 1000,
      platform: "node",
      level: "error",
      logger: "worker",
      environment: env.SENTRY_ENVIRONMENT || "production",
      transaction: ctx.path,
      tags,
      exception: {
        values: [
          {
            type: error.name || "Error",
            value: error.message || String(err),
            // Send the raw stack as a single synthetic frame — enough for triage
            // without depending on a stack parser.
            stacktrace: error.stack ? { frames: [{ function: error.stack.split("\n")[0] }] } : undefined,
          },
        ],
      },
    };

    const body =
      JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }) +
      "\n" +
      JSON.stringify({ type: "event" }) +
      "\n" +
      JSON.stringify(event);

    await fetch(parsed.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
    }).catch(() => {
      /* delivery is best-effort */
    });
  } catch {
    /* observability must never throw */
  }
}
