import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { contestService } from '@/src/services/contests/contestService';
import { resolveBattleShareAsset, type BattleShareAsset } from '@/src/lib/vsShareAsset';
import { videoThumbnailFromUrl } from '@/src/lib/videoSource';
import { renderVsCardBlob, vsCardInputFromMatch } from '@/src/lib/webVsCard';

const POLL_MS = 3000;
const MAX_POLLS = 10;

/**
 * Web only: draw the VS card in the browser (src/lib/webVsCard.ts) from the
 * battle's two entries. Used by the resolver ONLY when the server card is late
 * or its renderer failed — never to work around a refusal.
 */
export async function drawWebVsCard(matchId: string): Promise<string | null> {
  if (Platform.OS !== 'web' || typeof URL === 'undefined') return null;
  try {
    const match: any = await contestService.getMatchById(matchId);
    if (!match || (match.id && match.id !== matchId) || match.moderationHeld) return null;
    const input = vsCardInputFromMatch(match, videoThumbnailFromUrl);
    if (!input) return null;
    return URL.createObjectURL(await renderVsCardBlob(input));
  } catch (e) {
    console.warn('[share] web VS card fallback failed', e);
    return null;
  }
}

/**
 * Resolve a battle's canonical share image while a share surface is open.
 *
 * - Keyed by `matchId`: state is cleared the moment the match changes, and a
 *   late answer for a previous match is discarded, so one battle's image can
 *   never be offered for another.
 * - Polls (bounded) while the server reports `preparing`.
 * - On web, a server card that is late or failing is replaced by a card drawn in
 *   the browser, so the sheet never waits forever.
 * - `retry()` re-resolves on demand; it only ever reads.
 */
export function useBattleShareAsset(matchId: string, active: boolean) {
  const [asset, setAsset] = useState<BattleShareAsset | null>(null);
  const [loading, setLoading] = useState(false);
  const current = useRef(matchId);
  current.current = matchId;
  const polls = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolve = useCallback(async () => {
    const target = matchId;
    if (!target) return;
    setLoading(true);
    try {
      const next = await resolveBattleShareAsset(target, {
        fetchShareImage: contestService.getMatchShareImage,
        capture: Platform.OS === 'web' ? () => drawWebVsCard(target) : undefined,
        // A DRAWN card uses the poster still, so video battles qualify too.
        captureVideo: Platform.OS === 'web',
      });
      if (current.current === target) setAsset(next);
      else if (next.status === 'ready' && next.source.kind === 'local') URL.revokeObjectURL(next.source.uri);
    } finally {
      if (current.current === target) setLoading(false);
    }
  }, [matchId]);

  // Free a browser-drawn card when it is replaced or the surface closes.
  const localUri = asset?.status === 'ready' && asset.source.kind === 'local' ? asset.source.uri : null;
  useEffect(
    () => () => {
      if (localUri && localUri.startsWith('blob:')) URL.revokeObjectURL(localUri);
    },
    [localUri],
  );

  // New match or reopened sheet: forget everything about the previous one.
  useEffect(() => {
    setAsset(null);
    polls.current = 0;
    if (active && matchId) void resolve();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, matchId, resolve]);

  useEffect(() => {
    if (!active || loading || asset?.status !== 'preparing' || asset.matchId !== matchId) return;
    if (polls.current >= MAX_POLLS) return;
    timer.current = setTimeout(() => {
      polls.current += 1;
      void resolve();
    }, POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, loading, asset, matchId, resolve]);

  const retry = useCallback(() => {
    polls.current = 0;
    void resolve();
  }, [resolve]);

  // Never hand back an asset that belongs to a different match.
  const safe = asset && asset.matchId === matchId ? asset : null;
  return { asset: safe, loading: loading || (active && !safe), retry };
}
