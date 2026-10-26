import { useEffect, useRef, useState } from 'react';
import type { VideoSource } from 'expo-video';
import Hls from 'hls.js';

import { isHlsUrl, videoSourceFor } from '@/src/lib/videoSource';
import type { HlsVideoBinding, HlsVideoOptions } from './useHlsVideo';
import { hlsErrorKind, initialHlsRecovery, nextHlsRecovery } from '@/src/lib/hlsRecovery';

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
export function useHlsVideo(url?: string | null, options: HlsVideoOptions = {}): HlsVideoBinding {
  const { load = true } = options;
  const hostRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [failed, setFailed] = useState(false);
  const isHls = !!url && isHlsUrl(url);
  // Safari (notably iOS) reports MSE unsupported but plays HLS natively, so it
  // takes the plain-URL path below rather than hls.js.
  const useHlsJs = isHls && Hls.isSupported();

  useEffect(() => {
    setFailed(false);
    if (!useHlsJs || !url) return;
    let hls: Hls | null = null;
    const recovery = initialHlsRecovery();
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
      // `autoStartLoad: false`: segments are fetched only while `load` is true
      // (see the effect below), so an off-screen feed card does not buffer.
      // A 15 s forward buffer instead of the 30 s default bounds what one
      // playing card downloads ahead.
      const instance = new Hls({ enableWorker: true, autoStartLoad: false, maxBufferLength: 15 });
      hls = instance;
      hlsRef.current = instance;
      instance.on(Hls.Events.ERROR, (_evt, data) => {
        // hls.js recovers from non-fatal errors on its own.
        if (!data?.fatal) return;
        const action = nextHlsRecovery(recovery, hlsErrorKind(data.type));
        console.error('[useHlsVideo] fatal hls.js error', data.type, data.details, '->', action);
        try {
          if (action === 'startLoad') instance.startLoad();
          else if (action === 'recoverMedia') instance.recoverMediaError();
          else if (action === 'swapAudioAndRecover') {
            instance.swapAudioCodec();
            instance.recoverMediaError();
          } else {
            instance.destroy();
            if (hlsRef.current === instance) hlsRef.current = null;
            if (!cancelled) setFailed(true);
          }
        } catch {
          if (!cancelled) setFailed(true);
        }
      });
      instance.loadSource(url);
      instance.attachMedia(video);
      if (loadRef.current) instance.startLoad();
    };
    attach();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      hls?.destroy();
      if (hlsRef.current === hls) hlsRef.current = null;
    };
  }, [url, useHlsJs]);

  // Start / stop segment loading with `load` (feed visibility).
  useEffect(() => {
    const hls = hlsRef.current;
    if (!hls) return;
    try {
      if (load) hls.startLoad();
      else hls.stopLoad();
    } catch {
      /* destroyed */
    }
  }, [load]);

  return {
    hostRef,
    // null => hls.js owns the media (see the note above).
    // A bare HLS url => Safari's native HLS.
    // Anything else (a legacy R2 mp4) => the normal source path.
    playerSource: useHlsJs ? null : isHls ? (url as string) : videoSourceFor(url),
    failed,
  };
}
