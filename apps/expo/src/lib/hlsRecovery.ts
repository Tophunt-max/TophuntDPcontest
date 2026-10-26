/**
 * What to do about a FATAL hls.js error (web).
 *
 * The hook only logged fatal errors. With Media Source Extensions a fatal
 * network or manifest error does not fire the `<video>` element's `error`, so
 * the player never left "loading": the feed showed a black tile and the story
 * viewer a spinner. hls.js documents the recovery: restart loading for network
 * errors, `recoverMediaError()` for media errors, and once more after
 * `swapAudioCodec()` if that fails. Each is tried a bounded number of times;
 * after that the video is reported as failed so the UI can say so and move on.
 */

export type HlsErrorKind = 'networkError' | 'mediaError' | 'other';
export type HlsRecoveryAction = 'startLoad' | 'recoverMedia' | 'swapAudioAndRecover' | 'fail';

export interface HlsRecoveryState {
  network: number;
  media: number;
}

export const MAX_NETWORK_RECOVERIES = 2;

export function initialHlsRecovery(): HlsRecoveryState {
  return { network: 0, media: 0 };
}

/** Decide, and count the attempt. Mutates `state`. */
export function nextHlsRecovery(state: HlsRecoveryState, kind: HlsErrorKind): HlsRecoveryAction {
  if (kind === 'networkError') {
    if (state.network >= MAX_NETWORK_RECOVERIES) return 'fail';
    state.network++;
    return 'startLoad';
  }
  if (kind === 'mediaError') {
    state.media++;
    if (state.media === 1) return 'recoverMedia';
    if (state.media === 2) return 'swapAudioAndRecover';
    return 'fail';
  }
  return 'fail';
}

/** Map hls.js `ErrorTypes` strings onto the three cases. */
export function hlsErrorKind(type: unknown): HlsErrorKind {
  if (type === 'networkError') return 'networkError';
  if (type === 'mediaError') return 'mediaError';
  return 'other';
}
