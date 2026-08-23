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
    // Keep polling only while the encode is outstanding. Once ready or failed the
    // answer is terminal, so stop.
    refetchInterval: (query) => {
      const status = (query.state.data as VideoStatusRow | null)?.status;
      if (!status) return 5000;
      return status === 'ready' || status === 'failed' ? false : 5000;
    },
    staleTime: 5000,
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
  };
}
