import { useQuery } from '@tanstack/react-query';

import { callApi } from '@/src/services/api';
import { bunnyGuidFromUrl, bunnyThumbnailFromUrl } from '@/src/lib/videoSource';

/**
 * Resolve whether a Bunny video has finished encoding.
 *
 * New UI state introduced by the migration: with R2 a video was playable the
 * instant the upload finished, but Bunny needs roughly 10-60s of encoding first.
 * Callers use `isProcessing` to show the poster frame with a "Processing…"
 * overlay instead of a player that would just error.
 *
 * Deliberately client-driven: rather than joining the `videos` table into all
 * six read endpoints, the client asks only about the videos it actually sees, and
 * only until they are ready.
 */

export type VideoStatus = 'uploading' | 'processing' | 'ready' | 'failed';

interface VideoStatusRow {
  id: string;
  status: VideoStatus;
  thumbnailUrl: string | null;
  durationSec: number | null;
  playbackUrl: string | null;
  mp4Url: string | null;
}

export interface UseVideoStatusResult {
  /** Null for non-Bunny (R2) media, which is always immediately playable. */
  status: VideoStatus | null;
  isProcessing: boolean;
  isFailed: boolean;
  thumbnailUrl: string | null;
  durationSec: number | null;
  /**
   * The progressive MP4 the Worker resolved from Bunny's real
   * `availableResolutions` — the url web playback should use, instead of guessing
   * `play_720p.mp4` (which 404s whenever that rendition was never encoded). Null
   * when the library has MP4 Fallback off, or for non-Bunny media.
   */
  mp4Url: string | null;
}

const isTerminal = (status: string | null | undefined) => status === 'ready' || status === 'failed';

/**
 * How long until the next encode-status check, or false to stop.
 *
 * It polled every 5 s forever while the status was not terminal, per mounted
 * card, and forever when the server had no row at all (`null`), which is
 * never going to change. Now: 5 s for the first minute (a normal Bunny
 * encode), then backing off to a minute, and stopping after about 30 minutes.
 * No row: stop after three answers. A remount (or the next screen) asks again.
 */
export function videoStatusPollMs(status: string | null, answers: number): number | false {
  if (isTerminal(status)) return false;
  if (status === null && answers >= 3) return false;
  if (answers < 12) return 5_000;
  if (answers > 50) return false;
  return Math.min(60_000, 5_000 * 2 ** Math.floor((answers - 12) / 4));
}

export function useVideoStatus(mediaUrl?: string | null): UseVideoStatusResult {
  const guid = bunnyGuidFromUrl(mediaUrl);

  const { data } = useQuery({
    queryKey: ['videoStatus', guid],
    queryFn: async () => {
      const res = (await callApi('videoStatus', { videoIds: [guid] })) as {
        videos?: VideoStatusRow[];
      };
      return res?.videos?.[0] ?? null;
    },
    enabled: !!guid,
    refetchInterval: (query) =>
      videoStatusPollMs((query.state.data as VideoStatusRow | null | undefined)?.status ?? null, query.state.dataUpdateCount),
    // A terminal answer never changes: no refetch on every remount of a card.
    staleTime: (query) => (isTerminal((query.state.data as VideoStatusRow | null | undefined)?.status) ? Infinity : 5000),
  });

  // No guid => an R2 video (or a photo). Report "not processing" so existing
  // media renders exactly as before.
  if (!guid) {
    return {
      status: null,
      isProcessing: false,
      isFailed: false,
      thumbnailUrl: null,
      durationSec: null,
      mp4Url: null,
    };
  }

  const status = data?.status ?? null;
  return {
    status,
    // Treat "unknown yet" as processing: showing a poster briefly is better than
    // mounting a player against a playlist that does not exist yet.
    isProcessing: status === 'uploading' || status === 'processing',
    isFailed: status === 'failed',
    thumbnailUrl: data?.thumbnailUrl || bunnyThumbnailFromUrl(mediaUrl),
    durationSec: data?.durationSec ?? null,
    mp4Url: data?.mp4Url ?? null,
  };
}
