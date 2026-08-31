import { useEffect, useRef } from 'react';
import type { VideoSource } from 'expo-video';
import Hls from 'hls.js';

import { isHlsUrl, videoSourceFor } from '@/src/lib/videoSource';
import type { HlsVideoBinding } from './useHlsVideo';

/**
 * Play a Bunny HLS stream on the WEB, where nothing plays it natively.
 *
 * ## Why this exists
 *
 * Chrome, Firefox and Edge cannot play an `.m3u8` playlist. The app worked around
 * that by rewriting the URL to Bunny's progressive MP4 (`play_720p.mp4`), which
 * has two failure modes and hit both:
 *
 *   1. it requires "MP4 Fallback" to be switched ON for the library — an account
 *      setting no code can guarantee;
 *   2. it names a specific rendition, and Bunny only produces the resolutions the
 *      library enabled and never upscales — so `play_720p.mp4` simply does not
 *      exist for plenty of real videos.
 *
 * Either way the URL 404s, there is no second option on web, and the player
 * reports "This video could not be played" — indistinguishable, from the user's
 * side, from an upload that failed.
 *
 * hls.js removes the whole class of problem: it feeds the HLS segments to the
 * `<video>` element through Media Source Extensions, so web plays the SAME
 * playlist native does, with adaptive bitrate, and no dependency on an MP4
 * rendition existing at all.
 *
 * ## Why it attaches to expo-video's element instead of replacing the player
 *
 * `VideoPlayer.web` is a thin wrapper over real `HTMLVideoElement`s: `play()`,
 * `pause()`, `muted`, `duration` and the `statusChange` events are all read from
 * (and applied to) the mounted elements. So attaching hls.js to that same element
 * leaves every one of those working — the story viewer's progress bar, pause
 * lifecycle and "readyToPlay" handling need no changes. Building a parallel
 * player would have meant duplicating that logic and letting the two drift.
 *
 * The player is deliberately given a NULL source in the hls.js case: handing it
 * the `.m3u8` would set `video.src` to something the browser cannot decode, and
 * its `onerror` would flip the player to `error` before hls.js ever attached.
 */
export function useHlsVideo(url?: string | null): HlsVideoBinding {
  const hostRef = useRef<any>(null);
  const isHls = !!url && isHlsUrl(url);
  // Safari (notably iOS) reports MSE unsupported but plays HLS natively, so it
  // takes the plain-URL path below rather than hls.js.
  const useHlsJs = isHls && Hls.isSupported();

  useEffect(() => {
    if (!useHlsJs || !url) return;
    let hls: Hls | null = null;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // The <video> is created by expo-video INSIDE this host, and not necessarily
    // on the same commit this effect runs on, so retry briefly rather than
    // giving up on the first miss. Bounded so a markup change upstream cannot
    // turn this into an endless timer.
    let attempts = 0;
    const attach = () => {
      if (cancelled) return;
      const host = hostRef.current as HTMLElement | null;
      const video = host?.querySelector?.('video') as HTMLVideoElement | null;
      if (!video) {
        if (attempts++ > 40) {
          console.warn('[useHlsVideo] no <video> element to attach hls.js to');
          return;
        }
        timer = setTimeout(attach, 50);
        return;
      }
      hls = new Hls({ enableWorker: true });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        // Only fatal errors are worth surfacing; hls.js recovers from the rest on
        // its own, and logging them all buries the real one.
        if (data?.fatal) console.error('[useHlsVideo] fatal hls.js error', data.type, data.details);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    };
    attach();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      hls?.destroy();
    };
  }, [url, useHlsJs]);

  return {
    hostRef,
    // null => hls.js owns the media (see the note above).
    // A bare HLS url => Safari's native HLS.
    // Anything else (a legacy R2 mp4) => the normal source path.
    playerSource: useHlsJs ? null : isHls ? (url as string) : videoSourceFor(url),
  };
}
