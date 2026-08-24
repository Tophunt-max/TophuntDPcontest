/**
 * Bunny Stream integration (MEDIA_MIGRATION_PLAN.md Phase 2).
 *
 * Core security rule: **the Bunny API key never reaches the app.** The Worker
 * creates the video object and mints a short-lived TUS signature; the client
 * uploads the bytes directly to Bunny using only that signature. Bunny's own
 * docs are explicit that the API key must not appear in client-side code.
 *
 * Everything here is fail-closed. With the secrets unset, `bunnyConfigured()` is
 * false, `createVideoUpload` is rejected and the app keeps using the existing R2
 * upload path — so this can ship before the Bunny account exists.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import { getIntegrations, resolveSecret } from "./integrations";

const BUNNY_API_BASE = "https://video.bunnycdn.com";
/** Bunny's TUS endpoint. Same for every library. */
export const BUNNY_TUS_ENDPOINT = `${BUNNY_API_BASE}/tusupload`;

/**
 * Minimum TUS credential lifetime.
 *
 * Bunny recommends at least an hour: on slow Indian mobile networks even a 30s
 * clip can take a while, and an expiry mid-upload surfaces as an opaque 401.
 */
export const TUS_EXPIRY_SECONDS = 3600;

export interface BunnyConfig {
  apiKey: string;
  libraryId: string;
  cdnHostname: string;
}

/**
 * All three of key, library id and pull-zone host must be present.
 *
 * The library id and hostname are admin-panel settings (so a library can be
 * swapped without a deploy) and fall back to the environment for deployments that
 * predate those settings. The API key is resolved through the encrypted
 * credential store, never read from plain config.
 */
export async function bunnyConfig(env: Env): Promise<BunnyConfig | null> {
  const [integrations, apiKeyRaw] = await Promise.all([
    getIntegrations(env),
    resolveSecret(env, "BUNNY_STREAM_API_KEY"),
  ]);
  const apiKey = (apiKeyRaw || "").trim();
  const libraryId = (integrations.video.libraryId || env.BUNNY_LIBRARY_ID || "").trim();
  const cdnHostname = (integrations.video.cdnHostname || env.BUNNY_CDN_HOSTNAME || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!apiKey || !libraryId || !cdnHostname) return null;
  return { apiKey, libraryId, cdnHostname };
}

export async function bunnyConfigured(env: Env): Promise<boolean> {
  const integrations = await getIntegrations(env);
  // An operator can force the R2 path even with valid Bunny credentials present,
  // which is the switch you want during an incident.
  if (integrations.video.provider === "r2") return false;
  return (await bunnyConfig(env)) !== null;
}

/** Throwing accessor for handlers that require Bunny. */
async function requireBunny(env: Env): Promise<BunnyConfig> {
  const cfg = await bunnyConfig(env);
  if (!cfg) throw httpsError("failed-precondition", "Video uploads are not configured.");
  return cfg;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** HLS playlist — adaptive bitrate, plays natively on iOS and Android. */
export function playbackUrl(cfg: BunnyConfig, guid: string): string {
  return `https://${cfg.cdnHostname}/${guid}/playlist.m3u8`;
}

/**
 * Progressive MP4 ("MP4 Fallback" in the Bunny dashboard).
 *
 * Required for the web build: Chrome has no native HLS. Must be enabled on the
 * library or these URLs 404.
 */
export function mp4Url(cfg: BunnyConfig, guid: string, height = 720): string {
  return `https://${cfg.cdnHostname}/${guid}/play_${height}p.mp4`;
}

/** Auto-generated poster frame. */
export function thumbnailUrl(cfg: BunnyConfig, guid: string): string {
  return `https://${cfg.cdnHostname}/${guid}/thumbnail.jpg`;
}

// Env-taking convenience wrappers, so route handlers never juggle the config
// object. All return null when Bunny is not configured.

export async function bunnyPlaybackUrl(env: Env, guid: string): Promise<string | null> {
  const cfg = await bunnyConfig(env);
  return cfg ? playbackUrl(cfg, guid) : null;
}

export async function bunnyMp4Url(env: Env, guid: string, height = 720): Promise<string | null> {
  const cfg = await bunnyConfig(env);
  return cfg ? mp4Url(cfg, guid, height) : null;
}

export async function bunnyThumbnailUrl(env: Env, guid: string): Promise<string | null> {
  const cfg = await bunnyConfig(env);
  return cfg ? thumbnailUrl(cfg, guid) : null;
}

/** True when a URL is served by our Bunny pull zone. */
export async function isBunnyUrl(env: Env, url: string | null | undefined): Promise<boolean> {
  const cfg = await bunnyConfig(env);
  if (!cfg || !url) return false;
  try {
    return new URL(url).hostname === cfg.cdnHostname;
  } catch {
    return false;
  }
}

/**
 * Recover the Bunny guid from a playback URL (`/{guid}/playlist.m3u8`).
 *
 * This is what lets contest matches keep two participant videos without any
 * change to the userA/userB JSON: the guid travels inside the existing mediaUrl.
 */
export async function guidFromUrl(env: Env, url: string | null | undefined): Promise<string | null> {
  if (!(await isBunnyUrl(env, url))) return null;
  try {
    const first = new URL(url as string).pathname.split("/").filter(Boolean)[0];
    // Bunny guids are UUIDs.
    return first && /^[0-9a-f-]{32,36}$/i.test(first) ? first : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// TUS signing
// ---------------------------------------------------------------------------

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * TUS presigned signature.
 *
 * `SHA256(libraryId + apiKey + expirationTime + videoId)` — the field ORDER is
 * significant and Bunny rejects any other arrangement.
 */
export function tusSignature(
  cfg: BunnyConfig,
  expirationTime: number,
  videoId: string,
): Promise<string> {
  return sha256Hex(`${cfg.libraryId}${cfg.apiKey}${expirationTime}${videoId}`);
}

// ---------------------------------------------------------------------------
// Management API
// ---------------------------------------------------------------------------

async function bunnyFetch(
  cfg: BunnyConfig,
  path: string,
  init: RequestInit & { method: string },
): Promise<Response> {
  return fetch(`${BUNNY_API_BASE}/library/${cfg.libraryId}${path}`, {
    ...init,
    headers: {
      AccessKey: cfg.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers || {}),
    },
  });
}

export interface CreatedVideo {
  guid: string;
  libraryId: string;
  expirationTime: number;
  signature: string;
  tusEndpoint: string;
}

/**
 * Create the video object, then mint TUS credentials for it.
 *
 * Only the guid, expiry and signature are returned to the client — never the
 * API key.
 */
export async function createVideo(env: Env, title: string): Promise<CreatedVideo> {
  const cfg = await requireBunny(env);

  const res = await bunnyFetch(cfg, "/videos", {
    method: "POST",
    body: JSON.stringify({ title: title.slice(0, 200) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[bunny] createVideo failed ${res.status}: ${detail.slice(0, 300)}`);
    throw httpsError("internal", "Could not start the video upload.");
  }

  const body: any = await res.json().catch(() => null);
  const guid: string | undefined = body?.guid;
  if (!guid) {
    console.error("[bunny] createVideo returned no guid", body);
    throw httpsError("internal", "Could not start the video upload.");
  }

  const expirationTime = Date.now() + TUS_EXPIRY_SECONDS * 1000;
  return {
    guid,
    libraryId: cfg.libraryId,
    expirationTime,
    signature: await tusSignature(cfg, expirationTime, guid),
    tusEndpoint: BUNNY_TUS_ENDPOINT,
  };
}

/**
 * Ask Bunny to pull a video from a URL (used by the Phase 3 R2 backfill).
 *
 * Avoids downloading and re-uploading: Bunny fetches the R2 object itself.
 */
export async function fetchVideoFromUrl(env: Env, guid: string, sourceUrl: string): Promise<void> {
  const cfg = await requireBunny(env);
  const res = await bunnyFetch(cfg, `/videos/${guid}/fetch`, {
    method: "POST",
    body: JSON.stringify({ url: sourceUrl }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Bunny fetch failed ${res.status}: ${detail.slice(0, 300)}`);
  }
}

/**
 * Delete a video from Bunny.
 *
 * Best-effort: a failure here must not block deleting the story/entry, but it is
 * logged because silently skipping it grows storage cost forever.
 */
export async function deleteVideo(env: Env, guid: string): Promise<void> {
  const cfg = await bunnyConfig(env);
  if (!cfg || !guid) return;
  try {
    const res = await bunnyFetch(cfg, `/videos/${guid}`, { method: "DELETE" });
    // 404 means it is already gone, which is the desired end state.
    if (!res.ok && res.status !== 404) {
      console.error(`[bunny] deleteVideo ${guid} failed ${res.status}`);
    }
  } catch (e) {
    console.error(`[bunny] deleteVideo ${guid} threw`, e);
  }
}

/** Fetch a video's current metadata (status polling / reconciliation). */
export async function getVideo(env: Env, guid: string): Promise<any | null> {
  const cfg = await bunnyConfig(env);
  if (!cfg || !guid) return null;
  try {
    const res = await bunnyFetch(cfg, `/videos/${guid}`, { method: "GET" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Bunny's numeric encode status -> our `videos.status` vocabulary.
 *
 * 0 queued, 1 processing, 2 encoding, 3 finished(playable), 4 resolution done,
 * 5 failed. 3 and 4 are both playable; treat anything >= 3 (except 5) as ready.
 */
export function mapBunnyStatus(status: number | undefined | null): "processing" | "ready" | "failed" {
  if (status === 5) return "failed";
  if (typeof status === "number" && status >= 3) return "ready";
  return "processing";
}
