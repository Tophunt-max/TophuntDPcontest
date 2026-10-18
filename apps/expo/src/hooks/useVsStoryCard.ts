import { useCallback, useRef } from 'react';
import { captureVsCard, releaseVsCard, shareVsCard } from '@/src/lib/vsImage';

/**
 * Share support for a battle story.
 *
 * The battle's VS card is rendered by the SERVER from both accepted entries once
 * the battle fills (Worker `lib/vsPublication.ts`), and both participants' Stories
 * display that one image. This hook therefore no longer captures-and-uploads in the
 * background — the client used to be the card's author, which let one participant
 * put any picture on the other's story. What remains is the on-demand capture used
 * to attach a local file to the OS share sheet.
 *
 * `onCaptureReady` is kept as a stable no-op so existing call sites (the frame's
 * "painted" signal) keep compiling and nothing is recorded from the device.
 */
export function useVsStoryCard(opts: {
  /** The battle currently on screen, or null/undefined if this is not a battle story. */
  matchId?: string | null;
  /** Retained for call-site compatibility; the device never records a card now. */
  canGenerate: boolean;
  /** Pauses the story timer while a share sheet is covering the screen. */
  setPaused: (paused: boolean) => void;
}) {
  const { setPaused } = opts;

  /** Attached to the capture boundary that wraps the battle frame. */
  const shotRef = useRef<any>(null);
  const setPausedRef = useRef(setPaused);
  setPausedRef.current = setPaused;

  const onCaptureReady = useCallback(() => {
    /* intentionally empty: the server owns the VS card */
  }, []);

  /**
   * Share the story. Sends the battle as an image when that is possible on this
   * device, and otherwise runs the caller's existing text share. Never uploads.
   */
  const shareCard = useCallback(async (fallbackShare: () => Promise<void> | void) => {
    setPausedRef.current(true);
    let localUri: string | null = null;
    try {
      // Null for a non-battle story (no boundary is mounted) and on any platform
      // without the native module; `shareVsCard` then falls back to text.
      localUri = await captureVsCard(shotRef.current);
      await shareVsCard({ imageUri: localUri, fallbackShare });
    } finally {
      // After the share sheet has taken what it needs — releasing earlier would
      // pull the file out from under it.
      releaseVsCard(localUri);
      setPausedRef.current(false);
    }
  }, []);

  return { shotRef, onCaptureReady, shareCard };
}
