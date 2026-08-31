import { Platform } from 'react-native';
import type { VideoSource } from 'expo-video';

/**
 * Video source resolution for the R2 -> Bunny Stream migration
 * (MEDIA_MIGRATION_PLAN.md 2f).
 *
 * Old R2 videos and new Bunny videos coexist indefinitely, so playback has to
 * work for both. Detection is by URL shape rather than configuration: a Bunny
 * video's media URL is an HLS playlist (`.../{guid}/playlist.m3u8`), which no R2
 * object ever is. That keeps the client free of any Bunny hostname config.
 *
 * Platform difference that matters:
 *  - Native: HLS plays directly. expo-video uses AVPlayer on iOS and ExoPlayer
 *    on Android, both of which support HLS natively, and this is what gives
 *    adaptive bitrate (240p..1080p chosen from real bandwidth) — the single
 *    biggest user-visible win of the migration on Indian mobile data.
 *  - Web: Chrome has no native HLS, so we swap to Bunny's progressive MP4
 *    ("MP4 Fallback", which must be enabled on the library). Using the MP4 URL
 *    rather than Bunny's iframe embed is deliberate: every existing expo-video
 *    call site keeps working and only the URL differs.
 */

const HLS_RE = /\.m3u8(\?|$)/i;

/** True for an HLS playlist URL, i.e. a Bunny-hosted video. */
export function isHlsUrl(url: string | null | undefined): boolean {
  return !!url && HLS_RE.test(url);
}

/**
 * Recover the Bunny video guid from a playback URL.
 *
 * Mirrors `guidFromUrl` in the Worker's lib/bunny.ts. Returns null for R2 URLs.
 */
export function bunnyGuidFromUrl(url: string | null | undefined): string | null {
  if (!isHlsUrl(url)) return null;
  try {
    const segments = new URL(url as string).pathname.split('/').filter(Boolean);
    const guid = segments[0];
    return guid && /^[0-9a-f-]{32,36}$/i.test(guid) ? guid : null;
  } catch {
    return null;
  }
}

/** Bunny's generated poster frame for a video, or null for non-Bunny URLs. */
export function bunnyThumbnailFromUrl(url: string | null | undefined): string | null {
  if (!isHlsUrl(url)) return null;
  return (url as string).replace(/\/playlist\.m3u8(\?.*)?$/i, '/thumbnail.jpg');
}

/**
 * The URL this platform can actually play.
 *
 * Non-Bunny (R2) URLs and native playback pass through untouched; only web HLS
 * is rewritten to the MP4 fallback.
 */
export function playableVideoUrl(url: string | null | undefined): string {
  if (!url) return '';
  if (Platform.OS !== 'web' || !isHlsUrl(url)) return url;
  return url.replace(/\/playlist\.m3u8(\?.*)?$/i, '/play_720p.mp4');
}


/**
 * Can expo-video's disk cache be used for this URL on this platform?
 *
 * Two documented limitations:
 *  - caching is Android/iOS only — on web the browser HTTP cache does the job,
 *    and our R2 responses already carry `Cache-Control: immutable, max-age=1y`;
 *  - expo-video cannot cache HLS sources on iOS. Bunny videos are HLS, so on iOS
 *    they fall back to AVPlayer's own buffering. Adaptive bitrate is the win
 *    there anyway.
 */
function cachingSupported(uri: string): boolean {
  if (Platform.OS === 'web') return false;
  if (Platform.OS === 'ios' && isHlsUrl(uri)) return false;
  return true;
}

/**
 * Build a `VideoSource` for a remote video, with disk caching turned on.
 *
 * **This is the function that stops videos being re-downloaded on every play.**
 * `useCaching` defaults to `false` in expo-video, so passing a bare URL string —
 * which is what every call site used to do — means the bytes are refetched every
 * single time. Setting the cache *size* alone does nothing without this flag.
 *
 * Also applies `playableVideoUrl`, so callers get the right URL for the platform
 * (HLS on native, Bunny's MP4 fallback on web) in one step.
 */
export function videoSourceFor(url: string | null | undefined): VideoSource {
  const uri = playableVideoUrl(url);
  if (!uri) return null;
  if (!cachingSupported(uri)) return uri;
  return { uri, useCaching: true };
}

/**
 * NOTE ON WEB HLS.
 *
 * `playableVideoUrl` above still rewrites a playlist to `play_720p.mp4` for web,
 * but that path is now only a LAST resort: `hooks/useHlsVideo.web.ts` plays the
 * real HLS playlist through hls.js and never needs an MP4 at all. The rewrite is
 * kept for the case hls.js is unsupported AND the browser has no native HLS,
 * where a guessed MP4 is still better than nothing.
 */
