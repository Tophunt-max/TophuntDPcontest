import { useCallback, useRef } from 'react';
import { captureVsCard, releaseVsCard } from '@/src/lib/vsImage';

/**
 * Capture support for a battle story's on-screen `StoryVsFrame`.
 *
 * The canonical VS image is rendered by the SERVER and is what both Stories and
 * every share path use (src/lib/vsShareAsset.ts). A capture of the on-screen
 * frame is only a FALLBACK for when that image cannot be obtained, and it is
 * taken only when it is known to be right:
 *
 *   - the frame has fired `onCaptureReady` for THIS battle — both entry photos
 *     have decoded and no composite is being shown. Never on a timer, which can
 *     catch half-decoded images.
 *   - never for a video battle: StoryVsFrame does not fire the signal for video,
 *     because a VideoView screenshots as black.
 *
 * The device never uploads or records anything.
 */
export function useVsStoryCard(opts: {
  /** The battle currently on screen, or null/undefined if this is not a battle story. */
  matchId?: string | null;
  /** Retained for call-site compatibility. */
  canGenerate: boolean;
  /** Pauses the story timer while a share sheet is covering the screen. */
  setPaused: (paused: boolean) => void;
}) {
  const { matchId } = opts;

  /** Attached to the capture boundary that wraps the battle frame. */
  const shotRef = useRef<any>(null);
  const matchIdRef = useRef(matchId);
  matchIdRef.current = matchId;
  /** The battle whose frame most recently reported itself fully painted. */
  const readyFor = useRef<string | null>(null);
  // Forget readiness the moment the battle on screen changes — during render, so
  // it happens before the newly mounted frame can report anything. Coming back
  // to the same battle later must wait for THAT mount's photos to decode again.
  const lastMatch = useRef(matchId);
  if (lastMatch.current !== matchId) {
    lastMatch.current = matchId;
    readyFor.current = null;
  }

  const onCaptureReady = useCallback(() => {
    readyFor.current = matchIdRef.current ?? null;
  }, []);

  /**
   * A local capture of the frame, or null unless the frame is verified ready for
   * `target` (and is still the one on screen before and after the snapshot).
   */
  const captureIfReady = useCallback(async (target: string): Promise<string | null> => {
    if (!target || readyFor.current !== target || matchIdRef.current !== target) return null;
    const uri = await captureVsCard(shotRef.current);
    if (uri && matchIdRef.current !== target) {
      // The story advanced mid-capture: this is someone else's frame.
      releaseVsCard(uri);
      return null;
    }
    return uri;
  }, []);

  return { shotRef, onCaptureReady, captureIfReady, releaseCapture: releaseVsCard };
}
