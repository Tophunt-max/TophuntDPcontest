import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  captureVsCard,
  isVsCaptureSupported,
  releaseVsCard,
  shareVsCard,
  uploadAndRecordVsCard,
} from '@/src/lib/vsImage';
import { shouldCaptureVsCard } from '@/src/lib/vsStory';

/**
 * Turns the battle frame the user is currently looking at into a real image file:
 * once, in the background, so both participants' stories become that one image —
 * and on demand, so the share sheet can send a picture instead of a link.
 *
 * ---------------------------------------------------------------------------
 * Why the capture happens here, while someone is watching
 * ---------------------------------------------------------------------------
 * The card cannot be composed on the server (see
 * `apps/worker/migrations/0033_match_vs_image.sql`), and it cannot be composed
 * off-screen either: `captureRef` copies *painted pixels*, so an off-screen host
 * would have to prefetch both entries and then guess when they had decoded. A
 * frame that is on screen is painted by definition, so the story viewer is the
 * one place the capture is reliable — and the person who most wants the card to
 * exist is a participant looking at their own new battle.
 *
 * ---------------------------------------------------------------------------
 * The rules that keep a bad card from becoming permanent
 * ---------------------------------------------------------------------------
 * The server keeps the FIRST card recorded for a battle. That makes a mistake here
 * permanent for both users until the stories expire, so generation is gated:
 *
 *   1. only when the frame reports itself painted (`onCaptureReady`), never on a
 *      timer — a timer catches half-decoded images and bakes in a grey rectangle
 *      where someone's entry should be;
 *   2. only for the user's own story, so the uploader is always a participant;
 *   3. only if the battle is still the one that asked — checked BOTH before the
 *      snapshot and again after it resolves. `shotRef` is one ref shared by every
 *      story in the reel, so a story advance at the wrong moment would otherwise
 *      record a stranger's photo as this battle's card.
 *
 * Rule 3 is why the "attempted" bookkeeping only counts attempts that actually
 * reached the capture. An abort is not a failure, and burning the battle's single
 * chance on one would mean a slow connection never produces a card at all.
 */

/** Time between "the images have decoded" and the pixels being on the glass. */
const SETTLE_MS = 450;

export function useVsStoryCard(opts: {
  /** The battle currently on screen, or null/undefined if this is not a battle story. */
  matchId?: string | null;
  /**
   * Whether this client may generate the card — true only when the story belongs
   * to the signed-in user, who is therefore one of the two participants.
   */
  canGenerate: boolean;
  /** Pauses the story timer while a share sheet is covering the screen. */
  setPaused: (paused: boolean) => void;
}) {
  const { matchId, canGenerate, setPaused } = opts;
  const queryClient = useQueryClient();

  /** Attached to the capture boundary that wraps the battle frame. */
  const shotRef = useRef<any>(null);

  // Read through refs so the callbacks handed to child components stay stable
  // across every story change; otherwise `onCaptureReady` would be a new function
  // on each render, and the frame's fire-once guard would be the only thing
  // between us and a capture per re-render.
  const matchIdRef = useRef(matchId);
  matchIdRef.current = matchId;
  const canGenerateRef = useRef(canGenerate);
  canGenerateRef.current = canGenerate;
  const setPausedRef = useRef(setPaused);
  setPausedRef.current = setPaused;

  /** Battles this screen has captured, so a re-render is not a re-upload. */
  const attempted = useRef<Set<string>>(new Set());
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    [],
  );

  const onCaptureReady = useCallback(() => {
    const target = matchIdRef.current;
    if (
      !shouldCaptureVsCard({
        matchId: target,
        canGenerate: canGenerateRef.current,
        captureSupported: isVsCaptureSupported(),
        attempted: attempted.current,
      })
    ) {
      return;
    }

    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      // The story may have advanced during the settle delay, in which case
      // `shotRef` now points at a different frame entirely.
      if (matchIdRef.current !== target) return;
      // Only now is this battle spent. Marking it at the ready signal instead
      // would mean a connection slow enough to decode past the 5s story duration
      // aborts here and never gets a second chance.
      attempted.current.add(target!);

      void (async () => {
        const localUri = await captureVsCard(shotRef.current);
        if (!localUri) return;
        // Re-checked AFTER the snapshot too: the native capture is async, and a
        // story advance in that window would have photographed the next frame.
        // Recording that would put a stranger's picture on both participants'
        // stories, which is the one outcome worth this much ceremony.
        if (matchIdRef.current !== target) {
          releaseVsCard(localUri);
          return;
        }
        const recorded = await uploadAndRecordVsCard(localUri, target!);
        releaseVsCard(localUri);
        if (!recorded) return;
        // Update the cached match so re-opening the viewer inside the query's
        // stale window does not capture and upload all over again, only for the
        // server to discard it. Deliberately `setQueryData` rather than
        // `invalidateQueries`: the frame on screen is already these exact pixels,
        // so a refetch would be a network round trip to change nothing.
        queryClient.setQueryData(['match', target], (prev: any) =>
          prev ? { ...prev, vsImageUrl: recorded } : prev,
        );
      })();
    }, SETTLE_MS);
  }, [queryClient]);

  /**
   * Share the story. Sends the battle as an image when that is possible on this
   * device, and otherwise runs the caller's existing text share.
   *
   * Note this never uploads. The card is only ever recorded by the background path
   * above, because a share tap can happen any number of times and the server keeps
   * only the first card — every later upload would cost a round trip to produce an
   * object the server immediately deletes.
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
