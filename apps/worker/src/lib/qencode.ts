/**
 * Qencode video integration — replaces Bunny Stream.
 *
 * ---------------------------------------------------------------------------
 * THE PIPELINE
 * ---------------------------------------------------------------------------
 *   1. `createVideoUpload` (api.ts)   creates a `videos` row (status uploading)
 *                                      with OUR uuid as its id.
 *   2. `POST /upload/video` (upload.ts) the app sends the raw file to the Worker;
 *                                      it is verified and stored in R2 at
 *                                      `video-src/<random>.<ext>`.
 *   3. `startEncode` (here)            create_task + start_encode2. Qencode pulls
 *                                      the source through a presigned R2 GET and
 *                                      writes HLS + a poster into R2 at
 *                                      `videos/<id>/`.
 *   4. `/webhook/qencode`, the reconcile cron and the `videoStatus` live recheck
 *      all apply the result through ONE function (`applyEncodeResult` in
 *      videoReconcile.ts), which asks Qencode's /v1/status and checks that the
 *      playlist really exists in R2 before calling a video ready.
 *
 * Playback is then plain R2: `{R2_PUBLIC_BASE_URL}/videos/<id>/playlist.m3u8`.
 * There is no separate CDN hostname to configure.
 *
 * ---------------------------------------------------------------------------
 * WHY THE APP DOES NOT UPLOAD TO QENCODE DIRECTLY
 * ---------------------------------------------------------------------------
 * Qencode offers a tus direct-upload endpoint, but it is authorised by the
 * job's `task_token`, and `start_encode2` accepts that same token with ANY
 * query. Handing it to the app would let any account start an arbitrary encode
 * (any source URL, any resolution, any length) billed to us. Uploading through
 * the Worker keeps the task_token server-side, and lets us verify the bytes are
 * a real video before paying to encode them — the same reason `POST /upload`
 * exists for images. The cost is resumability: the Worker path retries, but a
 * dropped upload restarts from zero rather than resuming mid-file.
 *
 * Everything here is fail-closed: without the API key and R2 credentials,
 * `qencodeConfig()` is null, `createVideoUpload` reports "not configured", and
 * video stays on the legacy R2 path.
 */
import { AwsClient } from "aws4fetch";
import type { Env } from "../types";
import { httpsError } from "./http";
import { getIntegrations, getR2Credentials, resolveSecret } from "./integrations";
import { logErrorToDb } from "./observability";
import { mediaKeyFromPublicUrl } from "./r2";
import { VIDEO_PREFIX, VIDEO_SOURCE_PREFIX } from "./mediaCategories";

export const QENCODE_API_BASE = "https://api.qencode.com";

/** R2 prefix the encoded output is written under: `videos/<id>/…`. */
export const VIDEO_OUTPUT_PREFIX = VIDEO_PREFIX;
/** R2 prefix for the raw uploads Qencode encodes from: `video-src/<random>.<ext>`. */
export { VIDEO_SOURCE_PREFIX };

/**
 * The HLS ladder, lowest first.
 *
 * Qencode never upscales: a rung taller than the source is skipped. If EVERY
 * rung is taller (a tiny source), only the FIRST one is produced, at the
 * source's own size — so the order matters, and lowest-first means a 240p clip
 * still gets one stream instead of none.
 *
 * Capped at 720p on cost: transcoding is billed per output minute per rung, and
 * HD rungs cost twice an SD one. Stories and contest entries are watched on
 * phones. Add 1080 here if quality matters more than the bill.
 */
export const HLS_RESOLUTIONS = [360, 480, 720] as const;

/**
 * How long the presigned source URL stays valid.
 *
 * Qencode downloads the source when the job leaves its queue, not when we start
 * it, so this has to cover queue time. Six hours is far past a normal queue and
 * still bounds what a leaked URL is worth.
 */
export const SOURCE_URL_TTL_SECONDS = 6 * 3600;

/** Our video ids are UUIDs (crypto.randomUUID). */
const VIDEO_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isVideoId(value: unknown): value is string {
  return typeof value === "string" && VIDEO_ID_RE.test(value);
}

export interface QencodeConfig {
  apiKey: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
  };
}

/**
 * Everything the pipeline needs, or null if any of it is missing.
 *
 * The R2 credentials are part of "configured" on purpose: without them the
 * Worker cannot presign the source and Qencode cannot write the output, so an
 * API key alone would accept uploads that can never become playable.
 */
export async function qencodeConfig(env: Env): Promise<QencodeConfig | null> {
  const [apiKeyRaw, r2] = await Promise.all([resolveSecret(env, "QENCODE_API_KEY"), getR2Credentials(env)]);
  const apiKey = (apiKeyRaw || "").trim();
  if (!apiKey || !r2.accountId || !r2.accessKeyId || !r2.secretAccessKey || !r2.bucket) return null;
  if (!String(env.R2_PUBLIC_BASE_URL || "").trim()) return null;
  return {
    apiKey,
    r2: {
      accountId: r2.accountId,
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
      bucket: r2.bucket,
    },
  };
}

/** Qencode is selected in the admin panel AND fully configured. */
export async function qencodeConfigured(env: Env): Promise<boolean> {
  const integrations = await getIntegrations(env);
  // An operator can force the legacy R2 path even with valid credentials, which
  // is the switch you want during an incident.
  if (integrations.video.provider !== "qencode") return false;
  return (await qencodeConfig(env)) !== null;
}

async function requireQencode(env: Env): Promise<QencodeConfig> {
  const cfg = await qencodeConfig(env);
  if (!cfg) throw httpsError("failed-precondition", "Video uploads are not configured.");
  return cfg;
}

// ---------------------------------------------------------------------------
// Keys and URLs
// ---------------------------------------------------------------------------

function publicBase(env: Env): string {
  return String(env.R2_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
}

export function videoOutputFolder(id: string): string {
  return `${VIDEO_OUTPUT_PREFIX}/${id}/`;
}

export function playlistKey(id: string): string {
  return `${videoOutputFolder(id)}playlist.m3u8`;
}

export function thumbnailKey(id: string): string {
  return `${videoOutputFolder(id)}thumbnail.jpg`;
}

/**
 * A fresh, unlinkable key for a raw upload.
 *
 * Deliberately NOT derived from the video id. The bucket is publicly readable
 * (custom domain and the `/media/*` proxy), and the video id is public from the
 * moment the playlist URL is stored on a story — so `video-src/<videoId>.mp4`
 * would let anyone fetch the unencoded original while it waits to be encoded.
 * The key is stored on the row (`source_key`), so nothing needs to derive it.
 */
export function newSourceKey(extension: string): string {
  return `${VIDEO_SOURCE_PREFIX}/${crypto.randomUUID()}${extension}`;
}

/**
 * HLS master playlist — what is stored as a story's / entry's `mediaUrl`.
 *
 * The file names (`playlist.m3u8`, `thumbnail.jpg` next to it) deliberately
 * match what Bunny produced, so the app's URL-shape helpers (`isHlsUrl`, the
 * playlist -> thumbnail swap) work unchanged.
 */
export function playbackUrlFor(env: Env, id: string): string {
  return `${publicBase(env)}/${playlistKey(id)}`;
}

export function thumbnailUrlFor(env: Env, id: string): string {
  return `${publicBase(env)}/${thumbnailKey(id)}`;
}

/**
 * Recover the video id from any URL under `videos/<id>/` on one of our media
 * bases (playlist, poster, a segment). Null for anything else, including R2
 * originals and third-party URLs.
 *
 * Synchronous and config-free: it only needs the media bases, which is what lets
 * every delete and ownership path call it cheaply.
 */
export function videoIdFromUrl(env: Env, url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const key = mediaKeyFromPublicUrl(env, url);
  if (!key || !key.startsWith(`${VIDEO_OUTPUT_PREFIX}/`)) return null;
  const id = key.slice(VIDEO_OUTPUT_PREFIX.length + 1).split("/")[0];
  return isVideoId(id) ? id : null;
}

// ---------------------------------------------------------------------------
// R2 access for Qencode
// ---------------------------------------------------------------------------

function r2Endpoint(cfg: QencodeConfig): string {
  return `${cfg.r2.accountId}.r2.cloudflarestorage.com`;
}

/**
 * A time-limited GET URL for one R2 object, signed with SigV4 (query auth).
 *
 * The raw upload is pulled through this rather than through the public media
 * domain, so the source never needs to be publicly readable and the credential
 * Qencode receives for it expires on its own.
 */
export async function presignR2Get(cfg: QencodeConfig, key: string, ttlSeconds = SOURCE_URL_TTL_SECONDS): Promise<string> {
  const client = new AwsClient({
    accessKeyId: cfg.r2.accessKeyId,
    secretAccessKey: cfg.r2.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const path = key.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://${r2Endpoint(cfg)}/${cfg.r2.bucket}/${path}`);
  url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
  const signed = await client.sign(new Request(url.toString(), { method: "GET" }), { aws: { signQuery: true } });
  return signed.url;
}

/** Qencode destination object for a path in our bucket. */
function r2Destination(cfg: QencodeConfig, key: string) {
  return {
    url: `s3://${r2Endpoint(cfg)}/${cfg.r2.bucket}/${key}`,
    key: cfg.r2.accessKeyId,
    secret: cfg.r2.secretAccessKey,
  };
}

/**
 * Delete everything stored for a video: the encoded folder and the raw source.
 *
 * R2 failures PROPAGATE. Callers that retry (the story-expiry cron) need to know
 * the delete did not happen, or the row — the only pointer to these objects —
 * is dropped and the footage leaks. Callers that must not fail wrap this.
 */
export async function deleteVideoObjects(env: Env, id: string, sourceKey?: string | null): Promise<void> {
  if (!isVideoId(id)) return;
  const prefix = videoOutputFolder(id);
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.MEDIA.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (sourceKey && sourceKey.startsWith(`${VIDEO_SOURCE_PREFIX}/`)) await env.MEDIA.delete(sourceKey);
}

// ---------------------------------------------------------------------------
// Callback authentication
// ---------------------------------------------------------------------------

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Per-video signature carried in the callback URL.
 *
 * Qencode does not sign its callbacks and cannot send a custom header, so the
 * URL is the only place a credential can go. A per-video HMAC rather than a
 * shared secret: a URL that leaks (logs, a proxy) authorises a re-check of ONE
 * video, never anything else. Keyed by the API key, so there is no second secret
 * to configure; rotating the key invalidates in-flight callbacks, which the
 * reconcile cron covers.
 *
 * And the callback is never trusted for STATE: the handler re-reads the job from
 * Qencode and the playlist from R2. The signature only bounds who can make us do
 * that work.
 */
export function callbackSignature(cfg: QencodeConfig, videoId: string): Promise<string> {
  return hmacHex(cfg.apiKey, `qencode-callback:${videoId}`);
}

export function callbackUrl(origin: string, videoId: string, signature: string): string {
  const base = origin.replace(/\/+$/, "");
  return `${base}/webhook/qencode?v=${encodeURIComponent(videoId)}&sig=${encodeURIComponent(signature)}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Per-attempt budget. Qencode answers in well under a second normally. */
const QENCODE_TIMEOUT_MS = 10_000;
/** Two retries: these calls run inside a request someone is waiting on. */
const QENCODE_RETRY_DELAYS_MS = [300, 1200];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class QencodeApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "QencodeApiError";
  }
}

/**
 * One Qencode API call: form-encoded POST, JSON reply, `error > 0` on failure.
 *
 * Retries network errors, timeouts, 429 and 5xx. A reply with `error > 0` is
 * Qencode rejecting the request and is not retried.
 *
 * KNOWN TRADE-OFF: create_task is not idempotent, so a retry after a lost
 * response can leave one empty task in the Qencode account. An unstarted task
 * costs nothing.
 */
async function qencodePost(path: string, params: Record<string, string>): Promise<any> {
  const url = `${QENCODE_API_BASE}${path}`;
  let lastError: unknown = null;

  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(QENCODE_TIMEOUT_MS),
      });
      if (res.status !== 429 && res.status < 500) {
        const body: any = await res.json().catch(() => null);
        if (!res.ok || !body) {
          throw new QencodeApiError(`Qencode ${path} returned HTTP ${res.status}`, res.status, null);
        }
        if (Number(body.error) > 0) {
          throw new QencodeApiError(
            `Qencode ${path} error ${body.error}: ${String(body.message || body.error_description || "").slice(0, 300)}`,
            res.status,
            Number(body.error),
          );
        }
        return body;
      }
    } catch (e) {
      if (e instanceof QencodeApiError) throw e;
      lastError = e;
    }

    if (attempt >= QENCODE_RETRY_DELAYS_MS.length) {
      if (res) throw new QencodeApiError(`Qencode ${path} returned HTTP ${res.status}`, res.status, null);
      throw lastError instanceof Error ? lastError : new Error(`Qencode ${path} failed`);
    }
    console.warn(
      `[qencode] ${path} attempt ${attempt + 1} failed (${res ? `status ${res.status}` : (lastError as Error)?.name || "network error"}); retrying`,
    );
    await sleep(QENCODE_RETRY_DELAYS_MS[attempt]);
  }
}

/** Session token cache, per isolate. Tokens are valid for hours. */
let tokenCache: { apiKey: string; token: string; expiresAt: number } | null = null;

/** Exposed for tests only. */
export function resetQencodeTokenCache(): void {
  tokenCache = null;
}

async function accessToken(cfg: QencodeConfig): Promise<string> {
  if (tokenCache && tokenCache.apiKey === cfg.apiKey && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const body = await qencodePost("/v1/access_token", { api_key: cfg.apiKey });
  const token = String(body?.token || "");
  if (!token) throw new QencodeApiError("Qencode /v1/access_token returned no token", null, null);
  // `expire` is a date string; if it cannot be parsed, assume one hour.
  const parsed = Date.parse(String(body?.expire || ""));
  const expiresAt = Number.isFinite(parsed) ? parsed : Date.now() + 3600_000;
  tokenCache = { apiKey: cfg.apiKey, token, expiresAt };
  return token;
}

/** Validate the API key without starting anything (admin "Test" button). */
export async function verifyQencodeApiKey(env: Env): Promise<void> {
  const cfg = await requireQencode(env);
  resetQencodeTokenCache();
  await accessToken(cfg);
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/**
 * The start_encode2 query for one video. Exported so tests can pin its shape.
 *
 * Outputs, all under `videos/<id>/`:
 *  - `advanced_hls` into the folder: `playlist.m3u8` (Qencode's default master
 *    name) plus one sub-folder per rung.
 *  - one JPEG poster at `thumbnail.jpg`, taken a little way in so it is not the
 *    black first frame most phone clips start with.
 */
export function buildEncodeQuery(
  cfg: QencodeConfig,
  opts: { videoId: string; sourceUrl: string; callbackUrl: string | null },
): Record<string, unknown> {
  const { videoId, sourceUrl } = opts;
  const query: Record<string, unknown> = {
    source: sourceUrl,
    format: [
      {
        output: "advanced_hls",
        destination: r2Destination(cfg, videoOutputFolder(videoId)),
        stream: HLS_RESOLUTIONS.map((resolution) => ({ resolution })),
      },
      {
        output: "thumbnail",
        image_format: "jpg",
        quality: 85,
        // Percent of the duration.
        time: 0.1,
        destination: r2Destination(cfg, thumbnailKey(videoId)),
      },
    ],
  };
  if (opts.callbackUrl) query.callback_url = opts.callbackUrl;
  return { query };
}

/**
 * Start encoding the R2 object at `sourceKey` into `videos/<videoId>/`.
 *
 * @param callbackOrigin Origin the callback should come back to (the request's
 *   own origin). Null from the cron, which has no request: the job then
 *   resolves by polling, which the cron and `videoStatus` already do.
 * @returns Qencode's task_token, the handle for /v1/status.
 */
export async function startEncode(
  env: Env,
  opts: { videoId: string; sourceKey: string; callbackOrigin: string | null },
): Promise<string> {
  const cfg = await requireQencode(env);
  const { videoId, sourceKey, callbackOrigin } = opts;

  try {
    const token = await accessToken(cfg);
    const task = await qencodePost("/v1/create_task", { token });
    const taskToken = String(task?.task_token || "");
    if (!taskToken) throw new QencodeApiError("Qencode /v1/create_task returned no task_token", null, null);

    const sourceUrl = await presignR2Get(cfg, sourceKey);
    const cb = callbackOrigin ? callbackUrl(callbackOrigin, videoId, await callbackSignature(cfg, videoId)) : null;
    const query = buildEncodeQuery(cfg, { videoId, sourceUrl, callbackUrl: cb });

    await qencodePost("/v1/start_encode2", {
      task_token: taskToken,
      query: JSON.stringify(query),
      // Echoed back on every callback; lets the Qencode dashboard be traced to a row.
      payload: videoId,
    });
    return taskToken;
  } catch (e: any) {
    // A stale cached token is the one failure a fresh attempt fixes.
    if (e instanceof QencodeApiError && e.code !== null) resetQencodeTokenCache();
    // Persisted, not just console'd: the app is told something vague, so this is
    // the only record distinguishing a revoked key from a Qencode outage.
    await logErrorToDb(env, new Error(`[qencode] startEncode ${videoId} failed: ${e?.message || e}`), {
      path: "qencode:startEncode",
    });
    throw e;
  }
}

export interface QencodeJobStatus {
  /** Qencode's own word: queued | downloading | encoding | saving | completed | … */
  status: string;
  error: boolean;
  errorDescription: string | null;
  durationSec: number | null;
}

/**
 * Current state of one job, or null when Qencode could not be asked (network,
 * outage) — callers treat that as "still processing" and try again later.
 */
export async function getJobStatus(jobId: string): Promise<QencodeJobStatus | null> {
  if (!jobId) return null;
  let body: any;
  try {
    body = await qencodePost("/v1/status", { task_tokens: jobId });
  } catch (e) {
    console.error("[qencode] status lookup failed", jobId, e);
    return null;
  }
  const s = body?.statuses?.[jobId];
  if (!s || typeof s !== "object") return null;
  const duration = parseFloat(String(s.duration ?? ""));
  return {
    status: String(s.status || ""),
    error: Number(s.error) > 0 || String(s.status) === "error",
    errorDescription: s.error_description ? String(s.error_description).slice(0, 500) : null,
    durationSec: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
  };
}

/** Qencode job state -> our `videos.status` vocabulary. */
export function mapQencodeStatus(job: QencodeJobStatus | null): "processing" | "ready" | "failed" {
  if (!job) return "processing";
  if (job.error) return "failed";
  if (job.status === "completed") return "ready";
  return "processing";
}
