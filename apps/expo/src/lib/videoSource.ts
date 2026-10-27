import { Platform } from 'react-native';
import type { VideoSource } from 'expo-video';

/**
 * Video source resolution: legacy raw MP4s in R2 and encoded HLS videos.
 *
 * Old R2 videos and encoded videos coexist indefinitely, so playback has to
 * work for both. Detection is by URL shape rather than configuration: an
 * encoded video's media URL is an HLS playlist
 * (`{media base}/videos/{id}/playlist.m3u8`, written by Qencode), which no raw
 * upload ever is. That keeps the client free of any provider config.
 *
 * Platform difference that matters:
 *  - Native: HLS plays directly. expo-video uses AVPlayer on iOS and ExoPlayer
 *    on Android, both of which support HLS natively, and this is what gives
 *    adaptive bitrate (360p..720p chosen from real bandwidth) — the main
 *    user-visible win on Indian mobile data.
 *  - Web: Chrome has no native HLS; `hooks/useHlsVideo.web.ts` plays it through
 *    hls.js. See the note at the bottom of this file.
 */

const HLS_RE = /\.m3u8(\?|$)/i;

/** True for an HLS playlist URL, i.e. an encoded video. */
export function isHlsUrl(url: string | null | undefined): boolean {
  return !!url && HLS_RE.test(url);
}

/**
 * Recover the video id from a playback URL: the folder holding the playlist
 * (`…/videos/{id}/playlist.m3u8`).
 *
 * Mirrors `videoIdFromUrl` in the Worker's lib/qencode.ts. Returns null for raw
 * R2 URLs, which need no status polling.
 */
export function videoIdFromUrl(url: string | null | undefined): string | null {
  if (!isHlsUrl(url)) return null;
  try {
    const segments = new URL(url as string).pathname.split('/').filter(Boolean);
    const id = segments[segments.length - 2];
    return id && /^[0-9a-f-]{32,36}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The poster Qencode writes next to the playlist, or null for raw R2 URLs. */
export function videoThumbnailFromUrl(url: string | null | undefined): string | null {
  if (!isHlsUrl(url)) return null;
  return (url as string).replace(/\/playlist\.m3u8(\?.*)?$/i, '/thumbnail.jpg');
}

/**
 * The URL this platform can actually play.
 *
 * Raw R2 URLs and native playback pass through untouched; only web HLS is
 * rewritten, to a progressive MP4 name — see the note at the bottom.
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
 *  - expo-video cannot cache HLS sources on iOS. Encoded videos are HLS, so on
 *    iOS they fall back to AVPlayer's own buffering. Adaptive bitrate is the win
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
 * (HLS on native, the web rewrite below) in one step.
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
 * but that path is only a LAST resort: `hooks/useHlsVideo.web.ts` plays the real
 * HLS playlist through hls.js and never needs an MP4. The Qencode pipeline does
 * NOT produce a progressive MP4 (it would add encode cost for a path almost no
 * browser takes), so the rewrite only helps a browser with neither MSE nor native
 * HLS, and there it 404s — the same outcome as having no rewrite at all.
 *
 * hls.js fetches the playlist and segments with XHR, so the media bucket needs
 * a CORS rule allowing GET from the web app's origins (MEDIA_ARCHITECTURE.md).
 */
