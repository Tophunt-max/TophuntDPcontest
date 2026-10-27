import type { VideoSource } from 'expo-video';

import { videoSourceFor } from '@/src/lib/videoSource';

/**
 * Make an HLS stream (an encoded video) playable on the current platform.
 *
 * NATIVE implementation — a no-op passthrough. iOS (AVPlayer) and Android
 * (ExoPlayer) both play HLS natively, which is where adaptive bitrate comes
 * from, so the playlist URL is handed straight to expo-video exactly as before.
 *
 * The web build gets `useHlsVideo.web.ts`, which is where the real work is; see
 * that file for why it exists at all.
 */
export interface HlsVideoBinding {
  /**
   * Attach to the View WRAPPING `<VideoView>`. Web-only (hls.js needs the DOM
   * `<video>` element); always undefined on native.
   */
  hostRef?: any;
  /** The source to give `useVideoPlayer`. */
  playerSource: VideoSource;
  /**
   * Web only: hls.js gave up after its bounded recovery
   * (src/lib/hlsRecovery.ts). The caller should show its "could not be played"
   * state. Always false on native, where the player's own `error` status says so.
   */
  failed: boolean;
}

export interface HlsVideoOptions {
  /**
   * Web only: whether to download segments now. A feed card that is mounted
   * but off screen passes false, so it does not buffer a video nobody sees.
   * Default true.
   */
  load?: boolean;
}

export function useHlsVideo(url?: string | null, _options: HlsVideoOptions = {}): HlsVideoBinding {
  return { hostRef: undefined, playerSource: videoSourceFor(url), failed: false };
}
