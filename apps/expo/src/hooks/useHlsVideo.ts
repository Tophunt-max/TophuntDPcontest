import type { VideoSource } from 'expo-video';

import { videoSourceFor } from '@/src/lib/videoSource';

/**
 * Make a Bunny HLS stream playable on the current platform.
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
}

export function useHlsVideo(url?: string | null): HlsVideoBinding {
  return { hostRef: undefined, playerSource: videoSourceFor(url) };
}
